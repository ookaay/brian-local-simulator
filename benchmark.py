#!/usr/bin/env python3
"""Benchmark the Brian CUBA example across portable and optional backends."""

from __future__ import annotations

import argparse
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from brian_common import BENCHMARK_SCENARIOS
from brian_common import CUBA_DEFAULTS
from brian_common import CUBA_EQUATIONS
from brian_common import SUPPORTED_BACKENDS
from brian_common import check_backend_support


PROJECT_ROOT = Path(__file__).resolve().parent
RESULTS_DIR = PROJECT_ROOT / "results"
LATEST_RESULTS = RESULTS_DIR / "latest.json"
DEFAULT_NEURON_COUNTS = [1000, 4000, 8000]
ALL_BACKENDS = SUPPORTED_BACKENDS
ALL_SCENARIOS = list(BENCHMARK_SCENARIOS)


@dataclass
class RunResult:
    scenario: str
    backend: str
    neuron_count: int
    duration_ms: int
    runtime_seconds: float | None
    success: bool
    spike_count: int | None = None
    error: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark the Brian CUBA example on available backends."
    )
    parser.add_argument(
        "--neurons",
        nargs="+",
        type=int,
        default=DEFAULT_NEURON_COUNTS,
        help="Neuron counts to benchmark.",
    )
    parser.add_argument(
        "--duration-ms",
        type=int,
        default=300,
        help="Simulation time in milliseconds.",
    )
    parser.add_argument(
        "--repeats",
        type=int,
        default=2,
        help="Number of runs per backend and neuron count.",
    )
    parser.add_argument(
        "--backends",
        nargs="+",
        choices=ALL_BACKENDS,
        default=ALL_BACKENDS,
        help="Backends to attempt.",
    )
    parser.add_argument(
        "--scenarios",
        nargs="+",
        choices=ALL_SCENARIOS,
        default=ALL_SCENARIOS,
        help="Network construction scenarios to benchmark.",
    )
    parser.add_argument(
        "--single-run",
        action="store_true",
        help="Internal mode used to isolate Brian device state per run.",
    )
    parser.add_argument(
        "--backend",
        choices=ALL_BACKENDS,
        help="Internal mode backend selector.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=LATEST_RESULTS,
        help="Where to save the aggregated benchmark JSON.",
    )
    parser.add_argument(
        "--scenario",
        choices=ALL_SCENARIOS,
        help="Internal mode scenario selector.",
    )
    return parser.parse_args()


def create_neuron_group(size: int, namespace: dict[str, object]):
    from brian2 import NeuronGroup
    from brian2 import mV
    from brian2 import ms

    neurons = NeuronGroup(
        size,
        CUBA_EQUATIONS,
        threshold="v > vt",
        reset="v = vr",
        refractory=CUBA_DEFAULTS["refractory_ms"] * ms,
        method=CUBA_DEFAULTS["integration_method"],
        namespace=namespace,
    )
    neurons.v = "vr + rand() * (vt - vr)"
    neurons.ge = 0 * mV
    neurons.gi = 0 * mV
    return neurons


def build_cuba_network(neuron_count: int, scenario: str):
    from brian2 import NeuronGroup
    from brian2 import SpikeMonitor
    from brian2 import Synapses
    from brian2 import mV
    from brian2 import ms

    taum = CUBA_DEFAULTS["taum_ms"] * ms
    taue = CUBA_DEFAULTS["taue_ms"] * ms
    taui = CUBA_DEFAULTS["taui_ms"] * ms
    vt = CUBA_DEFAULTS["threshold_mv"] * mV
    vr = CUBA_DEFAULTS["reset_mv"] * mV
    el = CUBA_DEFAULTS["resting_mv"] * mV

    namespace = {"taum": taum, "taue": taue, "taui": taui, "el": el, "vt": vt, "vr": vr}

    excitatory_count = max(1, int(neuron_count * CUBA_DEFAULTS["excitatory_ratio"]))
    inhibitory_count = max(0, neuron_count - excitatory_count)

    we = CUBA_DEFAULTS["excitatory_weight_mv"] * mV
    wi = CUBA_DEFAULTS["inhibitory_weight_mv"] * mV

    if scenario == "subgroups":
        neurons = create_neuron_group(neuron_count, namespace)
        excitatory = neurons[:excitatory_count]
        inhibitory = neurons[excitatory_count:]

        excitatory_synapses = Synapses(
            excitatory, neurons, on_pre="ge += we", namespace={"we": we}
        )
        excitatory_synapses.connect(p=CUBA_DEFAULTS["connection_probability"])

        if inhibitory_count > 0:
            inhibitory_synapses = Synapses(
                inhibitory, neurons, on_pre="gi += wi", namespace={"wi": wi}
            )
            inhibitory_synapses.connect(p=CUBA_DEFAULTS["connection_probability"])

        monitor = SpikeMonitor(neurons)
        return [monitor], {
            "name": "subgroups",
            **BENCHMARK_SCENARIOS["subgroups"],
        }

    if scenario == "split_groups":
        excitatory = create_neuron_group(excitatory_count, namespace)
        monitors = [SpikeMonitor(excitatory)]

        if inhibitory_count > 0:
            inhibitory = create_neuron_group(inhibitory_count, namespace)
            monitors.append(SpikeMonitor(inhibitory))
        else:
            inhibitory = None

        synapses = [
            Synapses(excitatory, excitatory, on_pre="ge += we", namespace={"we": we}),
        ]
        synapses[0].connect(p=CUBA_DEFAULTS["connection_probability"])

        if inhibitory is not None:
            exc_to_inh = Synapses(excitatory, inhibitory, on_pre="ge += we", namespace={"we": we})
            exc_to_inh.connect(p=CUBA_DEFAULTS["connection_probability"])
            inh_to_exc = Synapses(inhibitory, excitatory, on_pre="gi += wi", namespace={"wi": wi})
            inh_to_exc.connect(p=CUBA_DEFAULTS["connection_probability"])
            inh_to_inh = Synapses(inhibitory, inhibitory, on_pre="gi += wi", namespace={"wi": wi})
            inh_to_inh.connect(p=CUBA_DEFAULTS["connection_probability"])
            synapses.extend([exc_to_inh, inh_to_exc, inh_to_inh])

        return monitors, {
            "name": "split_groups",
            **BENCHMARK_SCENARIOS["split_groups"],
        }

    raise ValueError(f"Unsupported scenario: {scenario}")


def run_single_backend(backend: str, scenario: str, neuron_count: int, duration_ms: int) -> RunResult:
    try:
        from brian2 import ms
        from brian2 import run
        from brian2 import set_device
        from brian2 import start_scope
    except Exception as exc:
        return RunResult(
            scenario=scenario,
            backend=backend,
            neuron_count=neuron_count,
            duration_ms=duration_ms,
            runtime_seconds=None,
            success=False,
            error=f"Failed to import brian2: {exc}",
        )

    supported, reason = check_backend_support(backend)
    if not supported:
        return RunResult(
            scenario=scenario,
            backend=backend,
            neuron_count=neuron_count,
            duration_ms=duration_ms,
            runtime_seconds=None,
            success=False,
            error=reason,
        )

    build_dir: Path | None = None

    try:
        if backend == "cpp_standalone":
            build_dir = Path(tempfile.mkdtemp(prefix="brian-cpp-"))
            set_device("cpp_standalone", directory=str(build_dir), build_on_run=True)
        elif backend == "cuda_standalone":
            build_dir = Path(tempfile.mkdtemp(prefix="brian-cuda-"))
            set_device("cuda_standalone", directory=str(build_dir), build_on_run=True)

        start_scope()
        monitors, scenario_meta = build_cuba_network(neuron_count, scenario)

        start = time.perf_counter()
        run(duration_ms * ms)
        elapsed = time.perf_counter() - start

        return RunResult(
            scenario=scenario_meta["name"],
            backend=backend,
            neuron_count=neuron_count,
            duration_ms=duration_ms,
            runtime_seconds=elapsed,
            success=True,
            spike_count=sum(int(monitor.num_spikes) for monitor in monitors),
        )
    except Exception as exc:
        return RunResult(
            scenario=scenario,
            backend=backend,
            neuron_count=neuron_count,
            duration_ms=duration_ms,
            runtime_seconds=None,
            success=False,
            error=str(exc),
        )
    finally:
        if build_dir is not None:
            shutil.rmtree(build_dir, ignore_errors=True)


def run_isolated_once(backend: str, scenario: str, neuron_count: int, duration_ms: int) -> RunResult:
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--single-run",
        "--backend",
        backend,
        "--scenario",
        scenario,
        "--neurons",
        str(neuron_count),
        "--duration-ms",
        str(duration_ms),
    ]
    completed = subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
    )

    if completed.returncode != 0:
        error = completed.stderr.strip() or completed.stdout.strip() or "Unknown subprocess error"
        return RunResult(
            scenario=scenario,
            backend=backend,
            neuron_count=neuron_count,
            duration_ms=duration_ms,
            runtime_seconds=None,
            success=False,
            error=error,
        )

    stdout = completed.stdout.strip()
    if not stdout:
        return RunResult(
            scenario=scenario,
            backend=backend,
            neuron_count=neuron_count,
            duration_ms=duration_ms,
            runtime_seconds=None,
            success=False,
            error="Subprocess completed without returning benchmark data.",
        )

    try:
        payload = json.loads(stdout.splitlines()[-1])
    except json.JSONDecodeError:
        return RunResult(
            backend=backend,
            neuron_count=neuron_count,
            duration_ms=duration_ms,
            runtime_seconds=None,
            success=False,
            error=f"Failed to parse subprocess output: {stdout[-300:]}",
        )

    return RunResult(**payload)


def aggregate_results(args: argparse.Namespace) -> dict:
    records = []
    support = {}
    scenario_catalog = BENCHMARK_SCENARIOS

    for backend in args.backends:
        supported, reason = check_backend_support(backend)
        support[backend] = {"supported": supported, "reason": reason}

        for scenario in args.scenarios:
            for neuron_count in args.neurons:
                attempts = [
                    run_isolated_once(backend, scenario, neuron_count, args.duration_ms)
                    for _ in range(args.repeats)
                ]
                successful = [
                    item.runtime_seconds
                    for item in attempts
                    if item.success and item.runtime_seconds is not None
                ]
                spike_counts = [item.spike_count for item in attempts if item.spike_count is not None]
                errors = [item.error for item in attempts if item.error]

                records.append(
                    {
                        "scenario": scenario,
                        "scenario_label": scenario_catalog[scenario]["label"],
                        "backend": backend,
                        "neuron_count": neuron_count,
                        "duration_ms": args.duration_ms,
                        "repeats": args.repeats,
                        "successful_runs": len(successful),
                        "mean_runtime_seconds": round(statistics.mean(successful), 6) if successful else None,
                        "min_runtime_seconds": round(min(successful), 6) if successful else None,
                        "max_runtime_seconds": round(max(successful), 6) if successful else None,
                        "mean_spike_count": round(statistics.mean(spike_counts), 2) if spike_counts else None,
                        "errors": errors,
                    }
                )

    records.sort(
        key=lambda item: (
            item["mean_runtime_seconds"] is None,
            item["mean_runtime_seconds"] if item["mean_runtime_seconds"] is not None else float("inf"),
            item["backend"],
            item["scenario"],
            item["neuron_count"],
        )
    )

    highlights = build_highlights(records, support)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "simulation": {
            "model": "CUBA",
            "reference": "https://brian2.readthedocs.io/en/2.8.0/examples/CUBA.html",
            "duration_ms": args.duration_ms,
            "neuron_counts": args.neurons,
            "requested_backends": args.backends,
            "requested_scenarios": args.scenarios,
            "repeats": args.repeats,
        },
        "scenarios": [
            {"name": name, **scenario_catalog[name]}
            for name in args.scenarios
        ],
        "environment": {
            "python": sys.version.split()[0],
            "backend_support": support,
        },
        "highlights": highlights,
        "results": records,
    }


def build_highlights(records: list[dict], support: dict[str, dict]) -> dict:
    successful = [record for record in records if record["mean_runtime_seconds"] is not None]
    failures = [record for record in records if record["mean_runtime_seconds"] is None]

    fastest_overall = None
    if successful:
        fastest = min(successful, key=lambda item: item["mean_runtime_seconds"])
        fastest_overall = {
            "backend": fastest["backend"],
            "scenario": fastest["scenario"],
            "neuron_count": fastest["neuron_count"],
            "mean_runtime_seconds": fastest["mean_runtime_seconds"],
        }

    fastest_per_neuron_count = []
    for neuron_count in sorted({record["neuron_count"] for record in successful}):
        subset = [record for record in successful if record["neuron_count"] == neuron_count]
        winner = min(subset, key=lambda item: item["mean_runtime_seconds"])
        comparison = compare_against_next_fastest(subset, winner)
        fastest_per_neuron_count.append(
            {
                "neuron_count": neuron_count,
                "backend": winner["backend"],
                "scenario": winner["scenario"],
                "mean_runtime_seconds": winner["mean_runtime_seconds"],
                "advantage_over_next_seconds": comparison["seconds"],
                "advantage_over_next_percent": comparison["percent"],
            }
        )

    fastest_per_backend = []
    for backend in sorted({record["backend"] for record in successful}):
        subset = [record for record in successful if record["backend"] == backend]
        winner = min(subset, key=lambda item: item["mean_runtime_seconds"])
        comparison = compare_against_next_fastest(subset, winner)
        fastest_per_backend.append(
            {
                "backend": backend,
                "scenario": winner["scenario"],
                "neuron_count": winner["neuron_count"],
                "mean_runtime_seconds": winner["mean_runtime_seconds"],
                "advantage_over_next_seconds": comparison["seconds"],
                "advantage_over_next_percent": comparison["percent"],
            }
        )

    unavailable_backends = [
        {"backend": backend, "reason": meta["reason"]}
        for backend, meta in support.items()
        if not meta["supported"]
    ]

    return {
        "fastest_overall": fastest_overall,
        "fastest_per_neuron_count": fastest_per_neuron_count,
        "fastest_per_backend": fastest_per_backend,
        "failed_configurations": [
            {
                "backend": record["backend"],
                "scenario": record["scenario"],
                "neuron_count": record["neuron_count"],
                "errors": record["errors"],
            }
            for record in failures
        ],
        "unavailable_backends": unavailable_backends,
    }


def compare_against_next_fastest(records: list[dict], winner: dict) -> dict:
    ranked = sorted(records, key=lambda item: item["mean_runtime_seconds"])
    if len(ranked) < 2:
        return {"seconds": None, "percent": None}

    runner_up = ranked[1]
    delta_seconds = round(runner_up["mean_runtime_seconds"] - winner["mean_runtime_seconds"], 6)
    delta_percent = round((delta_seconds / runner_up["mean_runtime_seconds"]) * 100, 2)
    return {"seconds": delta_seconds, "percent": delta_percent}


def format_terminal_report(payload: dict) -> str:
    lines = []
    simulation = payload["simulation"]
    highlights = payload["highlights"]
    records = payload["results"]

    lines.append("Benchmark Summary")
    lines.append(
        f"Model: {simulation['model']} | Duration: {simulation['duration_ms']} ms | "
        f"Repeats: {simulation['repeats']}"
    )
    lines.append(
        f"Backends: {', '.join(simulation['requested_backends'])} | "
        f"Scenarios: {', '.join(simulation['requested_scenarios'])}"
    )
    lines.append("")

    fastest_overall = highlights["fastest_overall"]
    if fastest_overall is None:
        lines.append("No successful benchmark runs were recorded.")
    else:
        lines.append(
            "Fastest overall: "
            f"{fastest_overall['backend']} / {fastest_overall['scenario']} / "
            f"{fastest_overall['neuron_count']} neurons in "
            f"{fastest_overall['mean_runtime_seconds']:.6f}s"
        )

    for item in highlights["fastest_per_neuron_count"]:
        comparison = ""
        if item["advantage_over_next_percent"] is not None:
            comparison = (
                f" ({item['advantage_over_next_percent']:.2f}% faster than the next option, "
                f"{item['advantage_over_next_seconds']:.6f}s ahead)"
            )
        lines.append(
            f"{item['neuron_count']} neurons: {item['backend']} / {item['scenario']} "
            f"won at {item['mean_runtime_seconds']:.6f}s{comparison}"
        )

    if highlights["fastest_per_backend"]:
        lines.append("")
        lines.append("Best scenario per backend:")
        for item in highlights["fastest_per_backend"]:
            comparison = ""
            if item["advantage_over_next_percent"] is not None:
                comparison = (
                    f" ({item['advantage_over_next_percent']:.2f}% faster than the next "
                    f"{item['backend']} result)"
                )
            lines.append(
                f"- {item['backend']}: {item['scenario']} at {item['neuron_count']} neurons "
                f"finished in {item['mean_runtime_seconds']:.6f}s{comparison}"
            )

    if highlights["unavailable_backends"]:
        lines.append("")
        lines.append("Unavailable backends:")
        for item in highlights["unavailable_backends"]:
            lines.append(f"- {item['backend']}: {item['reason']}")

    if highlights["failed_configurations"]:
        lines.append("")
        lines.append("Failed configurations:")
        for item in highlights["failed_configurations"]:
            reason = item["errors"][0] if item["errors"] else "Unknown failure"
            lines.append(
                f"- {item['backend']} / {item['scenario']} / {item['neuron_count']} neurons: {reason}"
            )

    lines.append("")
    lines.append("Results Table")
    lines.extend(format_results_table(records))
    return "\n".join(lines)


def format_results_table(records: list[dict]) -> list[str]:
    headers = ["Backend", "Scenario", "Neurons", "Runs", "Mean (s)", "Min (s)", "Max (s)", "Spikes", "Status"]
    rows = []
    for record in records:
        status = "OK" if record["mean_runtime_seconds"] is not None else "FAILED"
        rows.append(
            [
                record["backend"],
                record["scenario"],
                str(record["neuron_count"]),
                str(record["successful_runs"]),
                format_seconds(record["mean_runtime_seconds"]),
                format_seconds(record["min_runtime_seconds"]),
                format_seconds(record["max_runtime_seconds"]),
                format_number(record["mean_spike_count"]),
                status,
            ]
        )

    widths = [len(header) for header in headers]
    for row in rows:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))

    table = [
        "  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)),
        "  ".join("-" * widths[index] for index in range(len(headers))),
    ]
    table.extend(
        "  ".join(value.ljust(widths[index]) for index, value in enumerate(row))
        for row in rows
    )
    return table


def format_seconds(value: float | None) -> str:
    return f"{value:.6f}" if value is not None else "n/a"


def format_number(value: float | None) -> str:
    if value is None:
        return "n/a"
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.2f}"


def save_results(output_path: Path, payload: dict) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()

    if args.single_run:
        result = run_single_backend(
            backend=args.backend,
            scenario=args.scenario,
            neuron_count=args.neurons[0],
            duration_ms=args.duration_ms,
        )
        print(json.dumps(result.__dict__))
        return 0

    payload = aggregate_results(args)
    save_results(args.output, payload)
    print(format_terminal_report(payload))
    print(f"Saved results to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
