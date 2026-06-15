#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_SCENARIOS, CUBA_DEFAULTS, CUBA_EQUATIONS, SUPPORTED_BACKENDS, checkBackendSupport } from "./common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname);
const RESULTS_DIR = join(PROJECT_ROOT, "results");
const LATEST_RESULTS = join(RESULTS_DIR, "latest.json");
const DEFAULT_NEURON_COUNTS = [1000, 4000, 8000];
const ALL_BACKENDS = SUPPORTED_BACKENDS;
const ALL_SCENARIOS = Object.keys(BENCHMARK_SCENARIOS);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    neurons: DEFAULT_NEURON_COUNTS,
    durationMs: 300,
    repeats: 2,
    backends: ALL_BACKENDS,
    scenarios: ALL_SCENARIOS,
    singleRun: false,
    backend: null,
    scenario: null,
    output: LATEST_RESULTS,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--neurons":
        const vals = [];
        while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          vals.push(parseInt(args[++i], 10));
        }
        opts.neurons = vals.length ? vals : DEFAULT_NEURON_COUNTS;
        break;
      case "--duration-ms":
        opts.durationMs = parseInt(args[++i], 10);
        break;
      case "--repeats":
        opts.repeats = parseInt(args[++i], 10);
        break;
      case "--backends":
        const bs = [];
        while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          bs.push(args[++i]);
        }
        opts.backends = bs.length ? bs : ALL_BACKENDS;
        break;
      case "--scenarios":
        const sc = [];
        while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          sc.push(args[++i]);
        }
        opts.scenarios = sc.length ? sc : ALL_SCENARIOS;
        break;
      case "--single-run":
        opts.singleRun = true;
        break;
      case "--backend":
        opts.backend = args[++i];
        break;
      case "--scenario":
        opts.scenario = args[++i];
        break;
      case "--output":
        opts.output = args[++i];
        break;
    }
  }

  return opts;
}

function buildBenchmarkScript(backend, scenario, neuronCount, durationMs) {
  const excitatoryCount = Math.max(1, Math.round(neuronCount * CUBA_DEFAULTS.excitatory_ratio));
  const inhibitoryCount = Math.max(0, neuronCount - excitatoryCount);
  const we = CUBA_DEFAULTS.excitatory_weight_mv;
  const wi = CUBA_DEFAULTS.inhibitory_weight_mv;
  const connProb = CUBA_DEFAULTS.connection_probability;

  let networkCode;

  if (scenario === "subgroups") {
    networkCode = `
neurons = NeuronGroup(
    ${neuronCount}, eqs,
    threshold="v > vt", reset="v = vr",
    refractory=${CUBA_DEFAULTS.refractory_ms} * ms,
    method="${CUBA_DEFAULTS.integration_method}",
    namespace=ns,
)
neurons.v = "vr + rand() * (vt - vr)"
neurons.ge = 0 * mV
neurons.gi = 0 * mV

excitatory = neurons[:${excitatoryCount}]
inhibitory = neurons[${excitatoryCount}:]

exc_syn = Synapses(excitatory, neurons, on_pre="ge += we", namespace={"we": ${we} * mV})
exc_syn.connect(p=${connProb})

if len(inhibitory):
    inh_syn = Synapses(inhibitory, neurons, on_pre="gi += wi", namespace={"wi": ${wi} * mV})
    inh_syn.connect(p=${connProb})

monitors = [SpikeMonitor(neurons)]
`;
  } else {
    networkCode = `
excitatory = NeuronGroup(
    ${excitatoryCount}, eqs,
    threshold="v > vt", reset="v = vr",
    refractory=${CUBA_DEFAULTS.refractory_ms} * ms,
    method="${CUBA_DEFAULTS.integration_method}",
    namespace=ns,
)
excitatory.v = "vr + rand() * (vt - vr)"
excitatory.ge = 0 * mV
excitatory.gi = 0 * mV

monitors = [SpikeMonitor(excitatory)]

${inhibitoryCount > 0 ? `
inhibitory = NeuronGroup(
    ${inhibitoryCount}, eqs,
    threshold="v > vt", reset="v = vr",
    refractory=${CUBA_DEFAULTS.refractory_ms} * ms,
    method="${CUBA_DEFAULTS.integration_method}",
    namespace=ns,
)
inhibitory.v = "vr + rand() * (vt - vr)"
inhibitory.ge = 0 * mV
inhibitory.gi = 0 * mV
monitors.append(SpikeMonitor(inhibitory))

s1 = Synapses(excitatory, excitatory, on_pre="ge += we", namespace={"we": ${we} * mV})
s1.connect(p=${connProb})
s2 = Synapses(excitatory, inhibitory, on_pre="ge += we", namespace={"we": ${we} * mV})
s2.connect(p=${connProb})
s3 = Synapses(inhibitory, excitatory, on_pre="gi += wi", namespace={"wi": ${wi} * mV})
s3.connect(p=${connProb})
s4 = Synapses(inhibitory, inhibitory, on_pre="gi += wi", namespace={"wi": ${wi} * mV})
s4.connect(p=${connProb})
` : `
s1 = Synapses(excitatory, excitatory, on_pre="ge += we", namespace={"we": ${we} * mV})
s1.connect(p=${connProb})
`}
`;
  }

  return `
import json
import os
import sys
import time

os.environ["SIM_BACKEND"] = "${backend}"

from brian2 import *

if "${backend}" == "numpy":
    prefs.codegen.target = "numpy"

start_scope()

taum = ${CUBA_DEFAULTS.taum_ms} * ms
taue = ${CUBA_DEFAULTS.taue_ms} * ms
taui = ${CUBA_DEFAULTS.taui_ms} * ms
vt = ${CUBA_DEFAULTS.threshold_mv} * mV
vr = ${CUBA_DEFAULTS.reset_mv} * mV
el = ${CUBA_DEFAULTS.resting_mv} * mV
ns = {"taum": taum, "taue": taue, "taui": taui, "el": el, "vt": vt, "vr": vr}

eqs = """
${CUBA_EQUATIONS}
"""

${networkCode}

if "${backend}" != "numpy":
    set_device("${backend}", directory="./build", build_on_run=True)

started = time.perf_counter()
run(${durationMs} * ms)
elapsed = time.perf_counter() - started

total_spikes = sum(int(m.num_spikes) for m in monitors)

print(json.dumps({
    "scenario": "${scenario}",
    "backend": "${backend}",
    "neuron_count": ${neuronCount},
    "duration_ms": ${durationMs},
    "runtime_seconds": round(elapsed, 6),
    "success": True,
    "spike_count": total_spikes,
    "error": None
}))
`.trim() + "\n";
}

function runSingleBackend(backend, scenario, neuronCount, durationMs) {
  const { supported } = checkBackendSupport(backend);
  if (!supported) {
    return {
      scenario,
      backend,
      neuron_count: neuronCount,
      duration_ms: durationMs,
      runtime_seconds: null,
      success: false,
      spike_count: null,
      error: "Brian2CUDA is not installed.",
    };
  }

  try {
    const script = buildBenchmarkScript(backend, scenario, neuronCount, durationMs);
    const result = execFileSync("python3", ["-c", script], {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    const lines = result.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    return JSON.parse(lastLine);
  } catch (err) {
    let errorMsg = err.message || "Unknown error";
    if (err.stderr) errorMsg = err.stderr.slice(-500);
    else if (err.stdout) errorMsg = err.stdout.slice(-500);
    return {
      scenario,
      backend,
      neuron_count: neuronCount,
      duration_ms: durationMs,
      runtime_seconds: null,
      success: false,
      spike_count: null,
      error: errorMsg,
    };
  }
}

function aggregateResults(opts) {
  const records = [];
  const support = {};

  for (const backend of opts.backends) {
    const { supported, reason } = checkBackendSupport(backend);
    support[backend] = { supported, reason };

    for (const scenario of opts.scenarios) {
      for (const neuronCount of opts.neurons) {
        const attempts = [];
        for (let r = 0; r < opts.repeats; r++) {
          attempts.push(runSingleBackend(backend, scenario, neuronCount, opts.durationMs));
        }

        const successful = attempts.filter((a) => a.success && a.runtime_seconds != null);
        const spikeCounts = attempts.filter((a) => a.spike_count != null).map((a) => a.spike_count);
        const errors = attempts.filter((a) => a.error).map((a) => a.error);
        const runtimes = successful.map((a) => a.runtime_seconds);

        records.push({
          scenario,
          scenario_label: BENCHMARK_SCENARIOS[scenario].label,
          backend,
          neuron_count: neuronCount,
          duration_ms: opts.durationMs,
          repeats: opts.repeats,
          successful_runs: successful.length,
          mean_runtime_seconds: runtimes.length ? round(mean(runtimes), 6) : null,
          min_runtime_seconds: runtimes.length ? round(Math.min(...runtimes), 6) : null,
          max_runtime_seconds: runtimes.length ? round(Math.max(...runtimes), 6) : null,
          mean_spike_count: spikeCounts.length ? round(mean(spikeCounts), 2) : null,
          errors,
        });
      }
    }
  }

  records.sort((a, b) => {
    if (a.mean_runtime_seconds == null && b.mean_runtime_seconds == null) return 0;
    if (a.mean_runtime_seconds == null) return 1;
    if (b.mean_runtime_seconds == null) return -1;
    const diff = a.mean_runtime_seconds - b.mean_runtime_seconds;
    if (diff !== 0) return diff;
    if (a.backend < b.backend) return -1;
    if (a.backend > b.backend) return 1;
    if (a.scenario < b.scenario) return -1;
    if (a.scenario > b.scenario) return 1;
    return a.neuron_count - b.neuron_count;
  });

  const highlights = buildHighlights(records, support);

  return {
    generated_at: new Date().toISOString(),
    simulation: {
      model: "CUBA",
      reference: "https://brian2.readthedocs.io/en/2.8.0/examples/CUBA.html",
      duration_ms: opts.durationMs,
      neuron_counts: opts.neurons,
      requested_backends: opts.backends,
      requested_scenarios: opts.scenarios,
      repeats: opts.repeats,
    },
    scenarios: Object.entries(BENCHMARK_SCENARIOS)
      .filter(([name]) => opts.scenarios.includes(name))
      .map(([name, meta]) => ({ name, ...meta })),
    environment: {
      python: process.version,
      backend_support: support,
    },
    highlights,
    results: records,
  };
}

function buildHighlights(records, support) {
  const successful = records.filter((r) => r.mean_runtime_seconds != null);
  const failures = records.filter((r) => r.mean_runtime_seconds == null);

  let fastestOverall = null;
  if (successful.length) {
    const fastest = successful.reduce((a, b) =>
      a.mean_runtime_seconds < b.mean_runtime_seconds ? a : b
    );
    fastestOverall = {
      backend: fastest.backend,
      scenario: fastest.scenario,
      neuron_count: fastest.neuron_count,
      mean_runtime_seconds: fastest.mean_runtime_seconds,
    };
  }

  const fastestPerNeuronCount = [];
  const neuronCounts = [...new Set(successful.map((r) => r.neuron_count))].sort((a, b) => a - b);
  for (const nc of neuronCounts) {
    const subset = successful.filter((r) => r.neuron_count === nc);
    const winner = subset.reduce((a, b) =>
      a.mean_runtime_seconds < b.mean_runtime_seconds ? a : b
    );
    const comparison = compareAgainstNextFastest(subset, winner);
    fastestPerNeuronCount.push({
      neuron_count: nc,
      backend: winner.backend,
      scenario: winner.scenario,
      mean_runtime_seconds: winner.mean_runtime_seconds,
      advantage_over_next_seconds: comparison.seconds,
      advantage_over_next_percent: comparison.percent,
    });
  }

  const fastestPerBackend = [];
  const backends = [...new Set(successful.map((r) => r.backend))].sort();
  for (const backend of backends) {
    const subset = successful.filter((r) => r.backend === backend);
    const winner = subset.reduce((a, b) =>
      a.mean_runtime_seconds < b.mean_runtime_seconds ? a : b
    );
    const comparison = compareAgainstNextFastest(subset, winner);
    fastestPerBackend.push({
      backend,
      scenario: winner.scenario,
      neuron_count: winner.neuron_count,
      mean_runtime_seconds: winner.mean_runtime_seconds,
      advantage_over_next_seconds: comparison.seconds,
      advantage_over_next_percent: comparison.percent,
    });
  }

  const unavailableBackends = Object.entries(support)
    .filter(([, meta]) => !meta.supported)
    .map(([backend, meta]) => ({ backend, reason: meta.reason }));

  return {
    fastest_overall: fastestOverall,
    fastest_per_neuron_count: fastestPerNeuronCount,
    fastest_per_backend: fastestPerBackend,
    failed_configurations: failures.map((r) => ({
      backend: r.backend,
      scenario: r.scenario,
      neuron_count: r.neuron_count,
      errors: r.errors,
    })),
    unavailable_backends: unavailableBackends,
  };
}

function compareAgainstNextFastest(records, winner) {
  const ranked = [...records].sort((a, b) => a.mean_runtime_seconds - b.mean_runtime_seconds);
  if (ranked.length < 2) {
    return { seconds: null, percent: null };
  }
  const runnerUp = ranked[1];
  const deltaSeconds = round(runnerUp.mean_runtime_seconds - winner.mean_runtime_seconds, 6);
  const deltaPercent = round((deltaSeconds / runnerUp.mean_runtime_seconds) * 100, 2);
  return { seconds: deltaSeconds, percent: deltaPercent };
}

function formatTerminalReport(payload) {
  const lines = [];
  const sim = payload.simulation;
  const highlights = payload.highlights;

  lines.push("Benchmark Summary");
  lines.push(
    `Model: ${sim.model} | Duration: ${sim.duration_ms} ms | Repeats: ${sim.repeats}`
  );
  lines.push(
    `Backends: ${sim.requested_backends.join(", ")} | Scenarios: ${sim.requested_scenarios.join(", ")}`
  );
  lines.push("");

  if (!highlights.fastest_overall) {
    lines.push("No successful benchmark runs were recorded.");
  } else {
    const f = highlights.fastest_overall;
    lines.push(
      `Fastest overall: ${f.backend} / ${f.scenario} / ${f.neuron_count} neurons in ${f.mean_runtime_seconds.toFixed(6)}s`
    );
  }

  for (const item of highlights.fastest_per_neuron_count) {
    let comparison = "";
    if (item.advantage_over_next_percent != null) {
      comparison = ` (${item.advantage_over_next_percent.toFixed(2)}% faster than the next option, ${item.advantage_over_next_seconds.toFixed(6)}s ahead)`;
    }
    lines.push(
      `${item.neuron_count} neurons: ${item.backend} / ${item.scenario} won at ${item.mean_runtime_seconds.toFixed(6)}s${comparison}`
    );
  }

  if (highlights.fastest_per_backend.length) {
    lines.push("");
    lines.push("Best scenario per backend:");
    for (const item of highlights.fastest_per_backend) {
      let comparison = "";
      if (item.advantage_over_next_percent != null) {
        comparison = ` (${item.advantage_over_next_percent.toFixed(2)}% faster than the next ${item.backend} result)`;
      }
      lines.push(
        `- ${item.backend}: ${item.scenario} at ${item.neuron_count} neurons finished in ${item.mean_runtime_seconds.toFixed(6)}s${comparison}`
      );
    }
  }

  if (highlights.unavailable_backends.length) {
    lines.push("");
    lines.push("Unavailable backends:");
    for (const item of highlights.unavailable_backends) {
      lines.push(`- ${item.backend}: ${item.reason}`);
    }
  }

  if (highlights.failed_configurations.length) {
    lines.push("");
    lines.push("Failed configurations:");
    for (const item of highlights.failed_configurations) {
      const reason = item.errors[0] || "Unknown failure";
      lines.push(`- ${item.backend} / ${item.scenario} / ${item.neuron_count} neurons: ${reason}`);
    }
  }

  lines.push("");
  lines.push("Results Table");
  lines.push(...formatResultsTable(payload.results));
  return lines.join("\n");
}

function formatResultsTable(records) {
  const headers = ["Backend", "Scenario", "Neurons", "Runs", "Mean (s)", "Min (s)", "Max (s)", "Spikes", "Status"];
  const rows = records.map((r) => [
    r.backend,
    r.scenario,
    String(r.neuron_count),
    String(r.successful_runs),
    fmtSeconds(r.mean_runtime_seconds),
    fmtSeconds(r.min_runtime_seconds),
    fmtSeconds(r.max_runtime_seconds),
    fmtNumber(r.mean_spike_count),
    r.mean_runtime_seconds != null ? "OK" : "FAILED",
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const table = [
    headers.map((h, i) => h.padEnd(widths[i])).join("  "),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map((r) => r.map((v, i) => v.padEnd(widths[i])).join("  ")),
  ];
  return table;
}

function fmtSeconds(v) {
  return v != null ? v.toFixed(6) : "n/a";
}

function fmtNumber(v) {
  if (v == null) return "n/a";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round(v, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(v * factor) / factor;
}

function saveResults(outputPath, payload) {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function main() {
  const opts = parseArgs();

  if (opts.singleRun) {
    const result = runSingleBackend(opts.backend, opts.scenario, opts.neurons[0], opts.durationMs);
    console.log(JSON.stringify(result));
    return 0;
  }

  const payload = aggregateResults(opts);
  saveResults(opts.output, payload);
  console.log(formatTerminalReport(payload));
  console.log(`Saved results to ${opts.output}`);
  return 0;
}

process.exit(main());
