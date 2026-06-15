#!/usr/bin/env python3
"""A local web server that turns a browser into a Brian2 control panel.

Why this exists
---------------
Running Brian2 simulations usually means writing a Python script, running it,
and inspecting the output separately.  This server wraps that workflow in a
web UI so you can tune parameters, see the generated code, run it, and look
at results — all without leaving the browser.

What it serves
--------------
- Static files from the web/ directory (the front-end HTML, CSS, JS).
- Three JSON API endpoints that the front-end calls:
    GET  /api/info     → what Python/backends are available
    POST /api/preview  → generate a CUBA script from form values (no run)
    POST /api/run      → execute a simulation and return results

The server is deliberately dependency-free — it uses only Python's built-in
http.server module.
"""

from __future__ import annotations

import argparse
import json
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from simulation_service import get_runtime_info
from simulation_service import preview_generated_script
from simulation_service import run_simulation_request


PROJECT_ROOT = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve the local Brian simulation studio."
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host interface for the local web server.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port for the local HTTP server.",
    )
    return parser.parse_args()


class AppHandler(SimpleHTTPRequestHandler):
    """Handle HTTP requests, routing API calls to the simulation service.

    Ordinary requests (HTML, JS, CSS) are handled by the parent class.
    API requests are intercepted in do_GET and do_POST.
    """

    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    # -- GET -------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            self.path = "/web/"
            return super().do_GET()

        if self.path == "/api/info":
            self._send_json(HTTPStatus.OK, get_runtime_info())
            return

        super().do_GET()

    # -- POST -------------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        # Only two endpoints accept POST.
        if self.path not in {"/api/run", "/api/preview"}:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint.")
            return

        # Read the JSON body.
        length = int(self.headers.get("Content-Length", "0"))
        payload_raw = self.rfile.read(length)

        try:
            payload = json.loads(payload_raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": "Request body must be valid JSON."},
            )
            return

        # Dispatch to the appropriate handler.
        try:
            if self.path == "/api/preview":
                result = preview_generated_script(payload.get("generate", {}))
            else:
                result = run_simulation_request(payload)
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # pragma: no cover
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": f"Unexpected server error: {exc}"},
            )
            return

        status = HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_REQUEST
        self._send_json(status, result)

    # -- Helpers ----------------------------------------------------------------

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def end_headers(self) -> None:
        """Tell the browser not to cache API responses."""
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, status: HTTPStatus, payload: dict) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def serve(host: str, port: int) -> None:
    handler = partial(AppHandler, directory=str(PROJECT_ROOT))
    with ThreadingHTTPServer((host, port), handler) as httpd:
        print(f"Serving at http://{host}:{port}/web/")
        print("Press Ctrl+C to stop.")
        httpd.serve_forever()


def main() -> int:
    args = parse_args()

    try:
        serve(args.host, args.port)
    except KeyboardInterrupt:
        print("\nServer stopped.")
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
