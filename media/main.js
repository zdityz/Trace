(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let trace = null;
  let sourceLines = [];
  let currentIndex = 0;
  let playTimer = null;
  let historyModel = { columns: [], rows: [] };
  let testResult = null;
  let visualizationCache = window.TraceVisualizationCache
    ? window.TraceVisualizationCache.createVisualizationCache(window.TraceStructures)
    : null;
  let historyViewActive = false;
  let historyScrollRestoreInProgress = false;
  const HISTORY_ROW_HEIGHT = 36;
  let structureSvgCounter = 0;

  const previousState = vscode.getState();
  if (previousState && Number.isInteger(previousState.cursor)) {
    currentIndex = previousState.cursor;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'loadTrace') return;
    trace = message.trace;
    testResult = message.testResult || null;
    if (visualizationCache) visualizationCache.reset();
    historyModel = window.TraceHistory.buildHistoryModel(trace.events);
    sourceLines = String(message.source || '').replace(/\r\n/g, '\n').split('\n');
    const failureSequence = getProgramErrorSequence();
    currentIndex = failureSequence !== null
      ? failureSequence
      : Math.max(0, Math.min(currentIndex, Math.max(0, trace.events.length - 1)));
    renderShell();
    renderCurrent();
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const clearVisualization = target.closest('[data-clear-visualization]');
    if (clearVisualization && visualizationCache) {
      visualizationCache.dismiss(clearVisualization.getAttribute('data-clear-visualization'));
      renderVisualizations();
      return;
    }
    const stateTab = target.closest('[data-state-tab]');
    if (stateTab) {
      setStateView(stateTab.getAttribute('data-state-tab'));
      return;
    }
    const historyRow = target.closest('[data-history-step]');
    if (historyRow && trace) {
      seek(Number(historyRow.getAttribute('data-history-step')));
      return;
    }

    const action = target.closest('[data-action]')?.getAttribute('data-action');
    if (action === 'previous') step(-1);
    if (action === 'next') step(1);
    if (action === 'play') togglePlay();
    if (action === 'first') seek(0);
    if (action === 'last' && trace) seek(trace.events.length - 1);
    if (action === 'go-to-failure') {
      const failureSequence = getProgramErrorSequence();
      if (failureSequence !== null) seek(failureSequence);
    }
    if (action === 'previous-failure-step') {
      const failureSequence = getProgramErrorSequence();
      if (failureSequence !== null && failureSequence > 0) seek(failureSequence - 1);
    }
    if (action === 'investigate-test-failure' && trace?.events?.length) {
      const failureSequence = getProgramErrorSequence();
      seek(testResult?.status === 'runtime-error' && failureSequence !== null
        ? failureSequence
        : trace.events.length - 1);
    }

    const codeLine = target.closest('.code-line');
    if (codeLine && trace) {
      const lineNumber = Number(codeLine.getAttribute('data-line'));
      const eventIndex = findEventForLine(lineNumber);
      if (eventIndex >= 0) seek(eventIndex);
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === 'timeline' && trace) {
      seek(Number(target.value));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!trace || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
    if (event.key === ' ') {
      event.preventDefault();
      togglePlay();
    }
  });

  function renderShell() {
    const scriptName = (trace.metadata.script || 'Python program').split(/[\\/]/).pop();
    app.className = 'app';
    app.innerHTML = `
      <header class="topbar">
        <div class="brand"><span class="brand-mark">T</span><div><strong>Trace</strong><span class="subtitle">Python execution visualizer</span></div></div>
        <div class="run-meta"><span class="file-pill">${escapeHtml(scriptName)}</span><span id="run-status" class="status-pill">Completed</span></div>
      </header>
      <main class="workspace">
        <section class="panel source-panel">
          <div class="panel-heading"><div><span class="eyebrow">SOURCE</span><h2>Code</h2></div><span id="event-kind" class="event-kind">—</span></div>
          <div id="source-code" class="source-code" aria-label="Python source code"></div>
        </section>
        <section class="right-column">
          <section class="panel visualization-panel">
            <div class="panel-heading"><div><span class="eyebrow">VISUALIZATION</span><h2>Data Structures</h2></div><span id="structure-count" class="muted-label">0 structures</span></div>
            <div id="arrays" class="arrays empty-state">Recognized lists, linked lists, trees, and graphs will appear here.</div>
          </section>
          <section class="panel variables-panel">
            <div class="panel-heading"><div><span class="eyebrow">RUNTIME STATE</span><h2>Runtime State</h2><p class="state-timing-note">Snapshot taken before the highlighted line executes.</p></div><span id="scope-count" class="muted-label">0 scopes</span></div>
            <div class="state-tabs" role="tablist" aria-label="Runtime state views">
              <button type="button" class="state-tab active" data-state-tab="current" role="tab" aria-selected="true">Current State</button>
              <button type="button" class="state-tab" data-state-tab="history" role="tab" aria-selected="false">History Table</button>
              <span id="history-meta" class="history-meta"></span>
            </div>
            <div id="variables" class="variables empty-state">No variables in this execution state.</div>
            <div id="history-view" class="history-view hidden" role="tabpanel">
              <div class="history-note">Each row is a recorded execution event. Select a row to jump to that step. Highlighted cells show values that changed or first appeared.</div>
              <div id="history-scroll" class="history-scroll" tabindex="0" aria-label="Runtime variable history table">
                <table class="history-table" aria-label="Variable values across execution steps"><thead id="history-head"></thead><tbody id="history-body"></tbody></table>
              </div>
              <div class="history-range" aria-live="polite">
                <span id="history-range-label"><strong>0</strong> steps</span>
                <span class="history-range-hint">Scroll inside the table to explore</span>
              </div>
            </div>
          </section>
        </section>
      </main>
      <section class="panel output-panel">
        <div class="panel-heading output-heading"><div><span class="eyebrow">PROGRAM OUTPUT</span><h2>Console</h2></div><span id="duration" class="muted-label"></span></div>
        <section id="test-result" class="test-result hidden" aria-live="polite">
          <div class="test-result-heading"><div><span class="eyebrow">OUTPUT VERIFICATION</span><h3>Expected vs actual output</h3></div><span id="test-result-status" class="test-result-status"></span></div>
          <div class="test-output-grid">
            <div class="test-output-block"><span>Expected output</span><pre id="test-expected"></pre></div>
            <div class="test-output-block"><span>Actual output</span><pre id="test-actual"></pre></div>
          </div>
          <details class="test-input-details"><summary>Show test input (stdin)</summary><pre id="test-input"></pre></details>
          <p id="test-result-note" class="test-result-note"></p>
          <div class="test-result-actions"><button type="button" class="diagnostic-button primary" data-action="investigate-test-failure">Investigate execution</button></div>
        </section>
        <pre id="output" class="output-content">No output captured.</pre>
        <div id="exception" class="exception hidden"></div>
      </section>
      <footer class="timeline-panel">
        <div class="transport">
          <button class="icon-button" data-action="first" title="First step" aria-label="First step">|◀</button>
          <button class="icon-button" data-action="previous" title="Previous step" aria-label="Previous step">◀</button>
          <button id="play-button" class="play-button" data-action="play">▶ Play</button>
          <button class="icon-button" data-action="next" title="Next step" aria-label="Next step">▶</button>
          <button class="icon-button" data-action="last" title="Last step" aria-label="Last step">▶|</button>
        </div>
        <div class="timeline-center"><input id="timeline" type="range" min="0" max="0" value="0" step="1" aria-label="Execution timeline"><div class="timeline-labels"><span id="step-label">Step 0 / 0</span><span id="line-label">Line —</span></div></div>
        <div class="keyboard-hint">← → step · Space play</div>
      </footer>
    `;

    renderSource();
    renderHistoryHeader();
    renderHistoryRows();
    const historyScroll = document.getElementById('history-scroll');
    historyScroll.addEventListener('scroll', () => {
      if (historyScrollRestoreInProgress || !historyViewActive) return;
      renderHistoryRows();
    }, { passive: true });
    // Recalculate the virtual row window when the Runtime State panel changes
    // size (for example, when the webview is resized or the view is revealed).
    if (typeof ResizeObserver !== 'undefined') {
      const historyResizeObserver = new ResizeObserver(() => {
        if (historyViewActive) renderHistoryRows();
      });
      historyResizeObserver.observe(historyScroll);
      historyResizeObserver.observe(document.querySelector('.variables-panel'));
    }
    window.addEventListener('resize', () => {
      if (historyViewActive) renderHistoryRows();
    }, { passive: true });
    const output = document.getElementById('output');
    const outputParts = [];
    if (trace.stdout) outputParts.push(trace.stdout);
    if (trace.stderr) outputParts.push(`[stderr]\n${trace.stderr}`);
    if (trace.metadata.stdout_truncated) outputParts.push('[Trace] Standard output exceeded the capture limit (1,000,000 characters or 1 MB of JSON-encoded text). The rest was not retained, and output comparison is unavailable.');
    if (trace.metadata.stderr_truncated) outputParts.push('[Trace] Standard error exceeded the capture limit (1,000,000 characters or 1 MB of JSON-encoded text). The remainder was not retained.');
    output.textContent = outputParts.length ? outputParts.join('\n') : '(no output captured)';
    renderTestResult();
    document.getElementById('duration').textContent = `${Number(trace.metadata.duration_ms || 0).toFixed(1)} ms · Python ${trace.metadata.python_version || ''}`;

    if (trace.metadata.truncated) {
      const reason = trace.metadata.truncation_reason;
      document.getElementById('run-status').textContent = reason === 'timeout'
        ? 'Timed out · partial trace'
        : reason === 'size_limit'
          ? 'Trace size limit reached'
          : 'Event limit reached';
      document.getElementById('run-status').classList.add('warning');
    }
    if (trace.metadata.program_error) {
      const kind = trace.metadata.program_error.kind === 'syntax' ? 'Syntax Error' : 'Runtime Error';
      document.getElementById('run-status').textContent = kind;
      document.getElementById('run-status').classList.add('error');
      renderProgramError();
    } else if (Number(trace.metadata.exit_code) !== 0 && !trace.metadata.truncated) {
      document.getElementById('run-status').textContent = 'Run incomplete';
      document.getElementById('run-status').classList.add('warning');
    } else if (testResult?.status === 'passed') {
      document.getElementById('run-status').textContent = 'Test Passed';
    } else if (testResult?.status === 'failed') {
      document.getElementById('run-status').textContent = 'Output Mismatch';
      document.getElementById('run-status').classList.add('error');
    } else if (testResult?.status === 'output-truncated') {
      document.getElementById('run-status').textContent = 'Output Capture Limited';
      document.getElementById('run-status').classList.add('warning');
    }

    const slider = document.getElementById('timeline');
    slider.max = String(Math.max(0, trace.events.length - 1));
    document.getElementById('step-label').textContent = `Step ${trace.events.length ? 1 : 0} / ${trace.events.length}`;
  }

  function renderTestResult() {
    const container = document.getElementById('test-result');
    if (!container || !testResult) return;
    container.classList.remove('hidden');

    const status = document.getElementById('test-result-status');
    status.className = `test-result-status ${testResult.status}`;
    status.textContent = testResult.status === 'passed'
      ? 'Passed'
      : testResult.status === 'runtime-error'
        ? 'Runtime error'
        : testResult.status === 'incomplete'
          ? 'Execution incomplete'
        : testResult.status === 'output-truncated' ? 'Output capture limit' : 'Output mismatch';

    document.getElementById('test-expected').textContent = testResult.expected || '(empty output expected)';
    document.getElementById('test-actual').textContent = testResult.actual || '(no standard output)';
    document.getElementById('test-input').textContent = testResult.stdin || '(empty stdin)';

    const note = document.getElementById('test-result-note');
    if (testResult.status === 'passed') {
      note.textContent = trace.metadata.truncated
        ? 'The program completed and its standard output matches the expected output. The execution history was truncated at the configured event limit, so not every step is available. Line endings and final newline characters are ignored; other characters are compared exactly.'
        : 'The program completed and its standard output matches the expected output. Line endings and final newline characters are ignored; other characters are compared exactly.';
    } else if (testResult.status === 'runtime-error') {
      note.textContent = 'The program stopped with a runtime or syntax error. The actual output shown is any standard output captured before the failure. Inspect the recorded failure state and traceback below.';
    } else if (testResult.status === 'incomplete') {
      note.textContent = 'Trace stopped the program at its execution-time, event-count, or trace-size limit. The output may be incomplete, so Trace cannot mark this test as passed. The partial execution history is available for inspection.';
    } else if (testResult.status === 'output-truncated') {
      note.textContent = 'Standard output exceeded Trace’s capture limit (1,000,000 characters or 1 MB of JSON-encoded text, whichever comes first). The full output was not retained, so Trace skipped the expected-output comparison. Check how much output the program produces.';
    } else {
      note.textContent = 'The program completed, but its standard output differs from the expected output. The mismatch alone does not identify a faulty line; use the execution timeline and History Table to investigate. Line endings and final newline characters are ignored; other characters are compared exactly.';
    }

    const actions = container.querySelector('.test-result-actions');
    if (actions) actions.classList.toggle('hidden', testResult.status === 'passed');
  }

  function getProgramErrorSequence() {
    const error = trace?.metadata?.program_error;
    if (!error) return null;
    if (Number.isInteger(error.event_sequence) && error.event_sequence >= 0 && error.event_sequence < trace.events.length) {
      return error.event_sequence;
    }
    for (let index = trace.events.length - 1; index >= 0; index -= 1) {
      if (trace.events[index]?.event === 'exception_raised' || trace.events[index]?.event === 'execution_error') return index;
    }
    return trace.events.length ? trace.events.length - 1 : null;
  }

  function pathsMatch(left, right) {
    if (!left || !right) return false;
    const normalize = (value) => String(value).replaceAll('\\', '/').replace(/\/+$/, '');
    return normalize(left) === normalize(right);
  }

  function renderProgramError() {
    const error = trace?.metadata?.program_error;
    const container = document.getElementById('exception');
    if (!error || !container) return;
    container.replaceChildren();
    container.classList.remove('hidden');
    container.classList.add('diagnostic-card');

    const heading = document.createElement('div');
    heading.className = 'diagnostic-heading';
    const title = document.createElement('strong');
    title.textContent = 'Execution Diagnostics';
    const badge = document.createElement('span');
    badge.className = 'diagnostic-badge';
    badge.textContent = error.kind === 'syntax' ? 'Syntax error' : 'Runtime error';
    heading.append(title, badge);

    const errorType = document.createElement('div');
    errorType.className = 'diagnostic-type';
    errorType.textContent = error.type || 'Python error';

    const message = document.createElement('div');
    message.className = 'diagnostic-message';
    message.textContent = error.message || 'The program stopped with an error.';

    const location = document.createElement('div');
    location.className = 'diagnostic-location';
    const detail = error.location || {};
    const locationFile = detail.file || trace.metadata.script || 'Python file';
    const locationLine = Number.isInteger(detail.line) && detail.line > 0 ? `:${detail.line}` : '';
    const locationColumn = Number.isInteger(detail.column) && detail.column > 0 ? `:${detail.column}` : '';
    location.textContent = `${locationFile}${locationLine}${locationColumn}`;

    const explanation = document.createElement('p');
    explanation.className = 'diagnostic-explanation';
    if (error.kind === 'syntax' && error.state_kind === 'none') {
      explanation.textContent = 'Python could not parse this file, so execution never began. No runtime variable snapshots are available for this run.';
    } else if (error.state_kind === 'last_recorded') {
      explanation.textContent = 'The exception could not be matched to a captured exception event. Trace retained the latest available state before failure; local variables inside the failing imported module may not be available.';
    } else {
      explanation.textContent = 'Execution stopped at this uncaught exception. Trace has selected the recorded failure event so you can inspect the variables, arrays, and history at the point where it happened.';
    }

    container.append(heading, errorType, message, location);
    if (detail.source_text) {
      const source = document.createElement('pre');
      source.className = 'diagnostic-source';
      source.textContent = detail.source_text;
      container.append(source);
    }
    container.append(explanation);

    const actions = document.createElement('div');
    actions.className = 'diagnostic-actions';
    const goToFailure = document.createElement('button');
    goToFailure.type = 'button';
    goToFailure.className = 'diagnostic-button primary';
    goToFailure.dataset.action = 'go-to-failure';
    goToFailure.textContent = 'Go to failure';
    actions.append(goToFailure);
    const failureSequence = getProgramErrorSequence();
    if (failureSequence !== null && failureSequence > 0) {
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'diagnostic-button';
      previous.dataset.action = 'previous-failure-step';
      previous.textContent = 'Previous recorded step';
      actions.append(previous);
    }
    container.append(actions);

    if (error.traceback) {
      const details = document.createElement('details');
      details.className = 'diagnostic-traceback';
      const summary = document.createElement('summary');
      summary.textContent = 'Full traceback';
      const tracebackText = document.createElement('pre');
      tracebackText.textContent = error.traceback;
      details.append(summary, tracebackText);
      container.append(details);
    }
  }

  function renderHistoryHeader() {
    const head = document.getElementById('history-head');
    const meta = document.getElementById('history-meta');
    if (!head || !meta) return;
    head.replaceChildren();
    const row = document.createElement('tr');
    const fixedHeaders = [
      ['Step', 'Execution step'],
      ['Line', 'Source line'],
      ['Event', 'Recorded event type'],
    ];
    fixedHeaders.forEach(([label, title]) => {
      const cell = document.createElement('th');
      cell.textContent = label;
      cell.title = title;
      cell.scope = 'col';
      row.append(cell);
    });
    historyModel.columns.forEach((column) => {
      const cell = document.createElement('th');
      cell.textContent = column.label;
      cell.title = `${column.name} · ${column.scopeLabel}`;
      cell.scope = 'col';
      row.append(cell);
    });
    head.append(row);
    meta.textContent = `${historyModel.rows.length} steps · ${historyModel.columns.length} variables`;
  }

  function renderHistoryRows() {
    const scroll = document.getElementById('history-scroll');
    const body = document.getElementById('history-body');
    if (!scroll || !body) return;
    const preservedScrollTop = scroll.scrollTop;
    body.replaceChildren();

    const rows = historyModel.rows;
    const columns = historyModel.columns;
    const total = rows.length;
    const columnCount = columns.length + 3;
    if (!total) {
      const rangeLabel = document.getElementById('history-range-label');
      if (rangeLabel) rangeLabel.textContent = 'No recorded steps';
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = columnCount;
      emptyCell.className = 'history-empty';
      emptyCell.textContent = 'No execution events were recorded.';
      emptyRow.append(emptyCell);
      body.append(emptyRow);
      return;
    }

    // Render only the visible window. The full history remains navigable, but
    // large traces do not create thousands of table rows in the webview DOM.
    const viewportHeight = Math.max(scroll.clientHeight || 240, 160);
    const visibleCount = Math.ceil(viewportHeight / HISTORY_ROW_HEIGHT) + 10;
    // Rebuilding <tbody> can reset scrollTop in Chromium/WebKit. Use the
    // position captured before replacing rows to choose the correct window.
    const visibleStart = Math.min(total, Math.floor(preservedScrollTop / HISTORY_ROW_HEIGHT));
    const visibleEnd = Math.min(total, visibleStart + Math.max(1, Math.ceil(viewportHeight / HISTORY_ROW_HEIGHT)));
    const rangeLabel = document.getElementById('history-range-label');
    if (rangeLabel) {
      rangeLabel.replaceChildren();
      const range = document.createElement('strong');
      range.textContent = `Steps ${visibleStart + 1}–${visibleEnd} of ${total}`;
      rangeLabel.append(range);
    }
    const rangeHint = document.querySelector('.history-range-hint');
    if (rangeHint) rangeHint.hidden = visibleEnd >= total;
    const start = Math.max(0, visibleStart - 5);
    const end = Math.min(total, Math.max(start + visibleCount, visibleEnd + 5));

    if (start > 0) {
      const spacer = document.createElement('tr');
      spacer.className = 'history-spacer';
      const cell = document.createElement('td');
      cell.colSpan = columnCount;
      cell.style.height = `${start * HISTORY_ROW_HEIGHT}px`;
      spacer.append(cell);
      body.append(spacer);
    }

    for (let index = start; index < end; index += 1) {
      const historyRow = rows[index];
      const event = historyRow.event || {};
      const row = document.createElement('tr');
      row.className = `history-row${index === currentIndex ? ' selected' : ''}`;
      row.dataset.historyStep = String(index);
      row.title = `Select execution step ${index + 1}`;

      const stepCell = document.createElement('td');
      stepCell.className = 'history-step-cell';
      stepCell.textContent = String(index + 1);
      row.append(stepCell);

      const lineCell = document.createElement('td');
      lineCell.textContent = event.source && Number.isInteger(event.source.line) ? String(event.source.line) : '—';
      row.append(lineCell);

      const eventCell = document.createElement('td');
      eventCell.className = 'history-event-cell';
      eventCell.textContent = formatEvent(event);
      row.append(eventCell);

      columns.forEach((column) => {
        const cell = document.createElement('td');
        cell.className = 'history-value-cell';
        if (!historyRow.values.has(column.key)) {
          cell.textContent = '—';
          cell.classList.add('history-value-empty');
        } else {
          const display = historyRow.displayValues.get(column.key) || '—';
          cell.textContent = display;
          cell.title = display;
          if (historyRow.changedKeys.has(column.key)) cell.classList.add('history-cell-changed');
          else if (historyRow.newKeys.has(column.key)) cell.classList.add('history-cell-new');
        }
        row.append(cell);
      });
      body.append(row);
    }

    if (end < total) {
      const spacer = document.createElement('tr');
      spacer.className = 'history-spacer';
      const cell = document.createElement('td');
      cell.colSpan = columnCount;
      cell.style.height = `${(total - end) * HISTORY_ROW_HEIGHT}px`;
      spacer.append(cell);
      body.append(spacer);
    }

    // Replacing table rows may reset the native scroll position. Restore it
    // after the new virtual window is in place so the viewport stays anchored.
    if (Math.abs(scroll.scrollTop - preservedScrollTop) > 1) {
      historyScrollRestoreInProgress = true;
      scroll.scrollTop = preservedScrollTop;
      requestAnimationFrame(() => { historyScrollRestoreInProgress = false; });
    }
  }

  function setStateView(view) {
    historyViewActive = view === 'history';
    const variables = document.getElementById('variables');
    const history = document.getElementById('history-view');
    const rightColumn = document.querySelector('.right-column');
    if (rightColumn) rightColumn.classList.toggle('history-active', historyViewActive);
    document.querySelectorAll('[data-state-tab]').forEach((button) => {
      const selected = button.getAttribute('data-state-tab') === (historyViewActive ? 'history' : 'current');
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    variables.classList.toggle('hidden', historyViewActive);
    history.classList.toggle('hidden', !historyViewActive);

    if (historyViewActive) {
      const scroll = document.getElementById('history-scroll');
      // Wait for the hidden history pane to participate in layout before
      // measuring its viewport; otherwise the initial scroll can be based on
      // a zero/stale height and the virtualized rows appear misplaced.
      requestAnimationFrame(() => {
        if (!historyViewActive || !scroll.isConnected) return;
        const viewportHeight = scroll.clientHeight || 240;
        const contentHeight = historyModel.rows.length * HISTORY_ROW_HEIGHT;
        const desiredTop = currentIndex * HISTORY_ROW_HEIGHT - Math.floor(viewportHeight / 2);
        scroll.scrollTop = Math.max(0, Math.min(desiredTop, Math.max(0, contentHeight - viewportHeight)));
        renderHistoryRows();
        syncHistorySelection(false);
      });
    }
  }

  function syncHistorySelection(keepSelectedVisible) {
    if (!historyViewActive) return;
    const scroll = document.getElementById('history-scroll');
    if (!scroll) return;
    const selectedTop = currentIndex * HISTORY_ROW_HEIGHT;
    const viewportTop = scroll.scrollTop;
    const viewportBottom = viewportTop + Math.max(scroll.clientHeight, 160);
    if (keepSelectedVisible && (selectedTop < viewportTop || selectedTop + HISTORY_ROW_HEIGHT > viewportBottom)) {
      scroll.scrollTop = Math.max(0, selectedTop - Math.floor((scroll.clientHeight || 240) / 2));
      renderHistoryRows();
      return;
    }
    document.querySelectorAll('.history-row.selected').forEach((row) => row.classList.remove('selected'));
    const selected = document.querySelector(`.history-row[data-history-step="${currentIndex}"]`);
    if (selected) selected.classList.add('selected');
  }

  function renderSource() {
    const container = document.getElementById('source-code');
    container.replaceChildren();
    const fragment = document.createDocumentFragment();
    sourceLines.forEach((line, index) => {
      const row = document.createElement('div');
      row.className = 'code-line';
      row.dataset.line = String(index + 1);
      const number = document.createElement('span');
      number.className = 'line-number';
      number.textContent = String(index + 1);
      const content = document.createElement('code');
      content.textContent = line || ' ';
      row.append(number, content);
      fragment.append(row);
    });
    container.append(fragment);
  }

  function renderCurrent(options = {}) {
    if (!trace) return;
    const preservePlayback = options.preservePlayback === true;
    const wasPlaying = Boolean(playTimer);
    const button = document.getElementById('play-button');
    if (!preservePlayback) stopPlay();
    const events = trace.events;
    const event = events[currentIndex] || null;
    const total = events.length;
    const sourceBelongsToEditor = !event?.source?.file || pathsMatch(event.source.file, trace.metadata.script);
    const line = sourceBelongsToEditor ? (event?.source?.line || 0) : 0;

    document.querySelectorAll('.code-line.active').forEach((node) => node.classList.remove('active'));
    const activeLine = line > 0 ? document.querySelector(`.code-line[data-line="${line}"]`) : null;
    if (activeLine) {
      activeLine.classList.add('active');
      activeLine.scrollIntoView({ block: 'nearest' });
    }

    document.getElementById('event-kind').textContent = event ? formatEvent(event) : 'No events';
    document.getElementById('step-label').textContent = `Step ${total ? currentIndex + 1 : 0} / ${total}`;
    document.getElementById('line-label').textContent = line ? `Line ${line}` : 'Line —';
    document.getElementById('timeline').value = String(currentIndex);
    document.getElementById('timeline').max = String(Math.max(0, total - 1));
    if (button) button.disabled = total < 2 || currentIndex >= total - 1;

    const state = window.TraceState.resolveTraceState(events, currentIndex);
    renderVariables(state);
    renderVisualizations();
    syncHistorySelection(true);
    vscode.setState({ cursor: currentIndex });
    if (line > 0) vscode.postMessage({ type: 'cursorChanged', line });
    if (preservePlayback && wasPlaying && button) button.textContent = 'Ⅱ Pause';
  }

  function renderVariables(state) {
    const container = document.getElementById('variables');
    container.replaceChildren();
    const frames = Array.isArray(state.frames) ? state.frames : [];
    document.getElementById('scope-count').textContent = `${frames.length} scope${frames.length === 1 ? '' : 's'}`;
    let count = 0;

    frames.slice().reverse().forEach((frame, frameIndex) => {
      const locals = frame.locals || {};
      const names = Object.keys(locals).sort();
      if (!names.length) return;
      const group = document.createElement('div');
      group.className = 'scope-group';
      const heading = document.createElement('div');
      heading.className = 'scope-heading';
      const threadLabel = frame.thread_name && frame.thread_name !== 'MainThread' ? ` · ${frame.thread_name}` : '';
      heading.textContent = `${frame.function || '<module>'}()${frameIndex === 0 ? ' · current' : ''}${threadLabel}`;
      group.append(heading);
      names.forEach((name) => {
        count += 1;
        const row = document.createElement('div');
        row.className = 'variable-row';
        const nameElement = document.createElement('span');
        nameElement.className = 'variable-name';
        nameElement.textContent = name;
        const value = document.createElement('span');
        value.className = 'variable-value';
        const decoded = decodeValue(locals[name], state.objects || {}, new Set());
        value.textContent = formatValue(decoded);
        row.append(nameElement, value);
        group.append(row);
      });
      container.append(group);
    });

    if (!count) {
      container.classList.add('empty-state');
      container.textContent = 'No local variables at this step.';
    } else {
      container.classList.remove('empty-state');
    }
  }

  function renderArrays(state, previousState, event, options = {}) {
    const container = document.getElementById('arrays');
    if (!options.append) container.replaceChildren();
    const objects = state.objects || {};
    const previousObjects = previousState?.objects || {};
    const accessesByObject = new Map();
    (Array.isArray(event?.array_accesses) ? event.array_accesses : []).forEach((access) => {
      if (!access || typeof access.object_id !== 'string' || !Number.isInteger(access.index)) return;
      if (!accessesByObject.has(access.object_id)) accessesByObject.set(access.object_id, new Map());
      const byIndex = accessesByObject.get(access.object_id);
      const existing = byIndex.get(access.index);
      if (!existing) {
        byIndex.set(access.index, { kind: access.kind, names: new Set([access.array_name].filter(Boolean)) });
      } else {
        existing.names.add(access.array_name);
        if (existing.kind !== access.kind) existing.kind = 'read_write';
      }
    });
    const arrays = [];
    const seenRefs = new Set();

    (state.frames || []).forEach((frame) => {
      Object.entries(frame.locals || {}).forEach(([name, encoded]) => {
        if (encoded && encoded.kind === 'ref' && !seenRefs.has(encoded.id)) {
          seenRefs.add(encoded.id);
          const object = objects[encoded.id];
          if (object && object.type === 'list' && (!options.objectId || options.objectId === encoded.id)) {
            arrays.push({ name, id: encoded.id, scopeId: frame.scope_id || 'scope-unknown', node: object });
          }
        }
      });
    });

    if (!arrays.length) return 0;
    container.classList.remove('empty-state');

    arrays.forEach((array) => {
      const currentItems = Array.isArray(array.node.items) ? array.node.items : [];
      const previousNode = previousObjects[array.id];
      const previousItems = Array.isArray(previousNode?.items) ? previousNode.items : null;
      const hasPrevious = Boolean(previousItems);
      const changedIndexes = new Set();
      const activeAccesses = options.stale ? new Map() : (accessesByObject.get(array.id) || new Map());

      if (hasPrevious) {
        const sharedLength = Math.min(previousItems.length, currentItems.length);
        for (let index = 0; index < sharedLength; index += 1) {
          const before = valueSignature(previousItems[index], previousObjects, new Set());
          const after = valueSignature(currentItems[index], objects, new Set());
          if (before !== after) changedIndexes.add(index);
        }
      }

      const addedCount = hasPrevious ? Math.max(0, currentItems.length - previousItems.length) : currentItems.length;
      const removedCount = hasPrevious ? Math.max(0, previousItems.length - currentItems.length) : 0;
      const card = document.createElement('div');
      card.className = 'array-card';
      if (!hasPrevious) card.classList.add('array-card-new');

      const title = document.createElement('div');
      title.className = 'array-title';
      const icon = document.createElement('span');
      icon.className = 'array-icon';
      icon.textContent = '[]';
      const name = document.createElement('strong');
      name.textContent = array.name;
      const length = document.createElement('span');
      length.className = 'array-length';
      length.textContent = `${currentItems.length} items`;
      title.append(icon, name, length);
      appendVisualizationActions(title, options);

      const summary = document.createElement('div');
      summary.className = 'array-change-summary';
      if (!hasPrevious) {
        summary.classList.add('summary-new');
        summary.textContent = 'List first appears in this recorded state';
      } else {
        const pieces = [];
        if (changedIndexes.size) {
          pieces.push(`${changedIndexes.size} ${changedIndexes.size === 1 ? 'position differs' : 'positions differ'} from previous step`);
        }
        if (addedCount || removedCount) {
          pieces.push(`length ${previousItems.length} → ${currentItems.length}`);
        }
        if (!pieces.length) pieces.push('No indexed value changes since previous step');
        summary.textContent = pieces.join(' · ');
        if (changedIndexes.size || addedCount || removedCount) summary.classList.add('summary-changed');
      }
      if (options.stale) {
        summary.textContent = `Last observed at step ${options.lastSeenIndex + 1}. This visualization stays visible until the variable is deleted or you clear it.`;
        summary.classList.add('summary-retained');
      }

      const cells = document.createElement('div');
      cells.className = 'array-cells';
      currentItems.forEach((item, index) => {
        const cell = document.createElement('div');
        cell.className = 'array-cell';
        const cellWasAdded = hasPrevious && index >= previousItems.length;
        const cellChanged = changedIndexes.has(index);
        if (!hasPrevious || cellWasAdded) cell.classList.add('cell-added');
        else if (cellChanged) cell.classList.add('cell-changed');

        const cellValue = document.createElement('span');
        cellValue.className = 'cell-value';
        cellValue.textContent = formatValue(decodeValue(item, objects, new Set()));

        const cellIndex = document.createElement('span');
        cellIndex.className = 'cell-index';
        cellIndex.textContent = `index ${index}`;
        cell.append(cellValue, cellIndex);

        if (hasPrevious && cellChanged) {
          const beforeValue = formatValue(decodeValue(previousItems[index], previousObjects, new Set()));
          const afterValue = formatValue(decodeValue(item, objects, new Set()));
          const delta = document.createElement('span');
          delta.className = 'cell-delta';
          delta.textContent = `${beforeValue} → ${afterValue}`;
          cell.append(delta);
        } else if (cellWasAdded) {
          const delta = document.createElement('span');
          delta.className = 'cell-delta';
          delta.textContent = 'new position';
          cell.append(delta);
        } else if (!hasPrevious) {
          const delta = document.createElement('span');
          delta.className = 'cell-delta';
          delta.textContent = 'new list';
          cell.append(delta);
        }

        cells.append(cell);
      });

      card.append(title, summary);

      if (activeAccesses.size) {
        const accessSummary = document.createElement('div');
        accessSummary.className = 'array-access-summary';
        const readIndexes = [];
        const writeIndexes = [];
        activeAccesses.forEach((access, index) => {
          if (access.kind === 'read' || access.kind === 'read_write') readIndexes.push(index);
          if (access.kind === 'write' || access.kind === 'read_write') writeIndexes.push(index);
        });
        const parts = [];
        if (readIndexes.length) parts.push(`reads ${formatIndexList(readIndexes)}`);
        if (writeIndexes.length) parts.push(`targets ${formatIndexList(writeIndexes)} for writing`);
        accessSummary.textContent = `Current line: ${parts.join(' · ')}`;
        card.append(accessSummary);
      }

      currentItems.forEach((item, index) => {
        const cell = cells.children[index];
        const activeAccess = activeAccesses.get(index);
        if (!cell || !activeAccess) return;
        cell.classList.add(`cell-access-${activeAccess.kind.replace('_', '-')}`);
        const tag = document.createElement('span');
        tag.className = 'cell-access-tag';
        tag.textContent = activeAccess.kind === 'read_write'
          ? 'read + write'
          : activeAccess.kind === 'write' ? 'write target' : 'read';
        cell.append(tag);
      });

      card.append(cells);
      if (removedCount > 0) {
        const note = document.createElement('div');
        note.className = 'array-note';
        note.textContent = `${removedCount} position${removedCount === 1 ? '' : 's'} no longer present in this state.`;
        card.append(note);
      }
      if (array.node.truncated) {
        const note = document.createElement('div');
        note.className = 'array-note';
        note.textContent = `Showing first ${currentItems.length} items; trace snapshot truncated.`;
        card.append(note);
      }
      container.append(card);
    });
    return arrays.length;
  }

  function appendVisualizationActions(parent, options = {}) {
    if (!options.clearKey) return;
    const actions = document.createElement('div');
    actions.className = 'visualization-card-actions';
    if (options.stale) {
      const retained = document.createElement('span');
      retained.className = 'visualization-retained-label';
      retained.textContent = `Last seen · step ${options.lastSeenIndex + 1}`;
      actions.append(retained);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'visualization-clear-button';
    clear.dataset.clearVisualization = options.clearKey;
    clear.title = 'Clear this visualization';
    clear.setAttribute('aria-label', `Clear ${options.name || 'this'} visualization`);
    clear.textContent = '×';
    actions.append(clear);
    parent.append(actions);
  }

  function renderVisualizations() {
    const container = document.getElementById('arrays');
    container.replaceChildren();
    if (!trace || !visualizationCache) {
      container.classList.add('empty-state');
      container.textContent = 'Recognized lists, linked lists, trees, and adjacency-list graphs will appear here.';
      document.getElementById('structure-count').textContent = '0 visualizations';
      return;
    }

    const entries = visualizationCache.update(trace.events, currentIndex);
    entries.forEach((entry) => {
      const options = {
        append: true,
        objectId: entry.objectId,
        stale: entry.stale,
        lastSeenIndex: entry.lastSeenIndex,
        clearKey: entry.key,
        name: entry.name,
      };
      if (entry.type === 'array') {
        renderArrays(entry.state, entry.previousState, entry.stale ? null : entry.event, options);
      } else if (entry.type === 'linked-list') {
        renderLinkedListCard(container, entry, options);
      } else if (entry.type === 'tree') {
        renderTreeCard(container, entry, options);
      } else if (entry.type === 'graph') {
        renderGraphCard(container, entry, options);
      }
    });

    const total = container.children.length;
    document.getElementById('structure-count').textContent = `${total} visualization${total === 1 ? '' : 's'}`;
    if (!total) {
      container.classList.add('empty-state');
      container.textContent = 'Recognized lists, linked lists, trees, and adjacency-list graphs will appear here.';
    } else {
      container.classList.remove('empty-state');
    }
  }

  function structureCard(name, kind, detail, options = {}) {
    const card = document.createElement('div');
    card.className = 'structure-card';
    const heading = document.createElement('div');
    heading.className = 'structure-card-heading';
    const title = document.createElement('strong');
    title.textContent = name;
    const type = document.createElement('span');
    type.className = 'structure-type';
    type.textContent = kind;
    heading.append(title, type);
    appendVisualizationActions(heading, { ...options, name });
    const note = document.createElement('div');
    note.className = 'structure-card-note';
    note.textContent = detail;
    card.append(heading, note);
    if (options.stale) {
      const retainedNote = document.createElement('div');
      retainedNote.className = 'structure-card-note structure-retained-note';
      retainedNote.textContent = `Last observed at step ${options.lastSeenIndex + 1}. Kept visible until its variable is deleted or you clear it.`;
      card.append(retainedNote);
    }
    return card;
  }

  function renderLinkedListCard(container, list, options = {}) {
    const card = structureCard(list.name, 'Linked list', `${list.nodes.length} nodes · detected through next references`, options);
    const row = document.createElement('div');
    row.className = 'linked-list-track';
    list.nodes.forEach((node, index) => {
      const item = document.createElement('div');
      item.className = `linked-list-node${node.active ? ' node-active' : node.visited ? ' node-visited' : ''}`;
      item.textContent = node.label;
      item.title = `Node value ${node.label}`;
      row.append(item);
      if (index < list.nodes.length - 1) {
        const connector = document.createElement('span');
        connector.className = 'linked-list-arrow';
        connector.textContent = '→';
        row.append(connector);
      }
    });
    const nullEnd = document.createElement('span');
    nullEnd.className = 'linked-list-null';
    nullEnd.textContent = 'None';
    row.append(nullEnd);
    card.append(row);
    if (list.truncated) {
      const note = document.createElement('div');
      note.className = 'structure-card-note';
      note.textContent = 'The chain contains a cycle or exceeded the display limit; the visual stops before repeating nodes.';
      card.append(note);
    }
    container.append(card);
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function renderTreeCard(container, tree, options = {}) {
    const card = structureCard(tree.name, 'Binary tree', `${tree.nodeCount} nodes · detected through left/right references`, options);
    const viewport = document.createElement('div');
    viewport.className = 'structure-svg-viewport tree-viewport';
    const positions = [];
    let nodeOrder = 0;
    let maxDepth = 0;
    function place(node, depth) {
      if (!node) return null;
      maxDepth = Math.max(maxDepth, depth);
      const left = place(node.left, depth + 1);
      const current = { ...node, left: null, right: null, x: 44 + nodeOrder * 72, y: 36 + depth * 74 };
      nodeOrder += 1;
      const right = place(node.right, depth + 1);
      current.left = left;
      current.right = right;
      positions.push(current);
      return current;
    }
    const positionedRoot = place(tree.root, 0);
    const width = Math.max(280, nodeOrder * 72 + 36);
    const height = Math.max(120, (maxDepth + 1) * 74 + 52);
    const availableWidth = Math.max(220, (container.clientWidth || 520) - 28);
    const availableHeight = Math.max(150, Math.min(220, (container.clientHeight || 270) - 84));
    // Small, ordinary trees should be visible at a glance in the panel. Deep
    // or wide trees keep their natural size and scroll inside the viewport.
    const canFitTree = tree.nodeCount <= 12 && maxDepth <= 3 && width <= availableWidth;
    const scale = canFitTree ? Math.min(1, availableWidth / width, availableHeight / height) : 1;
    const displayWidth = Math.max(1, Math.round(width * scale));
    const displayHeight = Math.max(1, Math.round(height * scale));
    const svg = svgElement('svg', {
      class: 'structure-svg tree-svg',
      viewBox: `0 0 ${width} ${height}`,
      width: displayWidth,
      height: displayHeight,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': `${tree.name} binary tree`,
    });
    svg.style.width = `${displayWidth}px`;
    svg.style.height = `${displayHeight}px`;
    svg.style.maxWidth = '100%';

    function drawEdges(node, parent) {
      if (!node) return;
      if (parent) {
        svg.append(svgElement('line', {
          x1: parent.x, y1: parent.y + 19,
          x2: node.x, y2: node.y - 19,
          class: 'structure-edge tree-edge',
        }));
      }
      drawEdges(node.left, node);
      drawEdges(node.right, node);
    }
    drawEdges(positionedRoot, null);
    positions.forEach((node) => {
      const group = svgElement('g', { class: `structure-node tree-node${node.active ? ' node-active' : node.visited ? ' node-visited' : ''}` });
      const circle = svgElement('circle', { cx: node.x, cy: node.y, r: 19, class: 'tree-node-circle' });
      const text = svgElement('text', { x: node.x, y: node.y + 4, 'text-anchor': 'middle', class: 'tree-node-label' });
      text.textContent = node.label.length > 6 ? `${node.label.slice(0, 5)}…` : node.label;
      const title = svgElement('title');
      title.textContent = `Node value: ${node.label}`;
      group.append(circle, text, title);
      svg.append(group);
    });
    viewport.append(svg);
    card.append(viewport);
    if (tree.truncated) {
      const note = document.createElement('div');
      note.className = 'structure-card-note';
      note.textContent = 'The tree contains a repeated reference or exceeded the depth/node display limit.';
      card.append(note);
    }
    if (width > 620 || height > 360) {
      const note = document.createElement('div');
      note.className = 'structure-card-note';
      note.textContent = 'Scroll inside the tree view to inspect the full structure.';
      card.append(note);
    }
    container.append(card);
  }

  function renderGraphCard(container, graph, options = {}) {
    const card = structureCard(graph.name, graph.directed ? 'Directed graph' : 'Undirected graph', `${graph.nodeCount} nodes · ${graph.edgeCount} edges · adjacency-list representation`, options);
    const viewport = document.createElement('div');
    viewport.className = 'structure-svg-viewport graph-viewport';

    // A deterministic breadth-first layered layout makes small teaching graphs
    // easier to read than a tight circular layout and reduces avoidable crossings.
    const adjacency = new Map(graph.nodes.map((node) => [node.token, []]));
    graph.edges.forEach((edge) => {
      if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) return;
      adjacency.get(edge.from).push(edge.to);
      if (!graph.directed) adjacency.get(edge.to).push(edge.from);
    });
    const distance = new Map();
    const queue = [];
    const firstToken = graph.nodes[0]?.token;
    if (firstToken !== undefined) {
      distance.set(firstToken, 0);
      queue.push(firstToken);
    }
    while (queue.length) {
      const token = queue.shift();
      (adjacency.get(token) || []).forEach((next) => {
        if (distance.has(next)) return;
        distance.set(next, (distance.get(token) || 0) + 1);
        queue.push(next);
      });
    }
    const maxDistance = Math.max(0, ...distance.values());
    graph.nodes.forEach((node, index) => {
      if (!distance.has(node.token)) distance.set(node.token, maxDistance + 1);
    });
    const layers = new Map();
    graph.nodes.forEach((node) => {
      const layer = distance.get(node.token) || 0;
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(node);
    });
    const largestLayer = Math.max(1, ...[...layers.values()].map((items) => items.length));
    const width = Math.max(360, largestLayer * 84 + 72);
    const top = 24;
    const layerGap = 50;
    const height = Math.max(190, top * 2 + Math.max(0, layers.size - 1) * layerGap + 42);
    const centerX = width / 2;
    const positions = new Map();
    [...layers.entries()].sort((a, b) => a[0] - b[0]).forEach(([layerIndex, nodes]) => {
      nodes.forEach((node, index) => {
        const x = nodes.length === 1
          ? centerX
          : 36 + index * ((width - 72) / (nodes.length - 1));
        const y = top + layerIndex * layerGap;
        positions.set(node.token, { ...node, x, y });
      });
    });

    const svg = svgElement('svg', {
      class: 'structure-svg graph-svg',
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': `${graph.name} graph`,
    });
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    if (graph.directed) {
      const defs = svgElement('defs');
      const markerId = `trace-graph-arrow-${++structureSvgCounter}`;
      const marker = svgElement('marker', { id: markerId, markerWidth: 7, markerHeight: 7, refX: 5, refY: 3, orient: 'auto', markerUnits: 'strokeWidth' });
      marker.append(svgElement('path', { d: 'M0,0 L6,3 L0,6 z', class: 'structure-arrowhead' }));
      defs.append(marker);
      svg.append(defs);
      graph._markerId = markerId;
    }

    const edgeLayer = svgElement('g', { class: 'graph-edges' });
    graph.edges.forEach((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to || from === to) return;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distanceBetween = Math.max(1, Math.hypot(dx, dy));
      const offset = 20;
      const line = svgElement('line', {
        x1: from.x + dx / distanceBetween * offset,
        y1: from.y + dy / distanceBetween * offset,
        x2: to.x - dx / distanceBetween * offset,
        y2: to.y - dy / distanceBetween * offset,
        class: 'structure-edge graph-edge',
      });
      if (graph.directed) line.setAttribute('marker-end', `url(#${graph._markerId})`);
      edgeLayer.append(line);
    });
    svg.append(edgeLayer);

    // Draw every vertex as an explicit, styled node shape above the edge layer.
    positions.forEach((node) => {
      const stateClass = node.active ? ' node-active' : node.visited ? ' node-visited' : node.queued ? ' node-queued' : '';
      const group = svgElement('g', { class: `structure-node graph-node${stateClass}` });
      const circle = svgElement('circle', { cx: node.x, cy: node.y, r: 18, class: 'graph-node-circle' });
      const text = svgElement('text', { x: node.x, y: node.y + 4, 'text-anchor': 'middle', class: 'graph-node-label' });
      text.textContent = node.label.length > 5 ? `${node.label.slice(0, 4)}…` : node.label;
      const title = svgElement('title');
      title.textContent = `Node ${node.label}${node.visited ? ' · visited' : ''}${node.queued ? ' · queued' : ''}${node.active ? ' · current' : ''}`;
      group.append(circle, text, title);
      svg.append(group);
    });

    viewport.append(svg);
    card.append(viewport);
    const legend = document.createElement('div');
    legend.className = 'structure-legend';
    legend.textContent = 'Green: visited · Amber: queued · Blue: current node. Edges show the graph connections.';
    card.append(legend);
    if (width > 620 || height > 360) {
      const note = document.createElement('div');
      note.className = 'structure-card-note';
      note.textContent = 'Scroll inside the graph view to inspect all nodes and connections.';
      card.append(note);
    }
    container.append(card);
  }

  function formatIndexList(indexes) {
    const values = [...indexes].sort((a, b) => a - b).map((index) => `index ${index}`);
    if (values.length < 2) return values[0] || '';
    if (values.length === 2) return `${values[0]} and ${values[1]}`;
    return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
  }

  // Compare the serialized value represented by a list item. References are
  // expanded through the snapshot so in-place edits to nested lists are visible.
  function valueSignature(encoded, objects, seen) {
    if (!encoded || typeof encoded !== 'object') return `${typeof encoded}:${String(encoded)}`;
    if (encoded.kind === 'primitive') return `primitive:${JSON.stringify(encoded.value)}`;
    if (encoded.kind === 'opaque') return `opaque:${encoded.type || 'object'}`;
    if (encoded.kind !== 'ref') return JSON.stringify(encoded);

    const id = encoded.id;
    if (!id) return 'ref:missing-id';
    if (seen.has(id)) return `circular:${id}`;
    const node = objects[id];
    if (!node) return `unavailable:${id}`;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    if (Array.isArray(node.items)) {
      return `${node.type || 'sequence'}:[${node.items.map((item) => valueSignature(item, objects, nextSeen)).join('|')}]`;
    }
    if (Array.isArray(node.entries)) {
      return `${node.type || 'mapping'}:{${node.entries.map((entry) => `${valueSignature(entry.key, objects, nextSeen)}=${valueSignature(entry.value, objects, nextSeen)}`).join('|')}}`;
    }
    return `ref:${id}:${node.type || 'object'}`;
  }

  function decodeValue(encoded, objects, seen) {
    if (!encoded || typeof encoded !== 'object') return encoded;
    if (encoded.kind === 'primitive') return encoded.value;
    if (encoded.kind === 'opaque') return `<${encoded.type || 'object'} instance>`;
    if (encoded.kind !== 'ref') return encoded;
    const id = encoded.id;
    if (!id || seen.has(id)) return '[Circular]';
    const node = objects[id];
    if (!node) return '[Unavailable]';
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    if (Array.isArray(node.items)) return node.items.map((item) => decodeValue(item, objects, nextSeen));
    if (Array.isArray(node.entries)) {
      return node.entries.map((entry) => [decodeValue(entry.key, objects, nextSeen), decodeValue(entry.value, objects, nextSeen)]);
    }
    return `<${node.type || 'object'}>`;
  }

  function formatValue(value) {
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === undefined) return 'undefined';
    if (value === null) return 'None';
    if (Array.isArray(value)) {
      const preview = value.slice(0, 5).map(formatValue).join(', ');
      return `[${preview}${value.length > 5 ? ', …' : ''}]`;
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function formatEvent(event) {
    if (event?.event === 'function_returned' && event.function === '<module>') {
      return 'Execution Finished';
    }
    if (event?.event === 'line_executed') return 'Before Line Execution';
    return String(event?.event || 'event').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function findEventForLine(line) {
    const candidates = trace.events;
    for (let index = currentIndex; index < candidates.length; index += 1) {
      if (candidates[index].source?.line === line && (!candidates[index].source?.file || pathsMatch(candidates[index].source.file, trace.metadata.script))) return index;
    }
    for (let index = 0; index < currentIndex; index += 1) {
      if (candidates[index].source?.line === line && (!candidates[index].source?.file || pathsMatch(candidates[index].source.file, trace.metadata.script))) return index;
    }
    return -1;
  }

  function seek(index) {
    if (!trace || !trace.events.length) return;
    currentIndex = Math.max(0, Math.min(index, trace.events.length - 1));
    renderCurrent();
  }

  function step(amount) {
    if (!trace) return;
    seek(currentIndex + amount);
  }

  function togglePlay() {
    if (playTimer) {
      stopPlay();
      return;
    }
    if (!trace || currentIndex >= trace.events.length - 1) return;
    const button = document.getElementById('play-button');
    button.textContent = 'Ⅱ Pause';
    button.dataset.action = 'play';
    playTimer = setInterval(() => {
      if (currentIndex >= trace.events.length - 1) {
        stopPlay();
        return;
      }
      currentIndex += 1;
      renderCurrent({ preservePlayback: true });
    }, 650);
  }

  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    const button = document.getElementById('play-button');
    if (button) button.textContent = '▶ Play';
  }


  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  vscode.postMessage({ type: 'ready' });
})();
