"""The shared constants and helpers that every other module reaches for.

This file exists so the server, the script generator, and the benchmark
all agree on what a CUBA network looks like, what backends exist, and
how to check if a backend will work on this machine.

We keep everything in one place because these numbers and names define
the model that everything else revolves around.

The CUBA network
----------------
CUBA stands for "COBA with UDB" — it is the standard Brian2 example
network. Excitatory and inhibitory neurons connect randomly and drive
each other's conductances. The default values here come from that
example.
"""

# --- What backends we know about ---------------------------------------------
# These are the three execution engines Brian2 can target.
# The web UI lets the user pick one, and the benchmark tests all of them.
SUPPORTED_BACKENDS = ["numpy", "cpp_standalone", "cuda_standalone"]

# --- What the web UI can do --------------------------------------------------
# The front-end lets users either build a script from a form (generate)
# or upload their own Python file (upload).
SUPPORTED_MODES = ["upload", "generate"]

# --- Default parameters for the CUBA network ---------------------------------
# Every value here has a range that clamps user input so Brian2 does not
# receive nonsense values. The defaults are the canonical CUBA example
# numbers from the Brian2 documentation.
CUBA_DEFAULTS = {
    "neurons": 4000,
    "duration_ms": 300,
    "excitatory_ratio": 0.8,
    "connection_probability": 0.02,
    "refractory_ms": 5.0,
    "threshold_mv": -50.0,
    "reset_mv": -60.0,
    "resting_mv": -49.0,
    "taum_ms": 20.0,
    "taue_ms": 5.0,
    "taui_ms": 10.0,
    "excitatory_weight_mv": 1.62,
    "inhibitory_weight_mv": -9.0,
    "integration_method": "exact",
    "monitor_population": "all",
}

# --- The three equations that define a CUBA neuron ----------------------------
# v   = membrane voltage
# ge  = excitatory conductance  (driven by excitatory spikes)
# gi  = inhibitory conductance  (driven by inhibitory spikes)
# taum, taue, taui = time constants for each
CUBA_EQUATIONS = """
dv/dt  = (ge + gi - (v - el)) / taum : volt (unless refractory)
dge/dt = -ge / taue : volt
dgi/dt = -gi / taui : volt
""".strip()

# --- Benchmark scenarios ------------------------------------------------------
# These are two ways to structure the same network. The benchmark runs both
# to see if the network construction pattern affects performance.
BENCHMARK_SCENARIOS = {
    "subgroups": {
        "label": "Single group with Subgroups",
        "description": "One NeuronGroup split into excitatory and inhibitory Subgroups.",
    },
    "split_groups": {
        "label": "Separate excitatory and inhibitory groups",
        "description": "Two NeuronGroups replace Subgroups to approximate eventspace partitioning.",
    },
}


def check_backend_support(backend: str) -> tuple[bool, str | None]:
    """Return (supported, reason) for a given backend name.

    The numpy and cpp_standalone backends ship with Brian2 itself,
    so they always work.  The cuda_standalone backend requires the
    optional brian2cuda package — we try to import it and report
    the error if it is missing.
    """
    if backend in {"numpy", "cpp_standalone"}:
        return True, None

    try:
        import brian2cuda  # noqa: F401
    except Exception as exc:
        return False, f"Brian2CUDA is not installed: {exc}"

    return True, None
