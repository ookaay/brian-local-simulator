# Brian Local Simulation Studio

This is a web interface for Brian2. Brian2 is a Python library for simulating networks of spiking neurons. Think of it like a physics engine for brain cells.

This project wraps Brian2 in a local web app so you can tweak parameters in a browser, see the generated Python code, run it, and look at the results — all without leaving one screen.

## Before you start

You need Python 3.10 or newer and Brian2 installed.

```bash
pip install -r requirements.txt
```

If you have an NVIDIA GPU and want CUDA support:

```bash
pip install -r requirements-gpu.txt
```

The GPU and C++ backends also need a compiler installed on your machine.

## What this thing actually does

There are three parts:

1. A web app where you build or upload a simulation and run it.
2. A Python service that handles the actual simulation work.
3. A benchmark script that compares backend speeds.

### The web app

Start the server:

```bash
python run_project.py
```

Open http://127.0.0.1:8000/web/ in your browser.

You can change the port:

```bash
python run_project.py --host 127.0.0.1 --port 8080
```

Once it's running, you get a control panel split into a few areas:

- **Input source** — switch between the form-based CUBA builder and uploading your own Python file.
- **Execution target** — pick which backend to use. Only backends available on your machine are enabled.
- **CUBA controls** — sliders and dropdowns for every parameter of the network. Change a value and the code editor updates instantly.
- **Code editor** — the generated Python script. You can edit it manually before running.
- **Run button** — executes the script and returns results.
- **Charts and logs** — a voltage trace plot, readable summary, raw JSON, stdout, and stderr.

The default model is called CUBA. It's the standard example from the Brian2 docs — a random network of excitatory and inhibitory neurons. Here's what the math looks like:

```
dv/dt  = (ge + gi - (v - el)) / taum
dge/dt = -ge / taue
dgi/dt = -gi / taui
```

Three equations. That's it. The first one is the membrane voltage, the other two are conductances that go up when a spike arrives and decay over time.

### Using the API directly

You don't need the browser. The server speaks JSON over HTTP.

**Check what's available:**

```bash
curl http://127.0.0.1:8000/api/info
```

**Preview a generated script (doesn't run anything):**

```bash
curl -X POST http://127.0.0.1:8000/api/preview \
  -H 'Content-Type: application/json' \
  -d '{"generate": {"neurons": 100, "duration_ms": 20}}'
```

**Run a simulation:**

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

You get back spike counts, runtime, a voltage trace, and any errors.

### Running your own scripts

Switch the web app to "Upload Script" mode, or send a POST with `mode: "upload"` and your Python code in `script_source`.

If you want the UI to show nice structured results, print a line that starts with `RESULT_JSON:` followed by a JSON payload:

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

The UI can render bar, line, and scatter charts from the `plots.charts` array. If you don't print a `RESULT_JSON` line, the server looks for SpikeMonitor objects in your script and makes a best guess at the result.

### The benchmark

The benchmark script runs the same CUBA network at different sizes and compares how fast each backend handles it.

```bash
python benchmark.py
```

It prints a summary like this:

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

Full results go into `results/latest.json`.

You can change what gets tested:

```bash
python benchmark.py --neurons 500 2000 --duration-ms 100 --repeats 3
```

### The three backends

Brian2 can run your simulation in three ways:

- **numpy** — pure Python. Good for small tests. No compilation needed.
- **cpp_standalone** — Brian2 turns your model into C++, compiles it, and runs it. Much faster for large networks.
- **cuda_standalone** — Same idea but for NVIDIA GPUs. Requires brian2cuda.

The benchmark will tell you which one works best on your machine.

## How it works behind the scenes

When you click "Run", the server doesn't call Brian2 directly. Here's what actually happens:

1. It writes your script to a temp folder.
2. It writes a small wrapper script next to it.
3. It starts a fresh Python process running the wrapper.
4. The wrapper sets the right backend, runs your script, and catches the `RESULT_JSON:` output.
5. The server reads the output and sends it back.

Each run gets its own clean Python process. This matters because Brian2's C++ and CUDA backends use global state that doesn't reset well between runs.

## Project layout

```
run_project.py          The web server
simulation_service.py   Runs simulations in subprocesses
benchmark.py            Speed comparison tool
brian_common.py         Default values and helpers
web/                    HTML, CSS, JavaScript files
results/                Benchmark data and run artifacts
requirements.txt        Tells pip to install brian2
requirements-gpu.txt    Adds brian2cuda
```

## One more thing

Uploaded scripts run on your machine. Don't run code from people you don't trust.

## Typical workflow

```bash
pip install -r requirements.txt
python run_project.py
```

Open the browser. Adjust some sliders. Click Run. Done.
