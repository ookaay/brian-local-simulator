# Brian Local Simulation Studio

A web interface for [Brian2](https://briansimulator.org/), the spiking neural network simulator.

If you do computational neuroscience — or want to try — this project lets you build, run, and benchmark Brian2 simulations from your browser without writing Python by hand.

---

## What is Brian2?

Brian2 is a Python library for simulating spiking neural networks. You define neurons by writing their differential equations in plain mathematical notation, connect them with synapses, and Brian2 compiles everything into efficient code and runs it. It is free, open source, and used in hundreds of published research papers.

A minimal Brian2 simulation looks like this:

```python
from brian2 import *

neurons = NeuronGroup(100, "dv/dt = -v / (10*ms) : volt", threshold="v > -50*mV")
neurons.v = "-60*mV"
run(100*ms)
```

This project is a layer on top of that.

---

## What this project does

Instead of editing Python files and running them from the terminal, you get a local web app where you can:

- **Tune a standard network** — sliders and dropdowns for neuron count, connection strength, time constants, etc.
- **See the code** — the generated Python script appears in an editor. You can tweak it before running.
- **Run it** — pick a backend (`numpy`, `cpp_standalone`, or `cuda_standalone`) and click a button.
- **See results** — spike counts, runtime, a voltage trace plot, and the full stdout/stderr.
- **Upload your own scripts** — the web UI parses structured results from any Brian2 script.

There is also a **benchmark** script that measures how each backend performs across different network sizes.

The project uses only Python's standard library for the server — no Flask, no Django, no external dependencies beyond Brian2 itself.

---

## The model: CUBA

The default network is the standard Brian2 example, **CUBA** (COBA with UDB — Conductance-Based with Unified Differential Equations). It is a random network of excitatory (80%) and inhibitory (20%) neurons where each spike drives the target's conductance up or down. The neuron equation is a leaky integrate-and-fire model with conductance-based synapses:

```
dv/dt  = (ge + gi - (v - el)) / taum    # membrane voltage
dge/dt = -ge / taue                      # excitatory conductance
dgi/dt = -gi / taui                      # inhibitory conductance
```

This is a well-understood benchmark for comparing backends because it exercises synaptic propagation, conductance updates, and spike detection — the three most expensive parts of any spiking network simulation.

---

## Requirements

| Dependency | Why |
|---|---|
| **Python 3.10+** | The language Brian2 speaks |
| **brian2** | The simulator itself |
| *(optional)* **brian2cuda** | GPU backend (`cuda_standalone`) |
| *(optional)* **C++ compiler** | Required by `cpp_standalone` and `cuda_standalone` |

### Install Brian2

```bash
pip install -r requirements.txt
```

This installs Brian2 and its dependencies (NumPy, etc.).

If you have an NVIDIA GPU and want CUDA support:

```bash
pip install -r requirements-gpu.txt
```

---

## Project layout

```
run_project.py          HTTP server (zero external dependencies)
simulation_service.py   Spawns Python subprocesses to run simulations
benchmark.py            Measures backend performance across network sizes
brian_common.py         Shared defaults, equations, and helpers
web/                    Browser UI (HTML + vanilla JS + CSS)
results/                Benchmark JSON output and per-run artifacts
requirements.txt        pip dependencies (just brian2)
requirements-gpu.txt    Adds brian2cuda for GPU support
```

---

## 1. Run the web app

```bash
python run_project.py
```

Open **[http://127.0.0.1:8000/web/](http://127.0.0.1:8000/web/)** in your browser.

Optional flags:

```bash
python run_project.py --host 0.0.0.0 --port 8080
```

### What you see

| Panel | What it does |
|---|---|
| **Input source** | Toggle between the CUBA Builder (form) and Upload Script (paste a file) |
| **Execution target** | Pick a backend — only installed backends are enabled |
| **CUBA controls** | Sliders for every parameter of the network |
| **Live code preview** | The generated Python script, editable before you run it |
| **Run Simulation** | Executes the script locally and returns results |
| **Structured plots** | Voltage trace (generated scripts) or custom charts from uploaded scripts |
| **Logs** | Readable result, raw JSON, stdout, stderr |

### Security note

Uploaded scripts execute on your machine. Only run code you trust.

---

## 2. Use the API directly (no browser)

The server exposes three JSON endpoints that you can call with `curl` or any HTTP client.

### `GET /api/info`

```bash
curl http://127.0.0.1:8000/api/info
```

Returns the Python version and which backends are available.

### `POST /api/preview`

```bash
curl -X POST http://127.0.0.1:8000/api/preview \
  -H 'Content-Type: application/json' \
  -d '{"generate": {"neurons": 100, "duration_ms": 20}}'
```

Returns the generated Python source without running it.

### `POST /api/run`

```bash
curl -X POST http://127.0.0.1:8000/api/run \
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

Runs the simulation and returns structured results (spike count, runtime, traces, plots).

You can also run your own Brian2 scripts via the `upload` mode:

```bash
curl -X POST http://127.0.0.1:8000/api/run \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "upload",
    "backend": "numpy",
    "script_source": "from brian2 import *\nneurons = NeuronGroup(100, ...)"
  }'
```

### Structured result format

Generated scripts automatically print a `RESULT_JSON:` line with spike counts, simulation time, and a voltage trace. If you upload your own script, you can emit the same format:

```python
import json

payload = {
    "title": "My simulation",
    "summary": {
        "neurons": 1000,
        "duration_ms": 200,
        "spike_count": 1523,
        "simulation_seconds": 0.45,
    },
    "plots": {
        "charts": [
            {
                "id": "rates",
                "title": "Firing rates",
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

The web UI renders `line`, `scatter`, and `bar` chart types from the `plots.charts` array. If no `RESULT_JSON` is printed, the project falls back to scanning the script's namespace for `SpikeMonitor` objects.

---

## 3. Run benchmarks

The benchmark script compares how fast each backend runs the same CUBA network at different sizes.

```bash
python benchmark.py
```

This runs all backends × both scenarios × 1000/4000/8000 neurons, 2 repeats each, and prints a summary:

```
Benchmark Summary
Model: CUBA | Duration: 300 ms | Repeats: 2
Backends: numpy, cpp_standalone | Scenarios: subgroups, split_groups

Fastest overall: cpp_standalone / split_groups / 8000 neurons in 2.744000s
4000 neurons: cpp_standalone / split_groups won at 1.392000s ...

Results Table
Backend          Scenario      Neurons  Runs  Mean (s)  Min (s)   Max (s)   Spikes  Status
...
```

Results are saved to `results/latest.json` with full details and a `highlights` section identifying the fastest configurations.

Custom neuron counts or durations:

```bash
python benchmark.py --neurons 500 2000 --duration-ms 100 --repeats 3
```

---

## Backends explained

| Backend | How it works | Best for |
|---|---|---|
| `numpy` | Pure Python loops, no compilation | Testing small networks, quick iteration |
| `cpp_standalone` | Brian2 generates C++ code, compiles it, and runs the binary | Large networks on CPU (10×–100× faster than numpy) |
| `cuda_standalone` | Brian2 generates CUDA code and runs on GPU | Very large networks, if you have an NVIDIA GPU |

The benchmark is the best way to see which backend wins on your machine.

---

## How the simulation service works

When you click "Run", the server does not call Brian2 directly in the same process. Instead it:

1. Writes your script to a temporary directory.
2. Writes a small **wrapper script** next to it.
3. Spawns a **fresh Python subprocess** running the wrapper.
4. The wrapper sets the Brian2 device, `exec()`s your script, and intercepts `print()` to capture `RESULT_JSON:` lines.
5. The server parses the result and returns it to the front end.

This isolation matters because Brian2's device system (especially `cpp_standalone` and `cuda_standalone`) uses global state. Each simulation gets a clean slate.

---

## Typical workflow

```bash
# 1. Install
pip install -r requirements.txt

# 2. Start the server
python run_project.py

# 3. Open the browser
#    → http://127.0.0.1:8000/web/

# 4. Tune parameters, click Run

# 5. Benchmark
python benchmark.py
```
