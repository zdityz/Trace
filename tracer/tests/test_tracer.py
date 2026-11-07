import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

TRACER = Path(__file__).resolve().parents[1] / "tracer.py"
_spec = importlib.util.spec_from_file_location("trace_tracer_under_test", TRACER)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Could not load tracer module from {TRACER}")
_tracer_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tracer_module)


def primitive_value(encoded):
    if encoded["kind"] == "primitive":
        return encoded["value"]
    raise AssertionError(f"Expected primitive, got {encoded}")


def apply_patch(previous, patch):
    if not isinstance(patch, dict) or patch.get("$trace_patch") != 1:
        return patch
    node = dict(previous or {})
    for key in patch.get("remove", []):
        node.pop(key, None)
    node.update(patch.get("set", {}))
    for field, operation in patch.get("arrays", {}).items():
        values = list(node.get(field, []))
        values = values[: operation["length"]]
        values.extend([None] * max(0, operation["length"] - len(values)))
        for index, value in operation.get("set", {}).items():
            values[int(index)] = value
        node[field] = values
    for field, operation in patch.get("maps", {}).items():
        values = dict(node.get(field, {}))
        for key in operation.get("remove", []):
            values.pop(key, None)
        values.update(operation.get("set", {}))
        node[field] = values
    return node


def resolved_state(trace, index=-1):
    events = trace["events"]
    target = index if index >= 0 else len(events) - 1
    objects = {}
    state = {"frames": [], "objects": {}}
    for event in events[: target + 1]:
        current = event["state"]
        if current.get("object_checkpoint") is True:
            objects = dict(current.get("objects", {}))
        elif "object_delta" in current:
            objects = dict(objects)
            delta = current["object_delta"]
            for object_id in delta.get("removed", []):
                objects.pop(object_id, None)
            for object_id, value in delta.get("upserts", {}).items():
                objects[object_id] = apply_patch(objects.get(object_id), value)
        else:
            objects = dict(current.get("objects", {}))
        state = {"frames": current.get("frames", []), "objects": objects}
    return state


class TracerIntegrationTests(unittest.TestCase):
    def run_script(
        self, source: str, stdin: str | None = None,
        max_events: int = 20_000, max_bytes: int = 16 * 1024 * 1024,
        timeout: int = 30,
    ):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script = root / "sample.py"
            output = root / "trace.json"
            script.write_text(source, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(TRACER), str(script), "--output", str(output),
                 "--max-events", str(max_events), "--max-bytes", str(max_bytes)],
                capture_output=True,
                text=True,
                input=stdin if stdin is not None else "",
                timeout=timeout,
            )
            self.assertTrue(output.exists(), msg=f"Tracer did not write output. stderr: {result.stderr}")
            document = json.loads(output.read_text(encoding="utf-8"))
            return result, document


    def test_stdout_capture_is_bounded_and_program_continues(self):
        source = (
            "print('x' * 1000100)\n"
            "after_output = 'execution continued'\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(trace["metadata"]["stdout_truncated"])
        self.assertEqual(len(trace["stdout"]), _tracer_module.MAX_CAPTURED_OUTPUT_CHARS)
        final_locals = trace["events"][-1]["state"]["frames"][-1]["locals"]
        self.assertEqual(primitive_value(final_locals["after_output"]), "execution continued")

    def test_stderr_capture_is_bounded_and_program_continues(self):
        source = (
            "import sys\n"
            "print('e' * 1000100, file=sys.stderr)\n"
            "after_error_output = True\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(trace["metadata"]["stderr_truncated"])
        self.assertEqual(len(trace["stderr"]), _tracer_module.MAX_CAPTURED_OUTPUT_CHARS)
        self.assertFalse(trace["metadata"]["stdout_truncated"])

    def test_captures_lines_and_variable_values(self):
        source = "values = [1, 2]\ntotal = 0\nfor value in values:\n    total += value\n"
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreater(trace["metadata"]["event_count"], 0)
        self.assertEqual(trace["metadata"]["exit_code"], 0)

        # A line event is a pre-execution boundary. At each subsequent loop
        # header, total reflects the previous iteration's completed update.
        loop_headers = [
            event for event in trace["events"]
            if event.get("source", {}).get("line") == 3
            and event.get("event") == "line_executed"
        ]
        totals = [
            primitive_value(event["state"]["frames"][-1]["locals"]["total"])
            for event in loop_headers
        ]
        self.assertEqual(totals, [0, 1, 3])

    def test_captures_user_function_calls_and_returns(self):
        source = "def add(a, b):\n    return a + b\nanswer = add(2, 3)\n"
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        add_events = [event for event in trace["events"] if event.get("function") == "add"]
        self.assertIn("function_called", {event["event"] for event in add_events})
        self.assertIn("function_returned", {event["event"] for event in add_events})

    def test_records_program_exception(self):
        result, trace = self.run_script("value = 1 / 0\n")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(trace["metadata"]["program_error"]["type"], "ZeroDivisionError")
        self.assertIn("exception_raised", {event["event"] for event in trace["events"]})

    def test_runtime_error_links_to_failure_event_and_preserves_state(self):
        source = (
            "numbers = [10, 20, 30]\n"
            "index = 3\n"
            "print(numbers[index])\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 1)

        error = trace["metadata"]["program_error"]
        self.assertEqual(error["kind"], "runtime")
        self.assertEqual(error["state_kind"], "failure")
        self.assertEqual(error["type"], "IndexError")
        self.assertEqual(error["location"]["line"], 3)
        self.assertIn("print(numbers[index])", error["location"]["source_text"])

        failure_sequence = error["event_sequence"]
        self.assertIsInstance(failure_sequence, int)
        failure_event = trace["events"][failure_sequence]
        self.assertEqual(failure_event["event"], "exception_raised")
        self.assertEqual(failure_event["source"]["line"], 3)
        locals_map = failure_event["state"]["frames"][-1]["locals"]
        self.assertEqual(primitive_value(locals_map["index"]), 3)
        self.assertEqual(locals_map["numbers"]["kind"], "ref")

    def test_syntax_error_creates_failure_event_without_fake_runtime_state(self):
        source = "if True:\nprint('not indented')\n"
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 1)

        error = trace["metadata"]["program_error"]
        self.assertEqual(error["kind"], "syntax")
        self.assertEqual(error["state_kind"], "none")
        self.assertIn(error["type"], {"IndentationError", "SyntaxError"})
        self.assertEqual(error["location"]["line"], 2)
        self.assertEqual(error["event_sequence"], 0)
        self.assertEqual(len(trace["events"]), 1)
        failure_event = trace["events"][0]
        self.assertEqual(failure_event["event"], "execution_error")
        self.assertEqual(failure_event["state"], {"frames": [], "objects": {}})

    def test_caught_exception_is_not_reported_as_program_failure(self):
        source = (
            "try:\n"
            "    value = 1 / 0\n"
            "except ZeroDivisionError:\n"
            "    value = 0\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(trace["metadata"]["program_error"])
        self.assertIn("exception_raised", {event["event"] for event in trace["events"]})

    def test_serializes_mutated_lists_and_cycles(self):
        source = "items = [1]\nalias = items\nitems.append(2)\nitems.append(items)\n"
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)

        final_state = resolved_state(trace)
        locals_map = final_state["frames"][-1]["locals"]
        items_ref = locals_map["items"]["id"]
        alias_ref = locals_map["alias"]["id"]
        self.assertEqual(items_ref, alias_ref)
        list_node = final_state["objects"][items_ref]
        self.assertEqual(list_node["type"], "list")
        self.assertEqual(len(list_node["items"]), 3)
        self.assertEqual(list_node["items"][-1], {"kind": "ref", "id": items_ref})

    def test_captures_active_list_indexes_for_reads_and_tuple_swaps(self):
        source = (
            "arr = [5, 3, 8]\n"
            "j = 0\n"
            "if arr[j] > arr[j + 1]:\n"
            "    arr[j], arr[j + 1] = arr[j + 1], arr[j]\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)

        read_event = next(
            event for event in trace["events"]
            if event.get("source", {}).get("line") == 3
            and event.get("event") == "line_executed"
        )
        read_accesses = read_event.get("array_accesses", [])
        self.assertEqual(
            [(item["array_name"], item["index"], item["kind"]) for item in read_accesses],
            [("arr", 0, "read"), ("arr", 1, "read")],
        )

        swap_event = next(
            event for event in trace["events"]
            if event.get("source", {}).get("line") == 4
            and event.get("event") == "line_executed"
        )
        swap_accesses = swap_event.get("array_accesses", [])
        self.assertEqual(
            [(item["index"], item["kind"]) for item in swap_accesses],
            [(0, "read_write"), (1, "read_write")],
        )

    def test_resolves_arithmetic_and_negative_list_indexes(self):
        source = (
            "values = [7, 4, 9]\n"
            "i = 0\n"
            "first = values[i + 1]\n"
            "last = values[-1]\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)

        arithmetic_event = next(
            event for event in trace["events"]
            if event.get("source", {}).get("line") == 3
            and event.get("event") == "line_executed"
        )
        negative_event = next(
            event for event in trace["events"]
            if event.get("source", {}).get("line") == 4
            and event.get("event") == "line_executed"
        )
        self.assertEqual(arithmetic_event["array_accesses"][0]["index"], 1)
        self.assertEqual(negative_event["array_accesses"][0]["index"], 2)

    def test_captures_global_list_access_inside_a_function(self):
        source = (
            "arr = [11, 22, 33]\n"
            "def read_item(index):\n"
            "    return arr[index]\n"
            "answer = read_item(1)\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        access_event = next(
            event for event in trace["events"]
            if event.get("source", {}).get("line") == 3
            and event.get("event") == "line_executed"
        )
        self.assertEqual(access_event["array_accesses"][0]["array_name"], "arr")
        self.assertEqual(access_event["array_accesses"][0]["index"], 1)
        self.assertEqual(access_event["array_accesses"][0]["kind"], "read")

    def test_skips_nested_subscripts_instead_of_partial_highlighting(self):
        source = (
            "matrix = [[1, 2], [3, 4]]\n"
            "row = 1\n"
            "column = 0\n"
            "value = matrix[row][column]\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        access_event = next(
            event for event in trace["events"]
            if event.get("source", {}).get("line") == 4
            and event.get("event") == "line_executed"
        )
        self.assertNotIn("array_accesses", access_event)

    def test_serializes_user_defined_objects_and_preserves_tree_links(self):
        source = (
            "class Node:\n"
            "    def __init__(self, value, left=None, right=None):\n"
            "        self.value = value\n"
            "        self.left = left\n"
            "        self.right = right\n"
            "root = Node(10, Node(5), Node(15))\n"
            "print(root.value)\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        final_state = resolved_state(trace)
        locals_map = final_state["frames"][-1]["locals"]
        root_id = locals_map["root"]["id"]
        root_node = final_state["objects"][root_id]
        self.assertEqual(root_node["type"], "instance")
        self.assertEqual(root_node["class_name"], "Node")
        self.assertEqual(primitive_value(root_node["attributes"]["value"]), 10)
        self.assertEqual(final_state["objects"][root_node["attributes"]["left"]["id"]]["class_name"], "Node")
        self.assertEqual(final_state["objects"][root_node["attributes"]["right"]["id"]]["class_name"], "Node")

    def test_serializes_linked_object_cycles_without_recursion_failure(self):
        source = (
            "class Node:\n"
            "    def __init__(self, value):\n"
            "        self.value = value\n"
            "        self.next = None\n"
            "first = Node(1)\n"
            "second = Node(2)\n"
            "first.next = second\n"
            "second.next = first\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        final_state = resolved_state(trace)
        locals_map = final_state["frames"][-1]["locals"]
        first_id = locals_map["first"]["id"]
        second_id = locals_map["second"]["id"]
        first_node = final_state["objects"][first_id]
        second_node = final_state["objects"][second_id]
        self.assertEqual(first_node["attributes"]["next"]["id"], second_id)
        self.assertEqual(second_node["attributes"]["next"]["id"], first_id)

    def test_if_else_is_recorded_as_normal_line_execution_without_branch_analysis(self):
        source = (
            "score = 80\n"
            "if score >= 40:\n"
            "    result = 'passed'\n"
            "else:\n"
            "    result = 'failed'\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("branch_outcome", {event["event"] for event in trace["events"]})
        self.assertIn(2, [event.get("source", {}).get("line") for event in trace["events"]])
        self.assertEqual(trace["metadata"]["exit_code"], 0)

    def test_captures_stdout(self):
        result, trace = self.run_script("print('hello from trace')\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["stdout"], "hello from trace\n")

    def test_program_can_read_standard_input_from_tracer_process(self):
        source = "name = input()\ncount = int(input())\nprint(f'{name}:{count}')\n"
        result, trace = self.run_script(source, stdin="items\n3\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["stdout"], "items:3\n")

    def test_direct_os_write_is_included_in_console_output(self):
        source = (
            "import os\n"
            "os.write(1, b'direct stdout\\n')\n"
            "os.write(2, b'direct stderr\\n')\n"
            "print('python stdout')\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("direct stdout\n", trace["stdout"])
        self.assertIn("python stdout\n", trace["stdout"])
        self.assertIn("direct stderr\n", trace["stderr"])

    def test_project_local_virtual_environment_is_excluded_from_trace(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            site_packages = root / ".venv" / "lib" / "python3.13" / "site-packages"
            site_packages.mkdir(parents=True)
            (site_packages / "third_party.py").write_text(
                "def run_dependency():\n    dependency_value = 123\n    return dependency_value\n",
                encoding="utf-8",
            )
            script = root / "main.py"
            output = root / "trace.json"
            script.write_text(
                f"import sys\nsys.path.insert(0, {str(site_packages)!r})\n"
                "import third_party\nresult = third_party.run_dependency()\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, str(TRACER), str(script), "--output", str(output)],
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            trace = json.loads(output.read_text(encoding="utf-8"))
            source_files = {event.get("source", {}).get("file", "") for event in trace["events"]}
            self.assertTrue(source_files)
            self.assertEqual(source_files, {str(script.resolve())})

    def test_new_threads_are_traced_with_thread_metadata(self):
        source = (
            "import threading\n"
            "def worker():\n"
            "    thread_value = 10\n"
            "    thread_value += 5\n"
            "thread = threading.Thread(target=worker, name='TraceWorker')\n"
            "thread.start()\n"
            "thread.join()\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        worker_events = [event for event in trace["events"] if event.get("thread_name") == "TraceWorker"]
        self.assertTrue(worker_events, "the worker thread's user-code events should be traced")
        self.assertTrue(any(event.get("function") == "worker" for event in worker_events))
        worker_frames = [
            frame
            for event in worker_events
            for frame in event.get("state", {}).get("frames", [])
            if frame.get("function") == "worker"
        ]
        self.assertTrue(worker_frames)
        self.assertTrue(all(frame.get("thread_name") == "TraceWorker" for frame in worker_frames))

    def test_generator_scope_id_survives_each_resume(self):
        source = (
            "def values():\n"
            "    item = 1\n"
            "    yield item\n"
            "    item = 2\n"
            "    yield item\n"
            "iterator = values()\n"
            "first = next(iterator)\n"
            "second = next(iterator)\n"
            "try:\n"
            "    next(iterator)\n"
            "except StopIteration:\n"
            "    pass\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        yielded = [event for event in trace["events"] if event.get("event") == "function_suspended" and event.get("function") == "values"]
        self.assertEqual(len(yielded), 2)
        self.assertEqual(yielded[0]["scope_id"], yielded[1]["scope_id"])

    def test_line_state_timing_is_explicit_in_trace_metadata(self):
        result, trace = self.run_script("answer = 42\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["metadata"]["line_state_timing"], "before_execution")

    def test_sys_exit_zero_is_success(self):
        result, trace = self.run_script("import sys\nsys.exit(0)\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["metadata"]["exit_code"], 0)
        self.assertIsNone(trace["metadata"]["program_error"])

    def test_sys_exit_none_is_success(self):
        result, trace = self.run_script("import sys\nsys.exit()\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["metadata"]["exit_code"], 0)
        self.assertIsNone(trace["metadata"]["program_error"])

    def test_sys_exit_nonzero_remains_a_failure(self):
        result, trace = self.run_script("import sys\nsys.exit(2)\n")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(trace["metadata"]["exit_code"], 1)
        self.assertEqual(trace["metadata"]["program_error"]["type"], "SystemExit")

    def test_mutable_object_states_use_index_deltas_not_full_snapshots(self):
        source = (
            "values = list(range(200))\n"
            "for index in range(200):\n"
            "    values[index] = values[index] + 1\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["metadata"]["object_encoding"], "delta-v1")
        delta_events = [
            event for event in trace["events"]
            if event["state"].get("object_delta", {}).get("upserts")
        ]
        self.assertTrue(delta_events)
        some_patch = next(
            patch
            for event in delta_events
            for patch in event["state"]["object_delta"]["upserts"].values()
            if patch.get("$trace_patch") == 1 and patch.get("arrays", {}).get("items")
        )
        self.assertLessEqual(len(some_patch["arrays"]["items"]["set"]), 2)
        final_state = resolved_state(trace)
        values_id = final_state["frames"][-1]["locals"]["values"]["id"]
        self.assertEqual(len(final_state["objects"][values_id]["items"]), 200)
        self.assertEqual(primitive_value(final_state["objects"][values_id]["items"][0]), 1)
        self.assertLess(len(json.dumps(trace, separators=(",", ":")).encode("utf-8")), 1_500_000)

    def test_nested_grid_trace_stays_within_global_size_budget(self):
        source = (
            "grid = [[0 for _ in range(25)] for _ in range(25)]\n"
            "for step in range(300):\n"
            "    row = step % 25\n"
            "    col = (step // 25) % 25\n"
            "    grid[row][col] += 1\n"
        )
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        encoded = json.dumps(trace, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLessEqual(len(encoded), 16 * 1024 * 1024)
        self.assertTrue(any(event["state"].get("object_delta") for event in trace["events"]))

    def test_60_by_60_grid_uses_compact_deltas_without_hitting_size_budget(self):
        source = (
            "grid = [[0 for _ in range(60)] for _ in range(60)]\n"
            "for row in range(60):\n"
            "    for col in range(60):\n"
            "        grid[row][col] += 1\n"
        )
        result, trace = self.run_script(source, max_events=50_000, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(trace["metadata"]["truncated"])
        self.assertGreater(trace["metadata"]["event_count"], 5_000)
        encoded = json.dumps(trace, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLess(len(encoded), 16 * 1024 * 1024)
        self.assertLessEqual(
            trace["metadata"]["object_checkpoint_interval"],
            512,
        )

        final_state = resolved_state(trace)
        grid_id = final_state["frames"][-1]["locals"]["grid"]["id"]
        first_row_id = final_state["objects"][grid_id]["items"][0]["id"]
        first_cell = final_state["objects"][first_row_id]["items"][0]
        self.assertEqual(primitive_value(first_cell), 1)

    def test_output_budget_counts_json_escaping_bytes(self):
        source = "print('\\x00' * 400_000)\n"
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(trace["metadata"]["stdout_truncated"])
        encoded = json.dumps(trace, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLessEqual(len(encoded), 16 * 1024 * 1024)

    def test_global_size_limit_stops_execution_and_preserves_partial_trace(self):
        source = (
            "values = list(range(200))\n"
            "index = 0\n"
            "while True:\n"
            "    values[index % 200] += 1\n"
            "    index += 1\n"
        )
        result, trace = self.run_script(source, max_events=50_000, max_bytes=3 * 1024 * 1024)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(trace["metadata"]["truncated"])
        self.assertEqual(trace["metadata"]["truncation_reason"], "size_limit")
        self.assertGreater(trace["metadata"]["event_count"], 0)
        encoded = json.dumps(trace, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLessEqual(len(encoded), 3 * 1024 * 1024)

    def test_output_is_flushed_into_partial_trace_when_event_limit_is_hit(self):
        source = "print('saved before event cap')\nwhile True:\n    pass\n"
        result, trace = self.run_script(source, max_events=100)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("saved before event cap\n", trace["stdout"])
        self.assertEqual(trace["metadata"]["truncation_reason"], "event_limit")

    def test_event_limit_stops_an_infinite_loop_and_keeps_history(self):
        source = "counter = 0\nwhile True:\n    counter += 1\n"
        result, trace = self.run_script(source, max_events=100)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(trace["metadata"]["truncated"])
        self.assertEqual(trace["metadata"]["truncation_reason"], "event_limit")
        self.assertEqual(trace["metadata"]["event_count"], 100)
        self.assertEqual(len(trace["events"]), 100)

    def test_event_limit_cannot_be_caught_to_keep_program_running(self):
        source = (
            "counter = 0\n"
            "while True:\n"
            "    try:\n"
            "        counter += 1\n"
            "    except BaseException:\n"
            "        pass\n"
        )
        result, trace = self.run_script(source, max_events=100, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(trace["metadata"]["truncation_reason"], "event_limit")
        self.assertEqual(trace["metadata"]["event_count"], 100)

    @unittest.skipIf(os.name == "nt", "Windows cannot deliver SIGTERM; it hard-kills the process")
    def test_initial_checkpoint_exists_before_user_code_runs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script = root / "waiting.py"
            output = root / "partial-trace.json"
            marker = root / "user-code-started"
            script.write_text(
                f"from pathlib import Path\nPath({str(marker)!r}).write_text('started')\n"
                "import time\ntime.sleep(30)\n",
                encoding="utf-8",
            )
            process = subprocess.Popen(
                [sys.executable, str(TRACER), str(script), "--output", str(output)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                initial = None
                while time.monotonic() < deadline:
                    if output.exists():
                        try:
                            candidate = json.loads(output.read_text(encoding="utf-8"))
                            if candidate["metadata"].get("partial"):
                                initial = candidate
                                break
                        except (OSError, json.JSONDecodeError):
                            pass
                    time.sleep(0.02)
                self.assertIsNotNone(initial, "an empty recoverable checkpoint should be written before user code")
                self.assertEqual(initial["metadata"]["event_count"], 0)
                # The checkpoint is written before user code starts, so the marker
                # appears shortly afterwards; wait for it instead of racing it.
                marker_deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < marker_deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists(), "the user program should start after the initial checkpoint")
                process.send_signal(signal.SIGTERM)
                _, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 124, stderr)
                final_trace = json.loads(output.read_text(encoding="utf-8"))
                self.assertTrue(final_trace["metadata"]["truncated"])
                self.assertEqual(final_trace["metadata"]["truncation_reason"], "timeout")
                self.assertGreater(final_trace["metadata"]["event_count"], 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    @unittest.skipIf(os.name == "nt", "Windows cannot deliver SIGTERM; it hard-kills the process")
    def test_sigterm_writes_an_atomic_partial_trace(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script = root / "infinite.py"
            output = root / "partial-trace.json"
            marker = root / "running.marker"
            script.write_text(
                f"from pathlib import Path\nPath({str(marker)!r}).write_text('ready')\n"
                "counter = 0\nwhile True:\n    counter += 1\n",
                encoding="utf-8",
            )
            process = subprocess.Popen(
                [sys.executable, str(TRACER), str(script), "--output", str(output)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists(), "target script should start before sending SIGTERM")
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 124, stderr)
                self.assertTrue(output.exists(), "SIGTERM should commit a partial trace")
                trace = json.loads(output.read_text(encoding="utf-8"))
                self.assertTrue(trace["metadata"]["truncated"])
                self.assertEqual(trace["metadata"]["truncation_reason"], "timeout")
                self.assertGreater(trace["metadata"]["event_count"], 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    @unittest.skipIf(os.name == "nt", "SIGKILL checkpoint recovery is POSIX-specific")
    def test_last_atomic_checkpoint_survives_forced_kill(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script = root / "infinite.py"
            output = root / "partial-trace.json"
            script.write_text("counter = 0\nwhile True:\n    counter += 1\n", encoding="utf-8")
            process = subprocess.Popen(
                [sys.executable, str(TRACER), str(script), "--output", str(output)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 10
                checkpoint = None
                while time.monotonic() < deadline:
                    if output.exists():
                        try:
                            candidate = json.loads(output.read_text(encoding="utf-8"))
                            if candidate["metadata"].get("partial") and candidate["metadata"]["event_count"] >= 256:
                                checkpoint = candidate
                                break
                        except (OSError, json.JSONDecodeError):
                            pass
                    time.sleep(0.05)
                self.assertIsNotNone(checkpoint, "the tracer should periodically commit recoverable checkpoints")
                process.kill()
                process.communicate(timeout=5)
                recovered = json.loads(output.read_text(encoding="utf-8"))
                self.assertGreaterEqual(recovered["metadata"]["event_count"], 256)
                self.assertTrue(recovered["metadata"]["partial"])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


class RobustnessRegressionTests(unittest.TestCase):
    """Failure modes found in review: lone surrogates and dropped events."""

    run_script = TracerIntegrationTests.run_script

    def assert_every_event_replayable(self, trace):
        for index, event in enumerate(trace["events"]):
            self.assertEqual(event["sequence"], index)
            self.assertIn("state", event, f"event {index} ({event['event']}) has no state")
            state = event["state"]
            self.assertIsInstance(state["frames"], list)
            self.assertTrue(state.get("object_checkpoint") or "object_delta" in state or index == len(trace["events"]) - 1,
                            f"event {index} has neither a checkpoint nor a delta")

    def test_lone_surrogate_variable_does_not_crash_the_program_or_trace(self):
        source = 's = "\\ud800"\nt = [s, "ok"]\nprint("after")\n'
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(trace["metadata"]["program_error"], trace["metadata"]["program_error"])
        self.assertEqual(trace["stdout"], "after\n")
        self.assertFalse(any(e["event"] == "capture_error" for e in trace["events"]))
        self.assert_every_event_replayable(trace)

    @unittest.skipIf(
        os.name == "nt",
        "Invalid-byte os.fsdecode() surrogateescape behavior is POSIX-specific",
    )
    def test_surrogateescape_filename_value_is_preserved_losslessly(self):
        source = 'import os\nname = os.fsdecode(b"bad\\xffname")\nsize = len(name)\n'
        result, trace = self.run_script(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(trace["metadata"]["program_error"])
        last = trace["events"][-1]["state"]["frames"][-1]["locals"]
        self.assertEqual(last["size"]["value"], 8)
        self.assertEqual(last["name"]["value"], "bad\udcffname")

    def test_low_surrogate_string_is_preserved_losslessly_on_all_platforms(self):
        source = 'name = "bad\\udcffname"\nsize = len(name)\n'
        result, trace = self.run_script(source)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(trace["metadata"]["program_error"])

        last = trace["events"][-1]["state"]["frames"][-1]["locals"]

        self.assertEqual(last["size"]["value"], 8)
        self.assertEqual(last["name"]["value"], "bad\udcffname")
        self.assert_every_event_replayable(trace)

    def test_surrogate_in_exception_message_is_reported_not_fatal(self):
        result, trace = self.run_script('raise ValueError("bad \\ud800 text")\n')
        self.assertEqual(trace["metadata"]["program_error"]["type"], "ValueError")
        self.assertIn("ud800", trace["metadata"]["program_error"]["message"])

    def test_capture_failure_never_reaches_the_target_program(self):
        import tempfile as _tempfile
        with _tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script = root / "sample.py"
            script.write_text(
                "values = [1, 2, 3]\n"
                "values[0] = 10\n"
                "values.append(4)\n"
                "values[1] = 20\n"
                "answer = sum(values)\n",
                encoding="utf-8",
            )
            recorder = _tracer_module.TraceRecorder(root, 1000)
            original = recorder._capture_array_accesses
            calls = {"count": 0}

            def flaky(*args, **kwargs):
                calls["count"] += 1
                if calls["count"] == 3:
                    raise RuntimeError("simulated capture failure")
                return original(*args, **kwargs)

            recorder._capture_array_accesses = flaky
            namespace = {}
            sys.settrace(recorder.trace)
            try:
                namespace = __import__("runpy").run_path(str(script))
            finally:
                sys.settrace(None)

        self.assertEqual(namespace["answer"], 37, "the target program must still run to completion")
        events = recorder.events
        failures = [e for e in events if e["event"] == "capture_error"]
        self.assertEqual(len(failures), 1)
        failure = failures[0]
        self.assertIn("state", failure)
        self.assertEqual(failure["state"]["object_delta"], {"upserts": {}, "removed": []})
        following = events[failure["sequence"] + 1]
        self.assertTrue(following["state"]["object_checkpoint"],
                        "the event after a dropped one must be a full checkpoint")
        # The checkpoint must contain the list's current contents.
        nodes = following["state"]["objects"]
        list_nodes = [n for n in nodes.values() if n.get("type") == "list"]
        self.assertTrue(list_nodes)

    def test_generator_yield_offsets_are_computed_once_per_code_object(self):
        def gen():
            yield 1
            yield 2
        code = gen.__code__
        _tracer_module.TraceRecorder._yield_offsets_cache.pop(code, None)
        first = _tracer_module.TraceRecorder._yield_offsets(code)
        second = _tracer_module.TraceRecorder._yield_offsets(code)
        self.assertIs(first, second)
        self.assertTrue(first)

    def test_default_event_limit_matches_extension_default(self):
        previous = sys.argv
        sys.argv = ["tracer", "script.py"]
        try:
            args = _tracer_module.parse_args()
        finally:
            sys.argv = previous
        self.assertEqual(args.max_events, 20_000)


if __name__ == "__main__":
    unittest.main()
