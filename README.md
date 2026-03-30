# Brian Local Simulation Studio

Brian Local Simulation Studio is a local Python project for building, running, and benchmarking Brian2 simulations on your own machine.

It has three main parts:

- a local web app for generating or uploading simulation scripts
- a reusable Python simulation service
- a benchmark script for comparing backend performance

## Requirements

- Python 3
- `brian2`

Install the base dependency:

```bash
pip install -r requirements.txt
```

If you want CUDA backend support as well:

```bash
pip install -r requirements-gpu.txt
```

`cpp_standalone` and `cuda_standalone` also require the relevant local compiler and toolchain support.

## Project Layout

```text
run_project.py          Start the local web app
simulation_service.py   Core simulation execution API
benchmark.py            Performance benchmark runner
brian_common.py         Shared constants and helper functions
web/                    Browser UI files
results/                Saved benchmark output and run artifacts
```

## 1. Run the Web App

Start the local server:

```bash
python run_project.py
```

Open this in your browser:

```text
http://127.0.0.1:8000/web/
```

You can also choose a different host or port:

```bash
python run_project.py --host 127.0.0.1 --port 8000
```

### What You Can Do in the Web App

- choose a backend: `numpy`, `cpp_standalone`, or `cuda_standalone`
- generate a configurable CUBA simulation script from form inputs
- edit the generated script before running it
- upload or paste your own Python Brian script
- run the simulation locally
- inspect parsed result data, stdout, stderr, and voltage traces

### Important Note

Uploaded scripts execute on your local machine. Only run code you trust.

## 2. Use the Simulation Service Directly

If you do not want the browser UI, you can call the backend directly from Python.

Main functions in `simulation_service.py`:

- `get_runtime_info()`
- `preview_generated_script(config)`
- `run_simulation_request(payload)`

Example:

```python
from simulation_service import run_simulation_request

result = run_simulation_request(
    {
        "mode": "generate",
        "backend": "numpy",
        "generate": {
            "neurons": 1000,
            "duration_ms": 100,
        },
    }
)

print(result)
```

### Supported Modes

- `generate`: build a CUBA script from config values
- `upload`: run a Python script provided as text

### Structured Result Output

Generated scripts already emit structured JSON automatically.

For uploaded scripts, print a line in this format if you want rich UI output:

```python
print("RESULT_JSON:" + json.dumps(payload))
```

If no structured payload is printed, the project still returns stdout, stderr, and a small inferred summary when possible.

## 3. Run Benchmarks

Use `benchmark.py` to measure how different Brian backends perform.

Basic usage:

```bash
python benchmark.py
```

Example with custom settings:

```bash
python benchmark.py --neurons 1000 4000 8000 --duration-ms 300 --repeats 2
```

This writes aggregated benchmark output to:

```text
results/latest.json
```

### What the Benchmark Measures

- runtime across backends
- runtime across neuron counts
- success or failure of each run
- spike counts from the simulated network

This is useful for comparing `numpy`, `cpp_standalone`, and `cuda_standalone` on the same model.

### Benchmark Output Format

The benchmark now prints a human-readable summary to the terminal before saving the full JSON file.

Example:

```text
Benchmark Summary
Model: CUBA | Duration: 20 ms | Repeats: 1
Backends: numpy | Scenarios: subgroups, split_groups

Fastest overall: numpy / subgroups / 100 neurons in 0.212118s
100 neurons: numpy / subgroups won at 0.212118s (7.35% faster than the next option, 0.016834s ahead)

Best scenario per backend:
- numpy: subgroups at 100 neurons finished in 0.212118s

Results Table
Backend  Scenario      Neurons  Runs  Mean (s)  Min (s)   Max (s)   Spikes  Status
...
```

The saved JSON still contains the full raw results, and now also includes a `highlights` section with:

- `fastest_overall`
- `fastest_per_neuron_count`
- `fastest_per_backend`
- `failed_configurations`
- `unavailable_backends`

## Backends

- `numpy`: baseline CPU backend
- `cpp_standalone`: generated C++ standalone execution
- `cuda_standalone`: GPU execution through Brian2CUDA if installed

Backend availability is checked at runtime.

## Shared Helpers

`brian_common.py` contains shared project constants and helpers such as:

- supported backends
- default CUBA parameters
- common CUBA equations
- benchmark scenario metadata

## Typical Workflow

1. Install dependencies.
2. Run `python run_project.py`.
3. Open the browser UI.
4. Choose a backend.
5. Generate or upload a script.
6. Run the simulation locally.
7. Use `benchmark.py` separately if you want performance comparisons.
