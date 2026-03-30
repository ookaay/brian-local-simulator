"""Local simulation service for uploaded and generated Brian scripts."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

from brian_common import CUBA_DEFAULTS
from brian_common import CUBA_EQUATIONS
from brian_common import SUPPORTED_BACKENDS
from brian_common import SUPPORTED_MODES
from brian_common import check_backend_support


PROJECT_ROOT = Path(__file__).resolve().parent
RUNS_DIR = PROJECT_ROOT / "results" / "runs"
RESULT_PREFIX = "RESULT_JSON:"


def get_runtime_info() -> dict:
    return {
        "python": sys.version.split()[0],
        "backend_support": {
            backend: {
                "supported": supported,
                "reason": reason,
            }
            for backend, supported, reason in (
                _backend_support_record(backend) for backend in SUPPORTED_BACKENDS
            )
        },
        "notes": [
            "Uploaded scripts run locally on this machine.",
            "Use RESULT_JSON output for custom structured results.",
            "Generated scripts already emit structured metrics automatically.",
        ],
    }


def run_simulation_request(payload: dict) -> dict:
    mode = payload.get("mode")
    backend = payload.get("backend", "numpy")

    if mode not in SUPPORTED_MODES:
        raise ValueError(f"Unsupported mode: {mode}")
    if backend not in SUPPORTED_BACKENDS:
        raise ValueError(f"Unsupported backend: {backend}")

    supported, reason = check_backend_support(backend)
    if not supported:
        return {
            "ok": False,
            "error": reason,
            "backend": backend,
            "mode": mode,
        }

    if mode == "upload":
        script_source = payload.get("script_source", "").strip()
        filename = payload.get("filename", "uploaded_simulation.py")
        if not script_source:
            raise ValueError("An uploaded Python script is required.")
        request_name = Path(filename).name
    else:
        request_name = "generated_simulation.py"
        script_source = payload.get("script_source_override", "").strip() or build_generated_script(
            payload.get("generate", {})
        )

    return execute_script(
        script_source=script_source,
        backend=backend,
        request_name=request_name,
        mode=mode,
    )


def execute_script(
    script_source: str,
    backend: str,
    request_name: str,
    mode: str,
) -> dict:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="sim-run-", dir=str(RUNS_DIR)))
    script_path = run_dir / Path(request_name).name
    wrapper_path = run_dir / "_runner.py"
    build_dir = run_dir / "build"

    script_path.write_text(script_source, encoding="utf-8")
    wrapper_path.write_text(build_wrapper_script(script_path), encoding="utf-8")

    env = os.environ.copy()
    env["SIM_BACKEND"] = backend
    env["SIM_SCRIPT_PATH"] = str(script_path)
    env["SIM_BUILD_DIR"] = str(build_dir)

    started_at = time.perf_counter()
    try:
        completed = subprocess.run(
            [sys.executable, str(wrapper_path)],
            cwd=str(run_dir),
            capture_output=True,
            text=True,
            check=False,
            env=env,
            timeout=120,
        )
        elapsed = time.perf_counter() - started_at
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "mode": mode,
            "backend": backend,
            "runtime_seconds": round(time.perf_counter() - started_at, 6),
            "returncode": None,
            "script_name": script_path.name,
            "stdout": (exc.stdout or "")[-12000:],
            "stderr": ((exc.stderr or "") + "\nExecution timed out after 120 seconds.")[-12000:],
            "result": None,
            "artifacts_dir": str(run_dir),
            "error": "Execution timed out after 120 seconds.",
        }

    parsed_result = extract_result_json(completed.stdout)

    response = {
        "ok": completed.returncode == 0,
        "mode": mode,
        "backend": backend,
        "runtime_seconds": round(elapsed, 6),
        "returncode": completed.returncode,
        "script_name": script_path.name,
        "stdout": completed.stdout[-12000:],
        "stderr": completed.stderr[-12000:],
        "result": parsed_result,
        "artifacts_dir": str(run_dir),
    }

    if completed.returncode != 0:
        response["error"] = completed.stderr.strip() or completed.stdout.strip() or "Execution failed."

    return response
def _backend_support_record(backend: str) -> tuple[str, bool, str | None]:
    supported, reason = check_backend_support(backend)
    return backend, supported, reason


def preview_generated_script(config: dict) -> dict:
    return {
        "ok": True,
        "script_source": build_generated_script(config),
    }


def build_generated_script(config: dict) -> str:
    neurons = clamp_int(config.get("neurons"), default=CUBA_DEFAULTS["neurons"], minimum=1, maximum=50000)
    duration_ms = clamp_int(
        config.get("duration_ms"), default=CUBA_DEFAULTS["duration_ms"], minimum=1, maximum=10000
    )
    excitatory_ratio = clamp_float(
        config.get("excitatory_ratio"), default=CUBA_DEFAULTS["excitatory_ratio"], minimum=0.05, maximum=0.95
    )
    connection_probability = clamp_float(
        config.get("connection_probability"),
        default=CUBA_DEFAULTS["connection_probability"],
        minimum=0.0001,
        maximum=1.0,
    )
    refractory_ms = clamp_float(
        config.get("refractory_ms"), default=CUBA_DEFAULTS["refractory_ms"], minimum=0.1, maximum=100.0
    )
    threshold_mv = clamp_float(
        config.get("threshold_mv"), default=CUBA_DEFAULTS["threshold_mv"], minimum=-100.0, maximum=20.0
    )
    reset_mv = clamp_float(config.get("reset_mv"), default=CUBA_DEFAULTS["reset_mv"], minimum=-100.0, maximum=20.0)
    resting_mv = clamp_float(
        config.get("resting_mv"), default=CUBA_DEFAULTS["resting_mv"], minimum=-100.0, maximum=20.0
    )
    taum_ms = clamp_float(config.get("taum_ms"), default=CUBA_DEFAULTS["taum_ms"], minimum=0.1, maximum=1000.0)
    taue_ms = clamp_float(config.get("taue_ms"), default=CUBA_DEFAULTS["taue_ms"], minimum=0.1, maximum=1000.0)
    taui_ms = clamp_float(config.get("taui_ms"), default=CUBA_DEFAULTS["taui_ms"], minimum=0.1, maximum=1000.0)
    excitatory_weight_mv = clamp_float(
        config.get("excitatory_weight_mv"),
        default=CUBA_DEFAULTS["excitatory_weight_mv"],
        minimum=0.0,
        maximum=200.0,
    )
    inhibitory_weight_mv = clamp_float(
        config.get("inhibitory_weight_mv"),
        default=CUBA_DEFAULTS["inhibitory_weight_mv"],
        minimum=-200.0,
        maximum=0.0,
    )
    integration_method = clamp_choice(
        config.get("integration_method"), ["exact", "euler"], CUBA_DEFAULTS["integration_method"]
    )
    monitor_population = clamp_choice(
        config.get("monitor_population"),
        ["all", "excitatory", "inhibitory"],
        CUBA_DEFAULTS["monitor_population"],
    )
    equations_block = textwrap.indent(CUBA_EQUATIONS, " " * 8)

    return textwrap.dedent(
        f"""
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

        n = {neurons}
        duration_ms = {duration_ms}
        backend = os.environ.get("SIM_BACKEND", "numpy")

        if backend == "numpy":
            prefs.codegen.target = "numpy"

        taum = {taum_ms} * ms
        taue = {taue_ms} * ms
        taui = {taui_ms} * ms
        vt = {threshold_mv} * mV
        vr = {reset_mv} * mV
        el = {resting_mv} * mV
        refractory = {refractory_ms} * ms
        excitatory_ratio = {excitatory_ratio}
        connection_probability = {connection_probability}
        we = {excitatory_weight_mv} * mV
        wi = {inhibitory_weight_mv} * mV
        integration_method = "{integration_method}"
        monitor_population = "{monitor_population}"

        eqs = '''
{equations_block}
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
                "refractory_ms": {refractory_ms},
                "threshold_mv": {threshold_mv},
                "reset_mv": {reset_mv},
                "resting_mv": {resting_mv},
                "taum_ms": {taum_ms},
                "taue_ms": {taue_ms},
                "taui_ms": {taui_ms},
                "excitatory_weight_mv": {excitatory_weight_mv},
                "inhibitory_weight_mv": {inhibitory_weight_mv},
                "integration_method": integration_method,
                "monitor_population": monitor_population,
            }},
        }}

        print("{RESULT_PREFIX}" + json.dumps(payload))
        """
    ).strip() + "\n"


def build_wrapper_script(script_path: Path) -> str:
    return textwrap.dedent(
        f"""
        import json
        import os
        import shutil
        import sys
        import time
        import traceback
        import builtins
        from pathlib import Path

        RESULT_PREFIX = {RESULT_PREFIX!r}

        script_path = Path(os.environ["SIM_SCRIPT_PATH"])
        backend = os.environ.get("SIM_BACKEND", "numpy")
        build_dir = Path(os.environ.get("SIM_BUILD_DIR", script_path.parent / "build"))
        script_source = script_path.read_text(encoding="utf-8")

        global_ns = {{
            "__name__": "__main__",
            "__file__": str(script_path),
        }}
        print_state = {{"observed_result_output": False}}


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
                monitors.append({{"name": name, "num_spikes": spike_count}})

            if not monitors:
                return {{
                    "title": "Script completed",
                    "summary": {{
                        "backend": backend,
                        "simulation_seconds": round(elapsed, 6),
                    }},
                    "notes": [
                        "No structured RESULT_JSON payload was printed by the script.",
                        "Add print('RESULT_JSON:' + json.dumps(payload)) for richer UI output.",
                    ],
                }}

            return {{
                "title": "Script completed",
                "summary": {{
                    "backend": backend,
                    "simulation_seconds": round(elapsed, 6),
                    "total_spikes": sum(item["num_spikes"] for item in monitors),
                }},
                "monitors": monitors,
                "notes": [
                    "This result was inferred from monitor objects found after script execution.",
                ],
            }}


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
            if backend in {{"cpp_standalone", "cuda_standalone"}}:
                shutil.rmtree(build_dir, ignore_errors=True)
        """
    ).strip() + "\n"


def extract_result_json(stdout: str) -> dict | None:
    for line in reversed(stdout.splitlines()):
        if line.startswith(RESULT_PREFIX):
            try:
                return json.loads(line[len(RESULT_PREFIX) :])
            except json.JSONDecodeError:
                return {
                    "title": "Result parse failed",
                    "notes": ["The script emitted RESULT_JSON, but the payload was not valid JSON."],
                }
    return None


def clamp_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def clamp_float(value: object, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def clamp_choice(value: object, choices: list[str], default: str) -> str:
    parsed = str(value) if value is not None else default
    return parsed if parsed in choices else default
