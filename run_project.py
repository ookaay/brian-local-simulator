#!/usr/bin/env python3
"""Serve a local Brian simulation studio with upload and script generation flows."""

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
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            self.path = "/web/"
            return super().do_GET()

        if self.path == "/api/info":
            self._send_json(HTTPStatus.OK, get_runtime_info())
            return

        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/api/run", "/api/preview"}:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint.")
            return

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

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def end_headers(self) -> None:
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
