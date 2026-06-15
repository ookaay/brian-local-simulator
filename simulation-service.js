import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CUBA_DEFAULTS, CUBA_EQUATIONS, SUPPORTED_BACKENDS, SUPPORTED_MODES, checkBackendSupport } from "./common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname);
const RUNS_DIR = join(PROJECT_ROOT, "results", "runs");
const RESULT_PREFIX = "RESULT_JSON:";

function detectPythonVersion() {
  try {
    const out = execFileSync("python3", ["--version"], { encoding: "utf-8", timeout: 5000 });
    return out.trim().replace(/^Python\s+/i, "");
  } catch {
    return "unknown";
  }
}

export function getRuntimeInfo() {
  return {
    python: detectPythonVersion(),
    backend_support: Object.fromEntries(
      SUPPORTED_BACKENDS.map((backend) => {
        const { supported, reason } = checkBackendSupport(backend);
        return [backend, { supported, reason }];
      })
    ),
    notes: [
      "Uploaded scripts run locally on this machine.",
      "Use RESULT_JSON output for custom structured results.",
      "Generated scripts already emit structured metrics automatically.",
    ],
  };
}

export function runSimulationRequest(payload) {
  const mode = payload.mode;
  const backend = payload.backend ?? "numpy";

  if (!SUPPORTED_MODES.includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  if (!SUPPORTED_BACKENDS.includes(backend)) {
    throw new Error(`Unsupported backend: ${backend}`);
  }

  const { supported, reason } = checkBackendSupport(backend);
  if (!supported) {
    return { ok: false, error: reason, backend, mode };
  }

  let scriptSource, requestName;

  if (mode === "upload") {
    scriptSource = (payload.script_source ?? "").trim();
    const filename = payload.filename ?? "uploaded_simulation.py";
    if (!scriptSource) {
      throw new Error("An uploaded Python script is required.");
    }
    requestName = filename.split("/").pop();
  } else {
    requestName = "generated_simulation.py";
    const override = (payload.script_source_override ?? "").trim();
    scriptSource = override || buildGeneratedScript(payload.generate ?? {});
  }

  return executeScript(scriptSource, backend, requestName, mode);
}

function executeScript(scriptSource, backend, requestName, mode) {
  if (!existsSync(RUNS_DIR)) {
    mkdirSync(RUNS_DIR, { recursive: true });
  }

  const runDir = mkdtempSync(join(RUNS_DIR, "sim-run-"));
  const scriptPath = join(runDir, requestName);
  const wrapperPath = join(runDir, "_runner.py");
  const buildDir = join(runDir, "build");

  writeFileSync(scriptPath, scriptSource, "utf-8");
  writeFileSync(wrapperPath, buildWrapperScript(scriptPath), "utf-8");

  const env = {
    ...process.env,
    SIM_BACKEND: backend,
    SIM_SCRIPT_PATH: scriptPath,
    SIM_BUILD_DIR: buildDir,
    PYTHONUNBUFFERED: "1",
  };

  const startTime = performance.now();

  return new Promise((resolvePromise) => {
    const child = execFile(
      process.argv[0] === "node" ? "python3" : "python3",
      [wrapperPath],
      { cwd: runDir, env, timeout: 120_000, maxBuffer: 12 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const elapsed = (performance.now() - startTime) / 1000;

        if (error && error.killed) {
          resolvePromise({
            ok: false,
            mode,
            backend,
            runtime_seconds: Math.round(elapsed * 1e6) / 1e6,
            returncode: null,
            script_name: scriptPath.split("/").pop(),
            stdout: (stdout ?? "").slice(-12000),
            stderr: ((stderr ?? "") + "\nExecution timed out after 120 seconds.").slice(-12000),
            result: null,
            artifacts_dir: runDir,
            error: "Execution timed out after 120 seconds.",
          });
          return;
        }

        const parsedResult = extractResultJson(stdout ?? "");
        const returncode = error ? (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? 1 : 1) : 0;

        const response = {
          ok: !error,
          mode,
          backend,
          runtime_seconds: Math.round(elapsed * 1e6) / 1e6,
          returncode,
          script_name: scriptPath.split("/").pop(),
          stdout: (stdout ?? "").slice(-12000),
          stderr: (stderr ?? "").slice(-12000),
          result: parsedResult,
          artifacts_dir: runDir,
        };

        if (error) {
          response.error = (stderr ?? "").trim() || (stdout ?? "").trim() || "Execution failed.";
        }

        resolvePromise(response);
      }
    );
  });
}

export function previewGeneratedScript(config) {
  return {
    ok: true,
    script_source: buildGeneratedScript(config),
  };
}

function buildGeneratedScript(config) {
  const neurons = clampInt(config.neurons, CUBA_DEFAULTS.neurons, 1, 50000);
  const duration_ms = clampInt(config.duration_ms, CUBA_DEFAULTS.duration_ms, 1, 10000);
  const excitatory_ratio = clampFloat(config.excitatory_ratio, CUBA_DEFAULTS.excitatory_ratio, 0.05, 0.95);
  const connection_probability = clampFloat(config.connection_probability, CUBA_DEFAULTS.connection_probability, 0.0001, 1.0);
  const refractory_ms = clampFloat(config.refractory_ms, CUBA_DEFAULTS.refractory_ms, 0.1, 100.0);
  const threshold_mv = clampFloat(config.threshold_mv, CUBA_DEFAULTS.threshold_mv, -100.0, 20.0);
  const reset_mv = clampFloat(config.reset_mv, CUBA_DEFAULTS.reset_mv, -100.0, 20.0);
  const resting_mv = clampFloat(config.resting_mv, CUBA_DEFAULTS.resting_mv, -100.0, 20.0);
  const taum_ms = clampFloat(config.taum_ms, CUBA_DEFAULTS.taum_ms, 0.1, 1000.0);
  const taue_ms = clampFloat(config.taue_ms, CUBA_DEFAULTS.taue_ms, 0.1, 1000.0);
  const taui_ms = clampFloat(config.taui_ms, CUBA_DEFAULTS.taui_ms, 0.1, 1000.0);
  const excitatory_weight_mv = clampFloat(config.excitatory_weight_mv, CUBA_DEFAULTS.excitatory_weight_mv, 0.0, 200.0);
  const inhibitory_weight_mv = clampFloat(config.inhibitory_weight_mv, CUBA_DEFAULTS.inhibitory_weight_mv, -200.0, 0.0);
  const integration_method = clampChoice(config.integration_method, ["exact", "euler"], CUBA_DEFAULTS.integration_method);
  const monitor_population = clampChoice(config.monitor_population, ["all", "excitatory", "inhibitory"], CUBA_DEFAULTS.monitor_population);
  const equationsBlock = CUBA_EQUATIONS.split("\n").map((l) => `        ${l}`).join("\n");

  const script = `
import json
import os
import time

from brian2 import NeuronGroup
from brian2 import SpikeMonitor
from brian2 import StateMonitor
from brian2 import mV
from brian2 import ms
from brian2 import prefs
from brian2 import Synapses
from brian2 import run
from brian2 import start_scope

start_scope()

n = ${neurons}
duration_ms = ${duration_ms}
backend = os.environ.get("SIM_BACKEND", "numpy")

if backend == "numpy":
    prefs.codegen.target = "numpy"

taum = ${taum_ms} * ms
taue = ${taue_ms} * ms
taui = ${taui_ms} * ms
vt = ${threshold_mv} * mV
vr = ${reset_mv} * mV
el = ${resting_mv} * mV
refractory = ${refractory_ms} * ms
excitatory_ratio = ${excitatory_ratio}
connection_probability = ${connection_probability}
we = ${excitatory_weight_mv} * mV
wi = ${inhibitory_weight_mv} * mV
integration_method = "${integration_method}"
monitor_population = "${monitor_population}"

eqs = '''
${equationsBlock}
'''

neurons = NeuronGroup(
    n,
    eqs,
    threshold="v > vt",
    reset="v = vr",
    refractory=refractory,
    method=integration_method,
    namespace={{
        "taum": taum,
        "taue": taue,
        "taui": taui,
        "el": el,
        "vt": vt,
        "vr": vr,
    }},
)
neurons.v = "vr + rand() * (vt - vr)"
neurons.ge = 0 * mV
neurons.gi = 0 * mV

excitatory_count = max(1, int(n * excitatory_ratio))
excitatory = neurons[:excitatory_count]
inhibitory = neurons[excitatory_count:]

excitatory_synapses = Synapses(excitatory, neurons, on_pre="ge += we", namespace={{"we": we}})
excitatory_synapses.connect(p=connection_probability)

inhibitory_synapses = None
if len(inhibitory):
    inhibitory_synapses = Synapses(
        inhibitory, neurons, on_pre="gi += wi", namespace={{"wi": wi}}
    )
    inhibitory_synapses.connect(p=connection_probability)

monitor_group = neurons
if monitor_population == "excitatory":
    monitor_group = excitatory
elif monitor_population == "inhibitory" and len(inhibitory):
    monitor_group = inhibitory

spikes = SpikeMonitor(monitor_group)
trace = StateMonitor(monitor_group, "v", record=[0] if len(monitor_group) else False)

started = time.perf_counter()
run(duration_ms * ms)
sim_elapsed = time.perf_counter() - started

trace_points = []
time_points = []
if len(trace.record):
    trace_points = [
        round(float(value / mV), 4)
        for value in trace.v[0][: min(300, len(trace.v[0]))]
    ]
    time_points = [
        round(float(value / ms), 4)
        for value in trace.t[: min(300, len(trace.t))]
    ]

payload = {{
    "title": "Generated CUBA network",
    "summary": {{
        "backend": backend,
        "neurons": n,
        "duration_ms": duration_ms,
        "spike_count": int(spikes.num_spikes),
        "simulation_seconds": round(sim_elapsed, 6),
        "monitor_population": monitor_population,
        "connection_probability": connection_probability,
    }},
    "plots": {{
        "voltage_trace_mv": trace_points,
        "time_ms": time_points,
    }},
    "parameters": {{
        "excitatory_ratio": excitatory_ratio,
        "connection_probability": connection_probability,
        "refractory_ms": ${refractory_ms},
        "threshold_mv": ${threshold_mv},
        "reset_mv": ${reset_mv},
        "resting_mv": ${resting_mv},
        "taum_ms": ${taum_ms},
        "taue_ms": ${taue_ms},
        "taui_ms": ${taui_ms},
        "excitatory_weight_mv": ${excitatory_weight_mv},
        "inhibitory_weight_mv": ${inhibitory_weight_mv},
        "integration_method": integration_method,
        "monitor_population": monitor_population,
    }},
}}

print("${RESULT_PREFIX}" + json.dumps(payload))
`.trim() + "\n";

  return script;
}

function buildWrapperScript(scriptPath) {
  return `
import json
import os
import shutil
import sys
import time
import traceback
import builtins
from pathlib import Path

RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)}

script_path = Path(os.environ["SIM_SCRIPT_PATH"])
backend = os.environ.get("SIM_BACKEND", "numpy")
build_dir = Path(os.environ.get("SIM_BUILD_DIR", script_path.parent / "build"))
script_source = script_path.read_text(encoding="utf-8")

global_ns = {
    "__name__": "__main__",
    "__file__": str(script_path),
}
print_state = {"observed_result_output": False}

original_print = builtins.print

def tracking_print(*args, **kwargs):
    rendered = kwargs.get("sep", " ").join(str(arg) for arg in args)
    if rendered.startswith(RESULT_PREFIX):
        print_state["observed_result_output"] = True
    original_print(*args, **kwargs)

builtins.print = tracking_print

def collect_fallback_result(global_ns, backend, elapsed):
    monitors = []
    for name, value in global_ns.items():
        spike_value = getattr(value, "num_spikes", None)
        if spike_value is None or isinstance(spike_value, property):
            continue
        try:
            spike_count = int(spike_value)
        except (TypeError, ValueError):
            continue
        monitors.append({"name": name, "num_spikes": spike_count})

    if not monitors:
        return {
            "title": "Script completed",
            "summary": {
                "backend": backend,
                "simulation_seconds": round(elapsed, 6),
            },
            "notes": [
                "No structured RESULT_JSON payload was printed by the script.",
                "Add print('RESULT_JSON:' + json.dumps(payload)) for richer UI output.",
            ],
        }

    return {
        "title": "Script completed",
        "summary": {
            "backend": backend,
            "simulation_seconds": round(elapsed, 6),
            "total_spikes": sum(item["num_spikes"] for item in monitors),
        },
        "monitors": monitors,
        "notes": [
            "This result was inferred from monitor objects found after script execution.",
        ],
    }

wrapper_started = time.perf_counter()

try:
    if backend != "numpy":
        from brian2 import set_device

        set_device(backend, directory=str(build_dir), build_on_run=True)

    exec(compile(script_source, str(script_path), "exec"), global_ns)
    fallback = None
    if not print_state["observed_result_output"]:
        fallback = collect_fallback_result(
            global_ns, backend, time.perf_counter() - wrapper_started
        )
    if fallback is not None:
        print(RESULT_PREFIX + json.dumps(fallback))
except SystemExit:
    raise
except Exception:
    traceback.print_exc()
    sys.exit(1)
finally:
    builtins.print = original_print
    if backend in {"cpp_standalone", "cuda_standalone"}:
        shutil.rmtree(build_dir, ignore_errors=True)
`.trim() + "\n";
}

function extractResultJson(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith(RESULT_PREFIX)) {
      try {
        return JSON.parse(line.slice(RESULT_PREFIX.length));
      } catch {
        return {
          title: "Result parse failed",
          notes: ["The script emitted RESULT_JSON, but the payload was not valid JSON."],
        };
      }
    }
  }
  return null;
}

function clampInt(value, defaultValue, minimum, maximum) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultValue;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function clampFloat(value, defaultValue, minimum, maximum) {
  const parsed = parseFloat(value);
  if (isNaN(parsed)) return defaultValue;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function clampChoice(value, choices, defaultValue) {
  if (value == null) return defaultValue;
  const parsed = String(value);
  return choices.includes(parsed) ? parsed : defaultValue;
}
