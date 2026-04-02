const backendSelect = document.getElementById("backend-select");
const backendSupportNode = document.getElementById("backend-support");
const runtimeStatusNode = document.getElementById("runtime-status");
const heroMetaNode = document.getElementById("hero-meta");
const modeToggle = document.getElementById("mode-toggle");
const generatePanel = document.getElementById("generate-panel");
const uploadPanel = document.getElementById("upload-panel");
const requestHintNode = document.getElementById("request-hint");
const runButton = document.getElementById("run-button");
const runStatusNode = document.getElementById("run-status");
const summaryPanel = document.getElementById("summary-panel");
const fileInput = document.getElementById("file-input");
const fileNameNode = document.getElementById("file-name");
const scriptEditor = document.getElementById("script-editor");
const logView = document.getElementById("log-view");
const chartCanvas = document.getElementById("trace-chart");
const plotSelect = document.getElementById("plot-select");
const builderTitleNode = document.querySelector(".builder-panel h2");
const builderNoteNode = document.querySelector(".builder-panel .section-note");

const state = {
  info: null,
  mode: "generate",
  result: null,
  selectedLog: "summary",
  uploadedFileName: null,
  previewScript: "",
  previewDirty: false,
  uploadDraft: "",
  selectedPlotId: null,
};

const formFields = {
  neurons: document.getElementById("neurons-input"),
  duration_ms: document.getElementById("duration-input"),
  excitatory_ratio: document.getElementById("excitatory-ratio-input"),
  connection_probability: document.getElementById("connection-probability-input"),
  integration_method: document.getElementById("integration-method-input"),
  monitor_population: document.getElementById("monitor-population-input"),
  taum_ms: document.getElementById("taum-input"),
  taue_ms: document.getElementById("taue-input"),
  taui_ms: document.getElementById("taui-input"),
  refractory_ms: document.getElementById("refractory-input"),
  threshold_mv: document.getElementById("threshold-input"),
  reset_mv: document.getElementById("reset-input"),
  resting_mv: document.getElementById("resting-input"),
  excitatory_weight_mv: document.getElementById("excitatory-weight-input"),
  inhibitory_weight_mv: document.getElementById("inhibitory-weight-input"),
};

let previewTimer = null;

async function loadInfo() {
  const response = await fetch("/api/info");
  if (!response.ok) {
    throw new Error("Failed to load runtime information.");
  }
  state.info = await response.json();
}

function getGenerateConfig() {
  return Object.fromEntries(Object.entries(formFields).map(([key, node]) => [key, node.value]));
}

async function refreshPreview() {
  if (state.mode !== "generate" || state.previewDirty) {
    return;
  }

  const response = await fetch("/api/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generate: getGenerateConfig() }),
  });

  if (!response.ok) {
    throw new Error("Failed to generate the CUBA preview script.");
  }

  const data = await response.json();
  state.previewScript = data.script_source;
  scriptEditor.value = data.script_source;
}

function schedulePreviewRefresh() {
  state.previewDirty = false;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    refreshPreview().catch((error) => {
      runStatusNode.textContent = error.message;
    });
  }, 180);
}

function bindGenerateControls() {
  Object.values(formFields).forEach((node) => {
    node.addEventListener("input", schedulePreviewRefresh);
    node.addEventListener("change", schedulePreviewRefresh);
  });
}

function initBackendSelect() {
  const support = state.info.backend_support;
  backendSelect.innerHTML = Object.entries(support)
    .map(([backend, meta]) => {
      const label = meta.supported ? backend : `${backend} unavailable`;
      return `<option value="${backend}" ${meta.supported ? "" : "disabled"}>${label}</option>`;
    })
    .join("");

  const firstSupported = Object.entries(support).find(([, meta]) => meta.supported);
  if (firstSupported) {
    backendSelect.value = firstSupported[0];
  }

  backendSelect.addEventListener("change", () => {
    renderBackendSupport();
    renderHeroMeta();
  });
  renderBackendSupport();
}

function renderRuntimeStatus() {
  const available = Object.entries(state.info.backend_support)
    .filter(([, meta]) => meta.supported)
    .map(([name]) => name);

  runtimeStatusNode.innerHTML = `
    <article class="runtime-item">
      <strong>Python ${state.info.python}</strong>
      <span>The local interpreter that executes scripts from the browser.</span>
    </article>
    <article class="runtime-item">
      <strong>${available.length} backend${available.length === 1 ? "" : "s"} available</strong>
      <span>${available.length ? available.join(", ") : "No supported backend detected."}</span>
    </article>
    <article class="runtime-item">
      <strong>Structured result support</strong>
      <span>Generated scripts emit RESULT_JSON. Uploaded scripts can do the same.</span>
    </article>
  `;
}

function renderHeroMeta() {
  const selected = backendSelect.value || "n/a";
  heroMetaNode.innerHTML = `
    <article class="hero-chip">
      <strong>Mode</strong>
      <span>${state.mode === "generate" ? "Configurable CUBA template" : "Uploaded or pasted Python"}</span>
    </article>
    <article class="hero-chip">
      <strong>Backend</strong>
      <span>${selected}</span>
    </article>
    <article class="hero-chip">
      <strong>Execution</strong>
      <span>Local machine only</span>
    </article>
  `;
}

function renderBackendSupport() {
  const selected = backendSelect.value;
  backendSupportNode.innerHTML = Object.entries(state.info.backend_support)
    .map(([backend, meta]) => {
      const statusClass = meta.supported ? "status-good" : "status-bad";
      const detail = meta.supported ? "Ready to run." : meta.reason || "Unavailable.";
      const selectedCopy = backend === selected ? "Selected." : "";
      return `
        <article class="status-item">
          <strong class="${statusClass}">${backend}</strong>
          <span>${detail} ${selectedCopy}</span>
        </article>
      `;
    })
    .join("");
}

function bindModeToggle() {
  modeToggle.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      renderMode();
      renderHeroMeta();
    });
  });
}

function renderMode() {
  modeToggle.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });

  generatePanel.classList.toggle("hidden", state.mode !== "generate");
  uploadPanel.classList.toggle("hidden", state.mode !== "upload");
  generatePanel.hidden = state.mode !== "generate";
  uploadPanel.hidden = state.mode !== "upload";
  requestHintNode.textContent =
    state.mode === "generate"
      ? "Use the controls, then refine the generated CUBA code manually if you need to."
      : "Upload a script or paste one into the editor, then run it with the selected backend.";

  if (state.mode === "generate") {
    builderTitleNode.textContent = "CUBA controls";
    builderNoteNode.textContent = "Dropdowns and manual input feed the same generated script.";
    if (!state.previewDirty) {
      refreshPreview().catch((error) => {
        runStatusNode.textContent = error.message;
      });
    }
    return;
  }

  builderTitleNode.textContent = "Upload a Python script";
  builderNoteNode.textContent = "Choose a file or paste code into the editor, then run it locally.";

  if (!state.uploadDraft.trim()) {
    scriptEditor.value = [
      "# Paste a Brian script here or use the file picker on the left.",
      "# For richer UI output, print RESULT_JSON plus a JSON payload.",
      "",
      "from brian2 import *",
      "",
      "# Your simulation code...",
    ].join("\n");
  }
}

function bindEditor() {
  scriptEditor.addEventListener("input", () => {
    if (state.mode === "generate") {
      state.previewDirty = true;
      runStatusNode.textContent = "Preview script edited manually.";
      return;
    }

    state.uploadDraft = scriptEditor.value;
  });
}

function bindUploadInput() {
  fileInput.addEventListener("change", async () => {
    const [file] = fileInput.files;
    if (!file) {
      state.uploadedFileName = null;
      fileNameNode.textContent = "Drop or choose a Python file";
      return;
    }

    state.uploadedFileName = file.name;
    fileNameNode.textContent = file.name;
    scriptEditor.value = await file.text();
    state.uploadDraft = scriptEditor.value;
    runStatusNode.textContent = `${file.name} loaded into the editor.`;
  });
}

function bindLogTabs() {
  document.querySelectorAll("[data-log-target]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedLog = button.dataset.logTarget;
      renderLogs();
    });
  });
}

function buildRunPayload() {
  if (state.mode === "generate") {
    return {
      mode: "generate",
      backend: backendSelect.value,
      generate: getGenerateConfig(),
      script_source_override: scriptEditor.value,
    };
  }

  return {
    mode: "upload",
    backend: backendSelect.value,
    filename: state.uploadedFileName || "pasted_simulation.py",
    script_source: scriptEditor.value,
  };
}

async function runSimulation() {
  runButton.disabled = true;
  runStatusNode.textContent = "Running simulation locally...";

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRunPayload()),
    });
    const data = await response.json();
    state.result = data;
    state.selectedLog = data.ok ? "summary" : "stderr";
    renderSummary();
    renderLogs();
    renderPlotSelector();
    drawChart();
    runStatusNode.textContent = data.ok ? "Simulation complete." : "Simulation failed.";
  } catch (error) {
    state.result = {
      ok: false,
      error: error.message,
      stdout: "",
      stderr: error.stack || error.message,
      result: null,
    };
    renderSummary();
    renderLogs();
    renderPlotSelector();
    drawChart();
    runStatusNode.textContent = "Simulation failed.";
  } finally {
    runButton.disabled = false;
  }
}

function formatSeconds(value) {
  return typeof value === "number" ? `${value.toFixed(3)}s` : "n/a";
}

function formatCount(value) {
  return typeof value === "number" ? value.toLocaleString() : "n/a";
}

function normalizePlotEntry(plot, fallbackId, fallbackTitle) {
  if (!plot || typeof plot !== "object" || Array.isArray(plot)) {
    return null;
  }

  const rawY = Array.isArray(plot.y) ? plot.y : Array.isArray(plot.values) ? plot.values : null;
  if (!rawY?.length) {
    return null;
  }

  const y = rawY.map((value) => Number(value));
  if (y.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const type = ["line", "scatter", "bar"].includes(plot.type) ? plot.type : "line";
  const rawX = Array.isArray(plot.x) ? plot.x : Array.isArray(plot.labels) ? plot.labels : null;

  if (rawX && rawX.length !== y.length) {
    return null;
  }

  if (type === "bar") {
    const categories = (rawX || y.map((_, index) => index + 1)).map((value) => String(value));
    return {
      id: String(plot.id || fallbackId),
      title: String(plot.title || fallbackTitle || fallbackId),
      type,
      x: categories,
      y,
      xLabel: String(plot.x_label || plot.xLabel || "Category"),
      yLabel: String(plot.y_label || plot.yLabel || "Value"),
    };
  }

  let x = rawX ? rawX.map((value) => Number(value)) : y.map((_, index) => index);
  if (x.some((value) => !Number.isFinite(value))) {
    x = y.map((_, index) => index);
  }

  return {
    id: String(plot.id || fallbackId),
    title: String(plot.title || fallbackTitle || fallbackId),
    type,
    x,
    y,
    xLabel: String(plot.x_label || plot.xLabel || "X"),
    yLabel: String(plot.y_label || plot.yLabel || "Y"),
  };
}

function getAvailablePlots(payload) {
  const plots = [];
  const source = payload?.plots;

  if (Array.isArray(source?.charts)) {
    source.charts.forEach((plot, index) => {
      const normalized = normalizePlotEntry(plot, plot?.id || `plot-${index + 1}`, `Plot ${index + 1}`);
      if (normalized) {
        plots.push(normalized);
      }
    });
  }

  if (source && typeof source === "object") {
    Object.entries(source).forEach(([key, value]) => {
      if (key === "charts" || key === "voltage_trace_mv" || key === "time_ms") {
        return;
      }
      const normalized = normalizePlotEntry(value, key, key.replaceAll("_", " "));
      if (normalized) {
        plots.push(normalized);
      }
    });
  }

  const trace = source?.voltage_trace_mv;
  const time = source?.time_ms;
  if (Array.isArray(trace) && Array.isArray(time) && trace.length && trace.length === time.length) {
    plots.unshift({
      id: "voltage-trace",
      title: "Voltage trace",
      type: "line",
      x: time.map((value) => Number(value)),
      y: trace.map((value) => Number(value)),
      xLabel: "Time (ms)",
      yLabel: "Voltage (mV)",
    });
  }

  return plots.filter((plot, index, items) => items.findIndex((item) => item.id === plot.id) === index);
}

function getSelectedPlot(payload) {
  const plots = getAvailablePlots(payload);
  if (!plots.length) {
    state.selectedPlotId = null;
    return null;
  }

  if (!plots.some((plot) => plot.id === state.selectedPlotId)) {
    state.selectedPlotId = plots[0].id;
  }

  return plots.find((plot) => plot.id === state.selectedPlotId) || plots[0];
}

function renderPlotSelector() {
  const plots = getAvailablePlots(state.result?.result);
  if (!plots.length) {
    plotSelect.innerHTML = `<option value="">No plots available</option>`;
    plotSelect.disabled = true;
    return;
  }

  if (!plots.some((plot) => plot.id === state.selectedPlotId)) {
    state.selectedPlotId = plots[0].id;
  }

  plotSelect.disabled = plots.length === 1;
  plotSelect.innerHTML = plots
    .map(
      (plot) =>
        `<option value="${plot.id}" ${plot.id === state.selectedPlotId ? "selected" : ""}>${plot.title}</option>`
    )
    .join("");
}

function bindPlotSelect() {
  plotSelect.addEventListener("change", () => {
    state.selectedPlotId = plotSelect.value || null;
    drawChart();
  });
}

function getPrimarySpikeCount(summary) {
  return summary.spike_count ?? summary.total_spikes ?? null;
}

function getResultHeadline(result, payload, summary) {
  if (!result.ok) {
    return "Run failed";
  }
  if (typeof getPrimarySpikeCount(summary) === "number") {
    return `${formatCount(getPrimarySpikeCount(summary))} spikes recorded`;
  }
  if (getAvailablePlots(payload).length) {
    return "Structured plot ready";
  }
  return "Run completed";
}

function getResultNarrative(result, payload, summary) {
  if (!result.ok) {
    return result.error || "The simulation did not complete successfully.";
  }

  const facts = [];
  if (summary.neurons) {
    facts.push(`${formatCount(summary.neurons)} neurons`);
  }
  if (summary.duration_ms) {
    facts.push(`${summary.duration_ms} ms simulated`);
  }
  if (summary.monitor_population) {
    facts.push(`monitoring ${summary.monitor_population}`);
  }

  const factText = facts.length ? `${facts.join(", ")}.` : "The simulation completed successfully.";

  if (typeof getPrimarySpikeCount(summary) === "number") {
    return `${factText} Recorded ${formatCount(getPrimarySpikeCount(summary))} spikes.`;
  }

  if (payload.notes?.length) {
    return `${factText} ${payload.notes.join(" ")}`;
  }

  return factText;
}

function buildReadableResult(result) {
  if (!result) {
    return "No execution output yet.";
  }

  const payload = result.result || {};
  const summary = payload.summary || {};
  const lines = [];

  lines.push(result.ok ? "Simulation finished successfully." : "Simulation failed.");
  lines.push(`Mode: ${result.mode || state.mode}`);
  lines.push(`Backend: ${result.backend || "n/a"}`);
  lines.push(`Script: ${result.script_name || "n/a"}`);
  lines.push(`Runtime: ${formatSeconds(result.runtime_seconds)}`);

  if (payload.title) {
    lines.push(`Result title: ${payload.title}`);
  }

  const spikeCount = getPrimarySpikeCount(summary);
  if (typeof summary.neurons === "number") {
    lines.push(`Network size: ${formatCount(summary.neurons)} neurons`);
  }
  if (typeof summary.duration_ms === "number") {
    lines.push(`Simulated duration: ${summary.duration_ms} ms`);
  }
  if (typeof spikeCount === "number") {
    lines.push(`Recorded spikes: ${formatCount(spikeCount)}`);
  }
  if (typeof summary.simulation_seconds === "number") {
    lines.push(`Inner Brian run time: ${summary.simulation_seconds.toFixed(3)}s`);
  }
  if (summary.monitor_population) {
    lines.push(`Monitored population: ${summary.monitor_population}`);
  }
  if (typeof summary.connection_probability === "number") {
    lines.push(`Connection probability: ${summary.connection_probability}`);
  }

  if (payload.notes?.length) {
    lines.push("");
    lines.push("Notes:");
    payload.notes.forEach((note) => lines.push(`- ${note}`));
  }

  if (!result.ok && result.error) {
    lines.push("");
    lines.push("Error:");
    lines.push(result.error);
  }

  if (result.artifacts_dir) {
    lines.push("");
    lines.push(`Artifacts directory: ${result.artifacts_dir}`);
  }

  return lines.join("\n");
}

function renderSummary() {
  if (!state.result) {
    summaryPanel.innerHTML = `
      <article class="metric-card featured">
        <span class="metric-label">Studio status</span>
        <strong class="metric-value">Ready to test</strong>
        <span class="metric-copy">Tune the CUBA template or load a Python file, then run it without leaving this screen.</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">Template</span>
        <strong class="metric-value">CUBA</strong>
        <span class="metric-copy">Generated mode starts from the Brian CUBA example structure.</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">Script editor</span>
        <strong class="metric-value">Live</strong>
        <span class="metric-copy">The preview is editable, so dropdowns and manual code edits coexist.</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">Backends</span>
        <strong class="metric-value">${Object.values(state.info.backend_support).filter((item) => item.supported).length}</strong>
        <span class="metric-copy">Only supported backends can be selected for execution.</span>
      </article>
    `;
    return;
  }

  const payload = state.result.result || {};
  const summary = payload.summary || {};
  const title = payload.title || (state.result.ok ? "Simulation completed" : "Simulation failed");
  const notes = payload.notes?.join(" ") || state.result.error || "No extra notes.";
  const spikeCount = getPrimarySpikeCount(summary);
  const plotCount = getAvailablePlots(payload).length;

  summaryPanel.innerHTML = `
    <article class="metric-card featured">
      <span class="metric-label">Outcome</span>
      <strong class="metric-value">${getResultHeadline(state.result, payload, summary)}</strong>
      <span class="metric-copy">${getResultNarrative(state.result, payload, summary)}</span>
    </article>
    <article class="metric-card">
      <span class="metric-label">Backend</span>
      <strong class="metric-value">${state.result.backend || "n/a"}</strong>
      <span class="metric-copy">${title}</span>
    </article>
    <article class="metric-card">
      <span class="metric-label">Runtime</span>
      <strong class="metric-value">${formatSeconds(state.result.runtime_seconds)}</strong>
      <span class="metric-copy">Measured around the full local subprocess run.</span>
    </article>
    <article class="metric-card">
      <span class="metric-label">${plotCount ? "Plots" : "Notes"}</span>
      <strong class="metric-value">${plotCount ? formatCount(plotCount) : formatCount(spikeCount)}</strong>
      <span class="metric-copy">${plotCount ? "Structured plot data was returned for this run." : notes}</span>
    </article>
  `;
}

function renderLogs() {
  document.querySelectorAll("[data-log-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.logTarget === state.selectedLog);
  });

  if (!state.result) {
    logView.textContent = "No execution output yet.";
    return;
  }

  if (state.selectedLog === "summary") {
    logView.textContent = buildReadableResult(state.result);
    return;
  }

  if (state.selectedLog === "payload") {
    logView.textContent = JSON.stringify(
      state.result.result || { message: state.result.error || "No parsed result." },
      null,
      2
    );
    return;
  }

  if (state.selectedLog === "stdout") {
    logView.textContent = state.result.stdout || "No stdout output.";
    return;
  }

  logView.textContent = state.result.stderr || "No stderr output.";
}

function drawChart() {
  const ctx = chartCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = chartCanvas.clientWidth || 900;
  const height = Math.round(width * 0.38);
  chartCanvas.width = Math.round(width * dpr);
  chartCanvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "#fff8ef";
  ctx.fillRect(0, 0, width, height);
  const plot = getSelectedPlot(state.result?.result);
  if (!plot) {
    ctx.fillStyle = "#6d797f";
    ctx.font = "16px Palatino Linotype";
    ctx.fillText("No structured plot returned for this run.", 28, 42);
    ctx.font = "14px Palatino Linotype";
    ctx.fillText("Return RESULT_JSON with plots.charts to draw custom plots.", 28, 68);
    return;
  }

  const padding = { top: 28, right: 26, bottom: 54, left: 62 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  ctx.fillStyle = "#4f5d65";
  ctx.font = "15px Palatino Linotype";
  ctx.fillText(plot.title, padding.left, 16);

  if (plot.type === "bar") {
    const maxY = Math.max(...plot.y, 0);
    const spanY = Math.max(1, maxY);
    const barWidth = plotWidth / Math.max(plot.y.length, 1);
    const yFor = (value) => padding.top + plotHeight - (value / spanY) * plotHeight;

    ctx.strokeStyle = "rgba(28, 39, 48, 0.1)";
    ctx.lineWidth = 1;
    for (let tick = 0; tick <= 4; tick += 1) {
      const yValue = (spanY / 4) * tick;
      const y = yFor(yValue);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotWidth, y);
      ctx.stroke();
      ctx.fillStyle = "#69767c";
      ctx.font = "13px Palatino Linotype";
      ctx.fillText(yValue.toFixed(1), 14, y + 4);
    }

    ctx.strokeStyle = "#24323a";
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotHeight);
    ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
    ctx.stroke();

    ctx.fillStyle = "#de7649";
    plot.y.forEach((value, index) => {
      const x = padding.left + index * barWidth + barWidth * 0.15;
      const y = yFor(value);
      const h = padding.top + plotHeight - y;
      ctx.fillRect(x, y, Math.max(2, barWidth * 0.7), h);
    });

    ctx.fillStyle = "#4f5d65";
    ctx.font = "14px Palatino Linotype";
    ctx.fillText(plot.yLabel, padding.left, 34);
    ctx.fillText(plot.xLabel, width - 110, height - 12);
    return;
  }

  const minX = Math.min(...plot.x);
  const maxX = Math.max(...plot.x);
  const minY = Math.min(...plot.y);
  const maxY = Math.max(...plot.y);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const xFor = (value) => padding.left + ((value - minX) / spanX) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - ((value - minY) / spanY) * plotHeight;

  ctx.strokeStyle = "rgba(28, 39, 48, 0.1)";
  ctx.lineWidth = 1;
  for (let tick = 0; tick <= 4; tick += 1) {
    const yValue = minY + (spanY / 4) * tick;
    const y = yFor(yValue);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotWidth, y);
    ctx.stroke();
    ctx.fillStyle = "#69767c";
    ctx.font = "13px Palatino Linotype";
    ctx.fillText(yValue.toFixed(1), 14, y + 4);
  }

  ctx.strokeStyle = "#24323a";
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotHeight);
  ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
  ctx.stroke();

  ctx.fillStyle = "#4f5d65";
  ctx.font = "13px Palatino Linotype";
  ctx.fillText(minX.toFixed(1), padding.left, height - 20);
  ctx.fillText(maxX.toFixed(1), width - padding.right - 24, height - 20);

  if (plot.type === "scatter") {
    ctx.fillStyle = "#de7649";
    plot.y.forEach((value, index) => {
      ctx.beginPath();
      ctx.arc(xFor(plot.x[index]), yFor(value), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  } else {
    ctx.strokeStyle = "#de7649";
    ctx.lineWidth = 3;
    ctx.beginPath();
    plot.y.forEach((value, index) => {
      const x = xFor(plot.x[index]);
      const y = yFor(value);
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  ctx.fillStyle = "#4f5d65";
  ctx.font = "14px Palatino Linotype";
  ctx.fillText(plot.yLabel, padding.left, 34);
  ctx.fillText(plot.xLabel, width - 110, height - 12);
}

function initEditorState() {
  scriptEditor.value = "# Loading CUBA template...";
}

async function init() {
  try {
    initEditorState();
    await loadInfo();
    renderRuntimeStatus();
    initBackendSelect();
    renderHeroMeta();
    bindModeToggle();
    bindGenerateControls();
    bindUploadInput();
    bindLogTabs();
    bindEditor();
    bindPlotSelect();
    renderMode();
    renderSummary();
    renderLogs();
    renderPlotSelector();
    drawChart();
    await refreshPreview();
    runButton.addEventListener("click", runSimulation);
    window.addEventListener("resize", drawChart);
  } catch (error) {
    summaryPanel.innerHTML = `<div class="empty-state">Failed to initialize the interface: ${error.message}</div>`;
  }
}

init();
