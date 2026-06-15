"""Run Brian2 simulations in isolated Python subprocesses.

Why subprocesses?
-----------------
Brian2's device system (especially for cpp_standalone and cuda_standalone)
mutates global state.  If we ran two simulations in the same process the
second one could inherit stale device configuration.  By spawning a fresh
Python process for each run we guarantee a clean slate.

How it works
-------------
1. The user sends a config (form values or uploaded script).
2. We write that script to a temp directory.
3. We write a small wrapper script next to it that:
   - sets the Brian2 device
   - runs the user's script via exec()
   - captures any structured JSON result the script prints
   - falls back to inspecting leftover monitor objects if no JSON is found
4. We spawn a subprocess running the wrapper.
5. We parse the RESULT_JSON: line from stdout and return it to the front end.
"""

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

# Any line the user's script prints that starts with this token
# is treated as a structured JSON result.  The wrapper script also
# uses this token to report inferred results.
RESULT_PREFIX = "RESULT_JSON:"


# =============================================================================
#  Public API  (called by the HTTP server)
# =============================================================================


def get_runtime_info() -> dict:
    """Return Python version and which backends are usable on this machine.

    The front end calls this on startup to populate the backend dropdown
    and the runtime-info panel.
    """
    return {
        "python": sys.version.split()[0],
        "backend_support": {
            backend: {
                "supported": supported,
                "reason": reason,
            }
            for backend, supported, reason in (
                _check_one_backend(backend) for backend in SUPPORTED_BACKENDS
            )
        },
        "notes": [
            "Uploaded scripts run locally on this machine.",
            "Use RESULT_JSON output for custom structured results.",
            "Generated scripts already emit structured metrics automatically.",
        ],
    }


def preview_generated_script(config: dict) -> dict:
    """Generate the CUBA Python source and return it without running.

    The front end calls this whenever the user tweaks a form field so the
    code editor stays in sync.
    """
    return {
        "ok": True,
        "script_source": _compose_cuba_script_from_config(config),
    }


def run_simulation_request(payload: dict) -> dict:
    """Accept a run request from the front end and execute it.

    The payload must have:
      mode      - "generate" or "upload"
      backend   - one of SUPPORTED_BACKENDS
      generate  - config dict (only for mode == "generate")
      script_source  - raw Python text (only for mode == "upload")

    Returns a dict with keys: ok, mode, backend, runtime_seconds,
    returncode, script_name, stdout, stderr, result, artifacts_dir.
    """
    mode = payload.get("mode")
    backend = payload.get("backend", "numpy")

    # Reject unknown modes or backends before we do any work.
    if mode not in SUPPORTED_MODES:
        raise ValueError(f"Unsupported mode: {mode}")
    if backend not in SUPPORTED_BACKENDS:
        raise ValueError(f"Unsupported backend: {backend}")

    # Is the requested backend actually installed?
    supported, reason = check_backend_support(backend)
    if not supported:
        return {
            "ok": False,
            "error": reason,
            "backend": backend,
            "mode": mode,
        }

    # Figure out what script we are going to run.
    if mode == "upload":
        script_source = payload.get("script_source", "").strip()
        filename = payload.get("filename", "uploaded_simulation.py")
        if not script_source:
            raise ValueError("An uploaded Python script is required.")
        request_name = Path(filename).name
    else:
        request_name = "generated_simulation.py"
        script_source = payload.get("script_source_override", "").strip() or _compose_cuba_script_from_config(
            payload.get("generate", {})
        )

    return _execute_user_script(
        script_source=script_source,
        backend=backend,
        request_name=request_name,
        mode=mode,
    )


# =============================================================================
#  Script execution internals
# =============================================================================


def _execute_user_script(
    script_source: str,
    backend: str,
    request_name: str,
    mode: str,
) -> dict:
    """Write the user's script plus a wrapper to a temp dir and run it.

    We use a wrapper script (instead of running the user's script directly)
    so we can:
      - set the Brian2 device before the user's code runs
      - intercept print() to detect RESULT_JSON: lines
      - infer a fallback result from leftover monitor objects
      - clean up build directories after cpp_standalone / cuda_standalone
    """
    # Prepare a fresh working directory for this run.
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="sim-run-", dir=str(RUNS_DIR)))
    script_path = run_dir / Path(request_name).name
    wrapper_path = run_dir / "_runner.py"
    build_dir = run_dir / "build"

    # Write both files.
    script_path.write_text(script_source, encoding="utf-8")
    wrapper_path.write_text(_compose_wrapper(script_path), encoding="utf-8")

    # Environment that the wrapper and the user's script can read.
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

    parsed_result = _extract_result_from_stdout(completed.stdout)

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


def _check_one_backend(backend: str) -> tuple[str, bool, str | None]:
    """Thin wrapper so get_runtime_info() can build a dict in one pass."""
    supported, reason = check_backend_support(backend)
    return backend, supported, reason


# =============================================================================
#  Generating the CUBA script from form values
# =============================================================================


def _compose_cuba_script_from_config(config: dict) -> str:
    """Build a complete, runnable Brian2 Python script from user form values.

    Every value is clamped to a sane range so the generated script never
    contains parameters that would make Brian2 throw nonsense errors.
    The script that comes out of this function is what the user sees in
    the code editor and can edit before running.
    """
    neurons = _clamp_int(config.get("neurons"), CUBA_DEFAULTS["neurons"], 1, 50000)
    duration_ms = _clamp_int(config.get("duration_ms"), CUBA_DEFAULTS["duration_ms"], 1, 10000)
    excitatory_ratio = _clamp_float(config.get("excitatory_ratio"), CUBA_DEFAULTS["excitatory_ratio"], 0.05, 0.95)
    connection_prob = _clamp_float(config.get("connection_probability"), CUBA_DEFAULTS["connection_probability"], 0.0001, 1.0)
    refractory_ms = _clamp_float(config.get("refractory_ms"), CUBA_DEFAULTS["refractory_ms"], 0.1, 100.0)
    threshold_mv = _clamp_float(config.get("threshold_mv"), CUBA_DEFAULTS["threshold_mv"], -100.0, 20.0)
    reset_mv = _clamp_float(config.get("reset_mv"), CUBA_DEFAULTS["reset_mv"], -100.0, 20.0)
    resting_mv = _clamp_float(config.get("resting_mv"), CUBA_DEFAULTS["resting_mv"], -100.0, 20.0)
    taum_ms = _clamp_float(config.get("taum_ms"), CUBA_DEFAULTS["taum_ms"], 0.1, 1000.0)
    taue_ms = _clamp_float(config.get("taue_ms"), CUBA_DEFAULTS["taue_ms"], 0.1, 1000.0)
    taui_ms = _clamp_float(config.get("taui_ms"), CUBA_DEFAULTS["taui_ms"], 0.1, 1000.0)
    exc_weight_mv = _clamp_float(config.get("excitatory_weight_mv"), CUBA_DEFAULTS["excitatory_weight_mv"], 0.0, 200.0)
    inh_weight_mv = _clamp_float(config.get("inhibitory_weight_mv"), CUBA_DEFAULTS["inhibitory_weight_mv"], -200.0, 0.0)
    integration_method = _clamp_choice(config.get("integration_method"), ["exact", "euler"], CUBA_DEFAULTS["integration_method"])
    monitor_population = _clamp_choice(config.get("monitor_population"), ["all", "excitatory", "inhibitory"], CUBA_DEFAULTS["monitor_population"])

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

        # --- Network size and simulation duration --------------------------------
        n = {neurons}
        duration_ms = {duration_ms}

        # --- Backend selection ---------------------------------------------------
        backend = os.environ.get("SIM_BACKEND", "numpy")
        if backend == "numpy":
            prefs.codegen.target = "numpy"

        # --- Neuron parameters ---------------------------------------------------
        taum = {taum_ms} * ms
        taue = {taue_ms} * ms
        taui = {taui_ms} * ms
        vt = {threshold_mv} * mV
        vr = {reset_mv} * mV
        el = {resting_mv} * mV
        refractory = {refractory_ms} * ms

        # --- Network parameters --------------------------------------------------
        excitatory_ratio = {excitatory_ratio}
        connection_probability = {connection_prob}
        we = {exc_weight_mv} * mV
        wi = {inh_weight_mv} * mV
        integration_method = "{integration_method}"
        monitor_population = "{monitor_population}"

        # --- Equations -----------------------------------------------------------
        eqs = '''
        {equations_block}
        '''

        # --- Build the neuron group ----------------------------------------------
        neurons = NeuronGroup(
            n,
            eqs,
            threshold="v > vt",
            reset="v = vr",
            refractory=refractory,
            method=integration_method,
            namespace={{"taum": taum, "taue": taue, "taui": taui, "el": el, "vt": vt, "vr": vr}},
        )
        neurons.v = "vr + rand() * (vt - vr)"
        neurons.ge = 0 * mV
        neurons.gi = 0 * mV

        # --- Split into excitatory / inhibitory ----------------------------------
        excitatory_count = max(1, int(n * excitatory_ratio))
        excitatory = neurons[:excitatory_count]
        inhibitory = neurons[excitatory_count:]

        # --- Create synapses -----------------------------------------------------
        excitatory_synapses = Synapses(excitatory, neurons, on_pre="ge += we", namespace={{"we": we}})
        excitatory_synapses.connect(p=connection_probability)

        inhibitory_synapses = None
        if len(inhibitory):
            inhibitory_synapses = Synapses(inhibitory, neurons, on_pre="gi += wi", namespace={{"wi": wi}})
            inhibitory_synapses.connect(p=connection_probability)

        # --- Decide which neurons to monitor -------------------------------------
        monitor_group = neurons
        if monitor_population == "excitatory":
            monitor_group = excitatory
        elif monitor_population == "inhibitory" and len(inhibitory):
            monitor_group = inhibitory

        spikes = SpikeMonitor(monitor_group)
        trace = StateMonitor(monitor_group, "v", record=[0] if len(monitor_group) else False)

        # --- Run the simulation --------------------------------------------------
        started = time.perf_counter()
        run(duration_ms * ms)
        sim_elapsed = time.perf_counter() - started

        # --- Collect voltage trace (first 300 points) ----------------------------
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

        # --- Build structured result payload -------------------------------------
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
                "excitatory_weight_mv": {exc_weight_mv},
                "inhibitory_weight_mv": {inh_weight_mv},
                "integration_method": integration_method,
                "monitor_population": monitor_population,
            }},
        }}

        print("{RESULT_PREFIX}" + json.dumps(payload))
        """
    ).strip() + "\n"


# =============================================================================
#  Wrapper script that runs the user's code and captures results
# =============================================================================


def _compose_wrapper(script_path: Path) -> str:
    """Generate the wrapper that exec()s the user's script.

    The wrapper is a short Python program that:
    1. Sets the Brian2 device (unless the backend is numpy).
    2. Replaces builtins.print() with a version that detects RESULT_JSON:.
    3. Runs the user's script via exec().
    4. If no RESULT_JSON was printed, scans the script's global namespace
       for SpikeMonitor objects and infers a result from them.
    5. Cleans up the build directory for standalone backends.

    We generate this as a string rather than keeping it as a module because
    it needs to be written into an isolated temp directory alongside the
    user's script.
    """
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

        # We run the user's script inside this namespace so we can inspect
        # its variables afterward (e.g. to find SpikeMonitor objects).
        global_ns = {{
            "__name__": "__main__",
            "__file__": str(script_path),
        }}
        print_state = {{"observed_result_output": False}}

        # --- Monkey-patch print() to detect RESULT_JSON: lines ------------------
        original_print = builtins.print

        def tracking_print(*args, **kwargs):
            rendered = kwargs.get("sep", " ").join(str(arg) for arg in args)
            if rendered.startswith(RESULT_PREFIX):
                print_state["observed_result_output"] = True
            original_print(*args, **kwargs)

        builtins.print = tracking_print

        # --- Fallback: look for SpikeMonitor objects after the script runs ------
        # If the script did not print a RESULT_JSON line, we scan its globals for
        # any object with a .num_spikes attribute and report what we find.
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

        # --- Run the user's script -----------------------------------------------
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


# =============================================================================
#  Result parsing
# =============================================================================


def _extract_result_from_stdout(stdout: str) -> dict | None:
    """Find the last RESULT_JSON: line in stdout and parse it.

    We scan from the end because the user's script may print diagnostic
    messages before the final structured result line.
    """
    for line in reversed(stdout.splitlines()):
        if line.startswith(RESULT_PREFIX):
            try:
                return json.loads(line[len(RESULT_PREFIX):])
            except json.JSONDecodeError:
                return {
                    "title": "Result parse failed",
                    "notes": ["The script emitted RESULT_JSON, but the payload was not valid JSON."],
                }
    return None


# =============================================================================
#  Clamping helpers  (keep user values inside Brian2-friendly ranges)
# =============================================================================


def _clamp_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _clamp_float(value: object, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _clamp_choice(value: object, choices: list[str], default: str) -> str:
    parsed = str(value) if value is not None else default
    return parsed if parsed in choices else default
