# Brian Local Simulation Studio

Brian Local Simulation Studio is a local web application for building, running, and benchmarking Brian2 simulations on your own machine.

It has three main parts:

- a local web app (Node.js) for generating or uploading simulation scripts
- a lightweight Node.js API server that spawns Brian2 Python scripts
- a benchmark script for comparing backend performance

## Requirements

- **Node.js** 22+ (for the server and CLI tools)
- **Python 3** with `brian2` (simulations run as Python subprocesses)

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
server.js                Node.js HTTP server (zero dependencies)
simulation-service.js    Core simulation execution API (spawns Python)
benchmark.js             Performance benchmark runner (Node.js CLI)
common.js                Shared constants and helper functions
web/                     Browser UI files (unchanged)
results/                 Saved benchmark output and run artifacts
package.json             Project metadata and scripts
requirements.txt         Python dependencies (Brian2)
```

## 1. Run the Web App

Start the local server:

```bash
node server.js
```

Or with npm:

```bash
npm start
```

Open this in your browser:

```text
http://127.0.0.1:8000/web/
```

You can also choose a different host or port:

```bash
node server.js --host 127.0.0.1 --port 8080
```

### What You Can Do in the Web App

- choose a backend: `numpy`, `cpp_standalone`, or `cuda_standalone`
- generate a configurable CUBA simulation script from form inputs
- edit the generated script before running it
- upload or paste your own Python Brian script
- run the simulation locally
- inspect parsed result data, stdout, stderr, and structured plots

### Important Note

Uploaded scripts execute on your local machine. Only run code you trust.

## 2. Use the Simulation Service Directly

If you do not want the browser UI, you can call the backend from JavaScript or via HTTP directly.

HTTP API endpoints:

- `GET /api/info` — runtime information and backend support
- `POST /api/preview` — generate a CUBA script from config (returns source code)
- `POST /api/run` — execute a simulation and return structured results

Example using `curl`:

```bash
curl -s -X POST http://127.0.0.1:8000/api/run \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "generate",
    "backend": "numpy",
    "generate": {
      "neurons": 1000,
      "duration_ms": 100
    }
  }'
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

### Custom Plot Format

The web UI can render custom `line`, `scatter`, and `bar` plots from uploaded scripts.

Example:

```python
import json

payload = {
    "title": "Custom analysis",
    "summary": {
        "neurons": 1000,
        "duration_ms": 200,
    },
    "plots": {
        "charts": [
            {
                "id": "membrane",
                "title": "Membrane potential",
                "type": "line",
                "x": [0, 1, 2, 3, 4],
                "y": [-65, -63, -60, -58, -61],
                "x_label": "Time (ms)",
                "y_label": "Voltage (mV)",
            },
            {
                "id": "rates",
                "title": "Population firing rate",
                "type": "bar",
                "x": ["E", "I"],
                "y": [18.2, 11.4],
                "x_label": "Population",
                "y_label": "Rate (Hz)",
            },
        ]
    },
}

print("RESULT_JSON:" + json.dumps(payload))
```

Generated CUBA scripts still return the built-in voltage trace automatically, and the UI keeps supporting that legacy format.

## 3. Run Benchmarks

Use `benchmark.js` to measure how different Brian backends perform.

Basic usage:

```bash
node benchmark.js
```

Or with npm:

```bash
npm run benchmark
```

Example with custom settings:

```bash
node benchmark.js --neurons 1000 4000 8000 --duration-ms 300 --repeats 2
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

The benchmark prints a human-readable summary to the terminal before saving the full JSON file.

Example:

```text
Benchmark Summary
Model: CUBA | Duration: 300 ms | Repeats: 2
Backends: numpy, cpp_standalone, cuda_standalone | Scenarios: subgroups, split_groups

Fastest overall: cpp_standalone / split_groups / 4000 neurons in 1.392000s
4000 neurons: cpp_standalone / split_groups won at 1.392000s ...

Results Table
Backend  Scenario      Neurons  Runs  Mean (s)  Min (s)   Max (s)   Spikes  Status
...
```

The saved JSON contains the full raw results and a `highlights` section with:

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

`common.js` contains shared project constants and helpers such as:

- supported backends
- default CUBA parameters
- common CUBA equations
- benchmark scenario metadata

## Typical Workflow

1. Install Node.js dependencies (none — zero-dep project) and Python dependencies (`pip install -r requirements.txt`).
2. Run `node server.js` (or `npm start`).
3. Open the browser UI.
4. Choose a backend.
5. Generate or upload a script.
6. Run the simulation locally.
7. Use `node benchmark.js` separately if you want performance comparisons.
