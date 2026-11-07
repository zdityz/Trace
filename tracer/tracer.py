#!/usr/bin/env python3
"""Capture a replayable, line-level execution trace for a Python script.

This is a development tool, not a security sandbox. Run untrusted programs only
in an appropriately isolated environment.
"""
from __future__ import annotations

import argparse
import ast
import codecs
import dis
import io
import json
import linecache
import os
from pathlib import Path
import runpy
import signal
import sys
import tempfile
import threading
import time
import traceback
from types import FrameType
from typing import Any


SCHEMA_VERSION = 1
MAX_CAPTURED_OUTPUT_CHARS = 1_000_000
MAX_CAPTURED_OUTPUT_JSON_BYTES = MAX_CAPTURED_OUTPUT_CHARS + 2
MAX_TRACE_BYTES = 16 * 1024 * 1024
TRACE_METADATA_RESERVE_BYTES = 128 * 1024
OBJECT_CHECKPOINT_INTERVAL = 512


def _json_bytes(value: Any, **options: Any) -> bytes:
    """Encode JSON as UTF-8 without ever failing on lone surrogates.

    Python strings can legally hold lone surrogates (for example filenames
    decoded with surrogateescape, or ``"\\ud800"``). ``encode("utf-8")`` raises
    on them. ``backslashreplace`` turns each one into the JSON escape sequence
    ``\\udXXX``, which JSON parsers read back as the same lone surrogate, so the
    encoding is lossless and always valid JSON.
    """
    return json.dumps(value, ensure_ascii=False, **options).encode("utf-8", "backslashreplace")


class BoundedStringIO(io.StringIO):
    """Capture output within both character and final-JSON byte limits."""

    def __init__(
        self,
        max_chars: int = MAX_CAPTURED_OUTPUT_CHARS,
        max_json_bytes: int = MAX_CAPTURED_OUTPUT_JSON_BYTES,
    ):
        super().__init__()
        self.max_chars = max(0, int(max_chars))
        # Include the two quote characters surrounding the JSON string.
        self.max_json_bytes = max(2, int(max_json_bytes))
        self._written_chars = 0
        self._json_content_bytes = 0
        self.truncated = False

    @staticmethod
    def _json_payload_size(value: str) -> int:
        # json.dumps mirrors the exact escaping and UTF-8 representation used
        # for the final trace document, without retaining another copy.
        return len(_json_bytes(value)) - 2

    def write(self, value: str) -> int:
        if not isinstance(value, str):
            return super().write(value)

        remaining_chars = max(0, self.max_chars - self._written_chars)
        remaining_json_bytes = max(0, self.max_json_bytes - 2 - self._json_content_bytes)
        candidate = value[:remaining_chars]
        accepted_bytes = self._json_payload_size(candidate) if candidate else 0

        if accepted_bytes > remaining_json_bytes:
            # Find the longest prefix that fits. This path is used only when
            # the configured output cap is reached; binary search avoids a
            # Python-level loop over potentially millions of characters.
            low, high = 0, len(candidate)
            while low < high:
                middle = (low + high + 1) // 2
                size = self._json_payload_size(candidate[:middle])
                if size <= remaining_json_bytes:
                    low = middle
                else:
                    high = middle - 1
            candidate = candidate[:low]
            accepted_bytes = self._json_payload_size(candidate) if candidate else 0

        if candidate:
            super().write(candidate)
            self._written_chars += len(candidate)
            self._json_content_bytes += accepted_bytes
        if len(candidate) < len(value):
            self.truncated = True
        # Match a real text stream: tell the caller the full write was accepted.
        return len(value)


class FileDescriptorOutputCapture:
    """Capture both Python stream writes and direct writes to file descriptors 1/2."""

    def __init__(self, stdout: BoundedStringIO, stderr: BoundedStringIO):
        self._targets = ((1, stdout), (2, stderr))
        self._saved_fds: dict[int, int] = {}
        self._reader_threads: list[threading.Thread] = []
        self._started = False
        self._stopped = False

    @staticmethod
    def _drain(read_fd: int, target: BoundedStringIO) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        try:
            while True:
                chunk = os.read(read_fd, 8192)
                if not chunk:
                    break
                decoded = decoder.decode(chunk)
                if decoded:
                    target.write(decoded)
            tail = decoder.decode(b"", final=True)
            if tail:
                target.write(tail)
        except OSError:
            pass
        finally:
            try:
                os.close(read_fd)
            except OSError:
                pass

    def start(self) -> None:
        if self._started:
            return
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (AttributeError, OSError, ValueError):
                pass

        try:
            for file_descriptor, target in self._targets:
                saved_fd = os.dup(file_descriptor)
                read_fd, write_fd = os.pipe()
                try:
                    os.dup2(write_fd, file_descriptor)
                finally:
                    os.close(write_fd)
                self._saved_fds[file_descriptor] = saved_fd
                reader = threading.Thread(
                    target=self._drain,
                    args=(read_fd, target),
                    name=f"TraceOutput-{file_descriptor}",
                    daemon=True,
                )
                reader.start()
                self._reader_threads.append(reader)
        except BaseException:
            self.stop()
            raise
        self._started = True

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (AttributeError, OSError, ValueError):
                pass

        for file_descriptor, saved_fd in list(self._saved_fds.items()):
            try:
                os.dup2(saved_fd, file_descriptor)
            except OSError:
                pass
            finally:
                try:
                    os.close(saved_fd)
                except OSError:
                    pass
                self._saved_fds.pop(file_descriptor, None)

        # Once the parent descriptors are restored, the reader threads see EOF.
        # A child process may intentionally inherit stdout/stderr, so do not let
        # an unrelated child hold Trace's final write open indefinitely.
        deadline = time.monotonic() + 2.0
        for reader in self._reader_threads:
            reader.join(timeout=max(0.0, deadline - time.monotonic()))



class ValueSerializer:
    """Serialize values while retaining only changed object definitions.

    Frames are captured at every event, but object graphs are cached by stable
    object ID. Each event emits only new/changed object nodes (plus periodic
    checkpoints), so a large list or grid is not copied into every event.
    """

    def __init__(self, max_depth: int = 6, max_items: int = 200, max_string: int = 2_000):
        self.max_depth = max_depth
        self.max_items = max_items
        self.max_string = max_string
        self._identity_by_python_id: dict[int, str] = {}
        # Keep references alive for the duration of tracing so CPython cannot
        # recycle an id() and accidentally assign an old visual identity.
        self._known_objects: dict[int, Any] = {}
        self._next_object_number = 1
        self.object_nodes: dict[str, dict[str, Any]] = {}
        self._seen_objects: set[str] = set()
        self._changed_objects: dict[str, dict[str, Any]] = {}
        self._removed_objects: list[str] = []
        # Set when an event was discarded after its object delta was computed.
        # The next event then carries a full checkpoint so the reader cannot
        # drift out of sync with the serializer's cached object nodes.
        self.needs_checkpoint = False

    @staticmethod
    def _make_object_patch(
        previous: dict[str, Any],
        current: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Build a compact patch for a changed object node."""
        if previous.get("type") != current.get("type"):
            return current

        patch: dict[str, Any] = {
            "$trace_patch": 1,
            "set": {},
            "remove": [],
            "arrays": {},
            "maps": {},
        }
        previous_keys = set(previous)
        current_keys = set(current)

        for key in previous_keys - current_keys:
            patch["remove"].append(key)
        for key in current_keys - previous_keys:
            patch["set"][key] = current[key]

        for key in previous_keys & current_keys:
            before = previous[key]
            after = current[key]
            if before == after:
                continue

            if isinstance(before, list) and isinstance(after, list):
                changed = {
                    str(index): value
                    for index, value in enumerate(after)
                    if index >= len(before) or before[index] != value
                }
                comparison_size = max(len(before), len(after), 1)
                if len(changed) <= max(8, int(comparison_size * 0.70)):
                    patch["arrays"][key] = {"length": len(after), "set": changed}
                else:
                    patch["set"][key] = after
            elif isinstance(before, dict) and isinstance(after, dict):
                changed = {
                    name: value for name, value in after.items()
                    if name not in before or before[name] != value
                }
                removed = [name for name in before if name not in after]
                comparison_size = max(len(before), len(after), 1)
                if len(changed) + len(removed) <= max(8, int(comparison_size * 0.70)):
                    patch["maps"][key] = {"set": changed, "remove": removed}
                else:
                    patch["set"][key] = after
            else:
                patch["set"][key] = after

        if not patch["set"] and not patch["remove"] and not patch["arrays"] and not patch["maps"]:
            return None
        return patch

    def snapshot(
        self,
        frames: list[dict[str, Any]],
        *,
        checkpoint: bool = False,
    ) -> dict[str, Any]:
        self._seen_objects = set()
        self._changed_objects = {}
        checkpoint = checkpoint or self.needs_checkpoint
        self.needs_checkpoint = False
        serialized_frames: list[dict[str, Any]] = []
        for frame in frames:
            locals_result: dict[str, Any] = {}
            for name, value in sorted(frame["locals"].items()):
                if name.startswith("__") and name.endswith("__"):
                    continue
                locals_result[name] = self._serialize(value, depth=0)
            serialized_frames.append({
                "scope_id": frame["scope_id"],
                "function": frame["function"],
                "file": frame["file"],
                "line": frame["line"],
                "thread_id": frame.get("thread_id"),
                "thread_name": frame.get("thread_name"),
                "locals": locals_result,
            })

        self._removed_objects = [
            object_id for object_id in self.object_nodes
            if object_id not in self._seen_objects
        ]
        if self._removed_objects:
            removed_ids = set(self._removed_objects)
            for object_id in removed_ids:
                self.object_nodes.pop(object_id, None)
            # Do not keep every temporary object from the entire run alive.
            # Objects that leave the reachable trace graph no longer need a
            # stable visual identity; dropping them prevents a long-running
            # algorithm from accumulating an unbounded Python-side object cache.
            stale_python_ids = [
                python_id for python_id, object_id in self._identity_by_python_id.items()
                if object_id in removed_ids
            ]
            for python_id in stale_python_ids:
                self._identity_by_python_id.pop(python_id, None)
                self._known_objects.pop(python_id, None)

        if checkpoint:
            return {
                "frames": serialized_frames,
                "object_checkpoint": True,
                "objects": dict(self.object_nodes),
            }

        return {
            "frames": serialized_frames,
            "object_checkpoint": False,
            "objects": {},
            "object_delta": {
                "upserts": self._changed_objects,
                "removed": self._removed_objects,
            },
        }

    def _object_id(self, value: Any) -> str:
        py_id = id(value)
        existing = self._identity_by_python_id.get(py_id)
        if existing is not None:
            return existing
        object_id = f"obj-{self._next_object_number}"
        self._next_object_number += 1
        self._identity_by_python_id[py_id] = object_id
        self._known_objects[py_id] = value
        return object_id

    def _serialize(self, value: Any, depth: int) -> dict[str, Any]:
        value_type = type(value)
        type_name = value_type.__name__

        if value is None:
            return {"kind": "primitive", "type": "NoneType", "value": None}
        if value_type is bool:
            return {"kind": "primitive", "type": "bool", "value": value}
        if value_type is int:
            return {"kind": "primitive", "type": "int", "value": value}
        if value_type is float:
            if value != value or value in (float("inf"), float("-inf")):
                encoded = "nan" if value != value else ("infinity" if value > 0 else "-infinity")
                return {"kind": "primitive", "type": "float", "value": encoded}
            return {"kind": "primitive", "type": "float", "value": value}
        if value_type is str:
            truncated = len(value) > self.max_string
            return {
                "kind": "primitive", "type": "str",
                "value": value[: self.max_string], "truncated": truncated,
            }

        supported_container = value_type in (list, tuple, dict, set, frozenset)
        instance_attributes = None
        if not supported_container and value_type.__module__ != "builtins" and not isinstance(value, type):
            # Inspect only the instance's own __dict__. Avoid calling repr(),
            # properties, iterators, or user-defined accessors while tracing.
            try:
                candidate = object.__getattribute__(value, "__dict__")
                if type(candidate) is dict:
                    instance_attributes = candidate
            except (AttributeError, TypeError):
                instance_attributes = None
        if not supported_container and instance_attributes is None:
            return {"kind": "opaque", "type": type_name}

        object_id = self._object_id(value)
        if object_id in self._seen_objects:
            return {"kind": "ref", "id": object_id}
        self._seen_objects.add(object_id)

        if supported_container:
            node: dict[str, Any] = {"type": type_name}
        else:
            node = {
                "type": "instance",
                "class_name": type_name,
                "module": value_type.__module__,
            }

        # Register the ID before descending; this preserves cycles and aliases.
        if depth >= self.max_depth:
            node["truncated"] = True
            node["reason"] = "max_depth"
        elif value_type in (list, tuple):
            items = value[: self.max_items]
            node["items"] = [self._serialize(item, depth + 1) for item in items]
            if len(value) > self.max_items:
                node["truncated"] = True
                node["omitted_items"] = len(value) - self.max_items
        elif value_type is dict:
            entries = list(value.items())[: self.max_items]
            node["entries"] = [
                {
                    "key": self._serialize(key, depth + 1),
                    "value": self._serialize(item, depth + 1),
                }
                for key, item in entries
            ]
            if len(value) > self.max_items:
                node["truncated"] = True
                node["omitted_items"] = len(value) - self.max_items
        elif value_type in (set, frozenset):
            items = list(value)[: self.max_items]
            node["items"] = [self._serialize(item, depth + 1) for item in items]
            if len(value) > self.max_items:
                node["truncated"] = True
                node["omitted_items"] = len(value) - self.max_items
        else:
            attributes = list(instance_attributes.items())[: self.max_items]
            node["attributes"] = {
                str(name): self._serialize(item, depth + 1)
                for name, item in attributes
                if isinstance(name, str) and not (name.startswith("__") and name.endswith("__"))
            }
            if len(instance_attributes) > self.max_items:
                node["truncated"] = True
                node["omitted_attributes"] = len(instance_attributes) - self.max_items

        previous = self.object_nodes.get(object_id)
        if previous is None:
            self.object_nodes[object_id] = node
            self._changed_objects[object_id] = node
        elif previous != node:
            patch = self._make_object_patch(previous, node)
            if patch is not None:
                self.object_nodes[object_id] = node
                self._changed_objects[object_id] = patch

        return {"kind": "ref", "id": object_id}


class TraceRecorder:
    def __init__(
        self,
        target_root: Path,
        max_events: int,
        max_bytes: int = MAX_TRACE_BYTES,
        output_budget_bytes: int = MAX_CAPTURED_OUTPUT_JSON_BYTES,
    ):
        self.target_root = target_root.resolve()
        self.max_events = max_events
        self.max_bytes = max_bytes
        # stdout and stderr have their own JSON-encoded byte caps. Keep a
        # metadata reserve, then allocate the remainder to recorded events.
        self.max_event_bytes = max(
            0,
            max_bytes - 2 * output_budget_bytes - TRACE_METADATA_RESERVE_BYTES,
        )
        self.event_bytes = 0
        self.events: list[dict[str, Any]] = []
        self._frames: list[FrameType] = []
        self._scope_ids: dict[int, str] = {}
        self._frame_threads: dict[int, tuple[int, str]] = {}
        self._next_scope_number = 1
        self._lock = threading.RLock()
        self._serializer = ValueSerializer()
        self._source_ast_cache: dict[str, tuple[dict[int, list[ast.Subscript]], dict[int, ast.AST]]] = {}
        self.truncated = False
        self.stop_reason: str | None = None
        self.checkpoint_callback = None
        self.output_capture_callback = None
        self._last_checkpoint_event = 0
        self._last_checkpoint_time = time.monotonic()

    def stop(self, reason: str) -> None:
        self.truncated = True
        if self.stop_reason is None:
            self.stop_reason = reason

    def _stop_execution(self, reason: str) -> None:
        """Commit the partial trace, then terminate without target-code interception."""
        self.stop(reason)
        if self.output_capture_callback is not None:
            try:
                self.output_capture_callback()
            except Exception:
                pass
            self.output_capture_callback = None
        if self.checkpoint_callback is not None:
            try:
                self.checkpoint_callback()
            except Exception:
                # Keep the most recent already-committed checkpoint if this write fails.
                pass
        os._exit(124 if reason == "timeout" else 0)

    def _is_target_file(self, filename: str) -> bool:
        if not filename or filename.startswith("<"):
            return False
        try:
            resolved = Path(filename).resolve()
            if os.path.commonpath((str(self.target_root), str(resolved))) != str(self.target_root):
                return False

            # Imports from a project-local virtual environment are dependencies,
            # not user code. Check every directory below the entry-point root,
            # including non-standard environment names identified by pyvenv.cfg.
            for parent in resolved.parents:
                if parent == self.target_root:
                    break
                if parent.name.casefold() in {
                    ".venv", "venv", "env", "virtualenv", ".virtualenv",
                    "site-packages", "dist-packages",
                }:
                    return False
                if (parent / "pyvenv.cfg").is_file():
                    return False
            return True
        except (OSError, ValueError, RuntimeError):
            return False

    def _ensure_scope(self, frame: FrameType) -> str:
        key = id(frame)
        scope_id = self._scope_ids.get(key)
        if scope_id is None:
            scope_id = f"scope-{self._next_scope_number}"
            self._next_scope_number += 1
            self._scope_ids[key] = scope_id
            self._frames.append(frame)
        current_thread = threading.current_thread()
        self._frame_threads[key] = (threading.get_ident(), current_thread.name)
        return scope_id

    def _remove_scope(self, frame: FrameType) -> None:
        key = id(frame)
        self._scope_ids.pop(key, None)
        self._frame_threads.pop(key, None)
        self._frames = [active for active in self._frames if active is not frame]

    _yield_offsets_cache: dict[Any, frozenset[int]] = {}

    @classmethod
    def _yield_offsets(cls, code: Any) -> frozenset[int]:
        """Offsets at which a generator's 'return' trace event means a yield.

        That is each YIELD_VALUE/YIELD_FROM instruction, plus (CPython 3.11+)
        the instruction right after it, where the trace event is reported.
        Computed once per code object; disassembling on every event was slow.
        """
        cached = cls._yield_offsets_cache.get(code)
        if cached is None:
            offsets: set[int] = set()
            previous_was_yield = False
            for instruction in dis.get_instructions(code):
                is_yield = instruction.opname in {"YIELD_VALUE", "YIELD_FROM"}
                if is_yield or previous_was_yield:
                    offsets.add(instruction.offset)
                previous_was_yield = is_yield
            cached = frozenset(offsets)
            cls._yield_offsets_cache[code] = cached
        return cached

    @classmethod
    def _is_generator_yield(cls, frame: FrameType, event: str) -> bool:
        if event != "return":
            return False
        generator_flags = 0x20 | 0x80 | 0x200  # generator, coroutine, async generator
        if not (frame.f_code.co_flags & generator_flags):
            return False
        if frame.f_lasti < 0:
            return False
        return frame.f_lasti in cls._yield_offsets(frame.f_code)

    def _active_frame_data(self) -> list[dict[str, Any]]:
        result = []
        for active in self._frames:
            scope_id = self._scope_ids.get(id(active))
            if scope_id is None:
                continue
            thread_id, thread_name = self._frame_threads.get(id(active), (0, "unknown"))
            result.append({
                "scope_id": scope_id,
                "function": active.f_code.co_name,
                "file": str(Path(active.f_code.co_filename).resolve()),
                "line": active.f_lineno,
                "thread_id": thread_id,
                "thread_name": thread_name,
                "locals": dict(active.f_locals),
            })
        return result

    def _record(self, frame: FrameType, event: str, arg: Any) -> None:
        if len(self.events) >= self.max_events:
            self._stop_execution("event_limit")

        generator_yield = self._is_generator_yield(frame, event)
        event_type = {
            "call": "function_called",
            "line": "line_executed",
            "return": "function_suspended" if generator_yield else "function_returned",
            "exception": "exception_raised",
        }.get(event, event)

        filename = str(Path(frame.f_code.co_filename).resolve())
        lineno = frame.f_lineno
        source = linecache.getline(filename, lineno).rstrip("\n")
        record: dict[str, Any] = {
            "sequence": len(self.events),
            "event": event_type,
            "source": {"file": filename, "line": lineno, "text": source},
            "scope_id": self._scope_ids.get(id(frame)),
            "function": frame.f_code.co_name,
            "thread_id": threading.get_ident(),
            "thread_name": threading.current_thread().name,
        }

        if event == "exception":
            exc_type, exc_value, _ = arg
            record["exception"] = {
                "type": getattr(exc_type, "__name__", "Exception"),
                "message": self._safe_exception_message(exc_value),
            }
        full_state = self._serializer.snapshot(
            self._active_frame_data(),
            checkpoint=(len(self.events) % OBJECT_CHECKPOINT_INTERVAL == 0),
        )
        record["state"] = full_state
        if event == "line":
            accesses = self._capture_array_accesses(frame, filename, lineno, full_state)
            if accesses:
                record["array_accesses"] = accesses

        encoded_size = len(_json_bytes(record, separators=(",", ":"))) + 1
        if self.event_bytes + encoded_size > self.max_event_bytes:
            self._stop_execution("size_limit")
        self.events.append(record)
        self.event_bytes += encoded_size
        if self.checkpoint_callback is not None:
            now = time.monotonic()
            if len(self.events) - self._last_checkpoint_event >= 256 or now - self._last_checkpoint_time >= 2.0:
                try:
                    self.checkpoint_callback()
                    self._last_checkpoint_event = len(self.events)
                    self._last_checkpoint_time = now
                except Exception:
                    # Checkpoint I/O is best-effort and must never interrupt the target.
                    pass

    def _source_subscripts(self, filename: str) -> tuple[dict[int, list[ast.Subscript]], dict[int, ast.AST]]:
        cached = self._source_ast_cache.get(filename)
        if cached is not None:
            return cached

        by_line: dict[int, list[ast.Subscript]] = {}
        parents: dict[int, ast.AST] = {}
        try:
            source = "".join(linecache.getlines(filename))
            tree = ast.parse(source, filename=filename)
            for parent in ast.walk(tree):
                for child in ast.iter_child_nodes(parent):
                    parents[id(child)] = parent
                if isinstance(parent, ast.Subscript):
                    by_line.setdefault(parent.lineno, []).append(parent)
            for nodes in by_line.values():
                nodes.sort(key=lambda item: (item.col_offset, item.end_col_offset or item.col_offset))
        except (OSError, SyntaxError, ValueError):
            by_line = {}
            parents = {}

        result = (by_line, parents)
        self._source_ast_cache[filename] = result
        return result

    @staticmethod
    def _safe_integer_expression(node: ast.AST, namespace: dict[str, Any]) -> int | None:
        """Resolve a deliberately small, side-effect-free subset of index expressions."""
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return node.value
        if isinstance(node, ast.Name):
            value = namespace.get(node.id)
            return value if type(value) is int else None
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = TraceRecorder._safe_integer_expression(node.operand, namespace)
            if value is None:
                return None
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.FloorDiv, ast.Mod)):
            left = TraceRecorder._safe_integer_expression(node.left, namespace)
            right = TraceRecorder._safe_integer_expression(node.right, namespace)
            if left is None or right is None:
                return None
            try:
                if isinstance(node.op, ast.Add):
                    value = left + right
                elif isinstance(node.op, ast.Sub):
                    value = left - right
                elif isinstance(node.op, ast.Mult):
                    value = left * right
                elif isinstance(node.op, ast.FloorDiv):
                    value = left // right
                else:
                    value = left % right
            except (ArithmeticError, OverflowError):
                return None
            # Avoid spending time on pathological integers from user expressions.
            return value if abs(value) <= 2**31 - 1 else None
        return None

    def _capture_array_accesses(
        self,
        frame: FrameType,
        filename: str,
        lineno: int,
        state: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Annotate a line with simple list indexes it is about to read or target."""
        by_line, parents = self._source_subscripts(filename)
        nodes = by_line.get(lineno, [])
        if not nodes:
            return []

        namespace = dict(frame.f_globals)
        namespace.update(frame.f_locals)
        scope_id = self._scope_ids.get(id(frame))
        serialized_frame = next(
            (item for item in state.get("frames", []) if item.get("scope_id") == scope_id),
            None,
        )
        if serialized_frame is None:
            return []
        serialized_locals = serialized_frame.get("locals", {})
        # Delta events intentionally carry no full object map. The serializer
        # keeps the latest resolved nodes for lightweight array annotations.
        objects = self._serializer.object_nodes

        # Merge repeated references to the same cell. A tuple-swap, for example,
        # reads and targets each of its two positions in one statement.
        merged: dict[tuple[str, int], dict[str, Any]] = {}
        for node in nodes:
            if not isinstance(node.value, ast.Name):
                continue
            array_name = node.value.id
            array_value = namespace.get(array_name)
            if type(array_value) is not list:
                continue

            encoded_ref = serialized_locals.get(array_name)
            if not isinstance(encoded_ref, dict) or encoded_ref.get("kind") != "ref":
                # A function may index a module-level list. Its globals are
                # represented by the still-active module frame snapshot.
                encoded_ref = None
                for candidate_frame in reversed(state.get("frames", [])):
                    candidate_locals = candidate_frame.get("locals", {})
                    candidate_ref = candidate_locals.get(array_name)
                    if isinstance(candidate_ref, dict) and candidate_ref.get("kind") == "ref":
                        encoded_ref = candidate_ref
                        break
                if encoded_ref is None:
                    continue
            object_id = encoded_ref.get("id")
            object_node = objects.get(object_id) if isinstance(object_id, str) else None
            if not isinstance(object_node, dict) or object_node.get("type") != "list":
                continue

            raw_index = self._safe_integer_expression(node.slice, namespace)
            if raw_index is None:
                continue
            normalized_index = raw_index if raw_index >= 0 else len(array_value) + raw_index
            if normalized_index < 0 or normalized_index >= len(array_value):
                continue

            parent = parents.get(id(node))
            # Do not emit a misleading partial highlight for matrix[row][col].
            if isinstance(parent, ast.Subscript):
                continue
            if isinstance(parent, ast.AugAssign) and parent.target is node:
                kind = "read_write"
            elif isinstance(node.ctx, ast.Store):
                kind = "write"
            elif isinstance(node.ctx, ast.Load):
                kind = "read"
            else:
                continue

            key = (object_id, normalized_index)
            existing = merged.get(key)
            if existing is None:
                merged[key] = {
                    "array_name": array_name,
                    "object_id": object_id,
                    "index": normalized_index,
                    "kind": kind,
                }
            else:
                kinds = {existing["kind"], kind}
                if "read_write" in kinds or ("read" in kinds and "write" in kinds):
                    existing["kind"] = "read_write"
                elif "write" in kinds:
                    existing["kind"] = "write"
                else:
                    existing["kind"] = "read"

        return list(merged.values())

    @staticmethod
    def _safe_exception_message(value: Any) -> str:
        try:
            return str(value)[:500].encode("utf-8", "backslashreplace").decode("utf-8")
        except Exception:
            return "<exception message unavailable>"

    def _record_capture_error(self, frame: FrameType, capture_error: Exception) -> None:
        """Append a readable placeholder event after a recording failure.

        The failed event's object delta may already have been folded into the
        serializer's cache but was never written, so force the next event to be
        a full checkpoint. The placeholder carries the previous frames and an
        empty delta so state replay stays valid across it.
        """
        self._serializer.needs_checkpoint = True
        if len(self.events) >= self.max_events:
            return
        previous_state = self.events[-1].get("state") if self.events else None
        frames = previous_state.get("frames", []) if isinstance(previous_state, dict) else []
        try:
            filename = str(Path(frame.f_code.co_filename).resolve())
        except (OSError, ValueError, RuntimeError):
            filename = "<unknown>"
        self.events.append({
            "sequence": len(self.events),
            "event": "capture_error",
            "source": {"file": filename, "line": frame.f_lineno},
            "scope_id": self._scope_ids.get(id(frame)),
            "function": frame.f_code.co_name,
            "message": f"Trace capture failed: {type(capture_error).__name__}",
            "state": {
                "frames": frames,
                "object_checkpoint": False,
                "objects": {},
                "object_delta": {"upserts": {}, "removed": []},
            },
        })

    def trace(self, frame: FrameType, event: str, arg: Any):
        # Trace hooks from multiple Python threads share the recorder and object
        # identity cache. Serialize event creation to preserve a single timeline.
        with self._lock:
            if self.stop_reason is not None:
                self._stop_execution(self.stop_reason)
            if not self._is_target_file(frame.f_code.co_filename):
                return None

            if event == "call":
                self._ensure_scope(frame)
            elif id(frame) not in self._scope_ids:
                self._ensure_scope(frame)

            try:
                self._record(frame, event, arg)
            except Exception as capture_error:
                # A recording problem must never change the user's program result.
                self._record_capture_error(frame, capture_error)

            if event == "return" and not self._is_generator_yield(frame, event):
                self._remove_scope(frame)
            return self.trace


def _resolved_path(value: str | Path) -> str:
    try:
        return str(Path(value).expanduser().resolve())
    except (OSError, RuntimeError, ValueError):
        return str(value)


def _build_program_error(
    exc: BaseException,
    script_path: Path,
    target_root: Path,
    recorder: TraceRecorder,
) -> dict[str, Any]:
    """Describe an uncaught program error and link it to a recorded state.

    A regular runtime error should already have an ``exception_raised`` trace
    event. Syntax errors happen before tracing starts, so they receive a
    synthetic ``execution_error`` event with an empty runtime state.
    """
    is_syntax_error = isinstance(exc, SyntaxError)
    extracted = traceback.extract_tb(exc.__traceback__)

    location: dict[str, Any] = {
        "file": _resolved_path(getattr(exc, "filename", None) or script_path),
        "line": getattr(exc, "lineno", None),
        "column": getattr(exc, "offset", None),
        "function": "<module>",
    }

    if not is_syntax_error:
        user_frames = []
        for frame_summary in extracted:
            filename = _resolved_path(frame_summary.filename)
            try:
                in_target_root = os.path.commonpath((str(target_root.resolve()), filename)) == str(target_root.resolve())
            except (OSError, ValueError):
                in_target_root = False
            if in_target_root:
                user_frames.append(frame_summary)

        # Prefer the innermost frame from the user's project. It is the point
        # where the uncaught exception most directly surfaced in user code.
        if user_frames:
            frame_summary = user_frames[-1]
            location = {
                "file": _resolved_path(frame_summary.filename),
                "line": frame_summary.lineno,
                "column": (frame_summary.colno + 1) if getattr(frame_summary, "colno", None) is not None else None,
                "function": frame_summary.name,
            }

    source_text = ""
    line_number = location.get("line")
    if isinstance(line_number, int) and line_number > 0:
        source_text = linecache.getline(str(location["file"]), line_number).rstrip("\n")
    if not source_text and is_syntax_error:
        source_text = (getattr(exc, "text", None) or "").rstrip("\n")
    if source_text:
        location["source_text"] = source_text

    matched_sequence: int | None = None
    state_kind = "failure"
    location_file = _resolved_path(location["file"])
    if isinstance(line_number, int):
        for index in range(len(recorder.events) - 1, -1, -1):
            event = recorder.events[index]
            source = event.get("source", {})
            if (
                event.get("event") == "exception_raised"
                and _resolved_path(source.get("file", "")) == location_file
                and source.get("line") == line_number
            ):
                matched_sequence = index
                break

    message = TraceRecorder._safe_exception_message(exc)
    if matched_sequence is None:
        # Syntax errors in the entry file have no runtime snapshots. For an
        # exception that escaped tracing (for example after the event cap or
        # while importing another file), retain the latest known state.
        state_kind = "last_recorded" if recorder.events else "none"
        state = recorder.events[-1].get("state") if recorder.events else {"frames": [], "objects": {}}
        if not isinstance(state, dict):
            state = {"frames": [], "objects": {}}
        matched_sequence = len(recorder.events)
        recorder.events.append({
            "sequence": matched_sequence,
            "event": "execution_error",
            "source": {
                "file": location_file,
                "line": line_number if isinstance(line_number, int) else 0,
                "text": source_text,
            },
            "scope_id": None,
            "function": location.get("function", "<module>"),
            "exception": {"type": type(exc).__name__, "message": message},
            "state": state,
        })

    return {
        "type": type(exc).__name__,
        "message": message,
        "kind": "syntax" if is_syntax_error else "runtime",
        "location": location,
        "event_sequence": matched_sequence,
        "state_kind": state_kind,
        "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-8_000:],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Record a line-level Python execution trace.")
    parser.add_argument("script", help="Python file to execute")
    parser.add_argument("--output", default="trace.json", help="Output JSON path")
    parser.add_argument("--max-events", type=int, default=20_000, help="Maximum recorded events")
    parser.add_argument(
        "--max-bytes", type=int, default=MAX_TRACE_BYTES,
        help=f"Maximum trace JSON size in bytes (default: {MAX_TRACE_BYTES})",
    )
    return parser.parse_args()


def build_trace_document(
    script_path: Path,
    recorder: TraceRecorder,
    captured_stdout: BoundedStringIO,
    captured_stderr: BoundedStringIO,
    started: float,
    exit_code: int,
    program_error: dict[str, Any] | None,
    partial: bool = False,
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "metadata": {
            "script": str(script_path),
            "python_version": sys.version.split()[0],
            "event_count": len(recorder.events),
            "truncated": recorder.truncated,
            "truncation_reason": recorder.stop_reason,
            "partial": partial,
            "object_encoding": "delta-v1",
            "object_checkpoint_interval": OBJECT_CHECKPOINT_INTERVAL,
            "line_state_timing": "before_execution",
            "max_trace_bytes": recorder.max_bytes,
            "duration_ms": round((time.perf_counter() - started) * 1000, 3),
            "exit_code": exit_code,
            "stdout_truncated": captured_stdout.truncated,
            "stderr_truncated": captured_stderr.truncated,
            "program_error": program_error,
        },
        "stdout": captured_stdout.getvalue(),
        "stderr": captured_stderr.getvalue(),
        "events": recorder.events,
    }


def write_trace_document(
    output_path: Path,
    document: dict[str, Any],
    max_bytes: int | None = None,
) -> None:
    """Atomically write compact JSON, trimming only the tail as a final safety net."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Work on a shallow copy so a checkpoint write never mutates the live
    # recorder's event list. Removing only trailing events keeps all preceding
    # object checkpoints and deltas replayable.
    payload = dict(document)
    payload["events"] = list(document.get("events", []))
    metadata = dict(document.get("metadata", {}))
    payload["metadata"] = metadata

    while True:
        encoded = _json_bytes(payload, separators=(",", ":"))
        if max_bytes is None or len(encoded) <= max_bytes:
            break
        if not payload["events"]:
            raise ValueError("Trace document exceeds its configured size budget")
        payload["events"].pop()
        metadata["event_count"] = len(payload["events"])
        metadata["truncated"] = True
        metadata["truncation_reason"] = "size_limit"
        metadata["partial"] = True

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=output_path.parent,
            prefix=f".{output_path.name}.", suffix=".tmp", delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(encoded)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def main() -> int:
    args = parse_args()
    script_path = Path(args.script).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    if not script_path.is_file():
        print(f"Trace: Python file not found: {script_path}", file=sys.stderr)
        return 2
    if args.max_events < 1:
        print("Trace: --max-events must be at least 1", file=sys.stderr)
        return 2
    if args.max_bytes < 3 * 1024 * 1024:
        print("Trace: --max-bytes must be at least 3 MiB", file=sys.stderr)
        return 2

    output_budget_bytes = min(
        MAX_CAPTURED_OUTPUT_JSON_BYTES,
        max(64 * 1024, args.max_bytes // 16),
    )
    recorder = TraceRecorder(
        script_path.parent,
        args.max_events,
        args.max_bytes,
        output_budget_bytes=output_budget_bytes,
    )
    captured_stdout = BoundedStringIO(
        MAX_CAPTURED_OUTPUT_CHARS, max_json_bytes=output_budget_bytes
    )
    captured_stderr = BoundedStringIO(
        MAX_CAPTURED_OUTPUT_CHARS, max_json_bytes=output_budget_bytes
    )
    program_error: dict[str, str] | None = None
    started = time.perf_counter()
    original_argv = sys.argv[:]
    original_path = sys.path[:]
    exit_code = 0

    previous_sigterm_handler = signal.getsignal(signal.SIGTERM)
    output_capture = FileDescriptorOutputCapture(captured_stdout, captured_stderr)
    recorder.output_capture_callback = output_capture.stop

    def write_checkpoint() -> None:
        checkpoint_exit_code = 124 if recorder.stop_reason == "timeout" else 0
        document = build_trace_document(
            script_path, recorder, captured_stdout, captured_stderr,
            started, checkpoint_exit_code, None, partial=True,
        )
        write_trace_document(output_path, document, max_bytes=recorder.max_bytes)

    recorder.checkpoint_callback = write_checkpoint

    def handle_sigterm(_signum: int, _frame: FrameType | None) -> None:
        # Prevent re-entrant termination while the final atomic write is in
        # progress. Stop tracing before touching the capture threads so the
        # shutdown path cannot add more target-code events.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        sys.settrace(None)
        threading.settrace(None)
        # Flush and restore descriptors before committing so both print() and
        # direct os.write() calls that reached the pipes are included.
        output_capture.stop()
        recorder._stop_execution("timeout")

    signal.signal(signal.SIGTERM, handle_sigterm)

    try:
        output_capture.start()
        # Commit an empty, valid checkpoint before user code starts. This is
        # especially important on Windows, where process-tree termination may
        # have to fall back to a hard kill that cannot run Python's SIGTERM
        # handler. Later checkpoints replace it atomically as execution moves.
        write_checkpoint() 
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.reconfigure(
                    encoding="utf-8",
                    errors="replace",
                    newline="\n",
                )
            except (AttributeError, OSError, ValueError):
                pass
        sys.argv = [str(script_path)]
        sys.path.insert(0, str(script_path.parent))
        sys.settrace(recorder.trace)
        threading.settrace(recorder.trace)
        runpy.run_path(str(script_path), run_name="__main__")
    except SystemExit as exc:
        # sys.exit(None), sys.exit(0), and sys.exit(False) are successful exits.
        # Keep non-zero exits visible as failures so test mode cannot report them as passing.
        if exc.code is None or (isinstance(exc.code, int) and exc.code == 0):
            exit_code = 0
        else:
            exit_code = 1
            program_error = _build_program_error(exc, script_path, script_path.parent, recorder)
    except BaseException as exc:  # Preserve the target program's failure in the trace.
        exit_code = 1
        program_error = _build_program_error(exc, script_path, script_path.parent, recorder)
    finally:
        # Match normal Python process shutdown: non-daemon threads continue
        # running after module-level code returns, and their code remains traceable.
        current_thread = threading.current_thread()
        for active_thread in threading.enumerate():
            if active_thread is not current_thread and not active_thread.daemon:
                try:
                    active_thread.join()
                except RuntimeError:
                    pass
        sys.settrace(None)
        threading.settrace(None)
        output_capture.stop()
        sys.argv = original_argv
        sys.path[:] = original_path
        # Ignore another SIGTERM while the final compact JSON is committed.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    trace_document = build_trace_document(
        script_path, recorder, captured_stdout, captured_stderr, started, exit_code, program_error,
        partial=recorder.truncated,
    )
    try:
        write_trace_document(output_path, trace_document, max_bytes=recorder.max_bytes)
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm_handler)
    print(f"Trace: recorded {len(recorder.events)} events -> {output_path}")
    if recorder.truncated:
        print(f"Trace: partial history preserved ({recorder.stop_reason}).")
    if program_error:
        print(f"Trace: target program raised {program_error['type']}: {program_error['message']}", file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
