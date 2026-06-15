#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { extname, join, dirname, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeInfo, previewGeneratedScript, runSimulationRequest } from "./simulation-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res, status, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(encoded);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function serveStaticFile(res, pathname) {
  let filePath = join(PROJECT_ROOT, pathname);

  if (!filePath.startsWith(PROJECT_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (filePath.endsWith("/")) {
    filePath = join(filePath, "index.html");
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  try {
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const data = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.length,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Internal Server Error");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;

  try {
    if (pathname === "/" || pathname === "") {
      res.writeHead(302, { Location: "/web/" });
      res.end();
      return;
    }

    if (pathname === "/api/info" && req.method === "GET") {
      sendJson(res, 200, getRuntimeInfo());
      return;
    }

    if (pathname === "/api/preview" && req.method === "POST") {
      const body = await parseBody(req);
      const result = previewGeneratedScript(body?.generate ?? {});
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/run" && req.method === "POST") {
      const body = await parseBody(req);
      const result = await runSimulationRequest(body);
      const status = result.ok ? 200 : 400;
      sendJson(res, status, result);
      return;
    }

    serveStaticFile(res, pathname);
  } catch (err) {
    if (err.message === "Request body must be valid JSON.") {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    if (err instanceof Error && err.message.startsWith("Unsupported")) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    sendJson(res, 500, { ok: false, error: `Unexpected server error: ${err.message}` });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { host: "127.0.0.1", port: 8000 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host" && args[i + 1]) opts.host = args[++i];
    if (args[i] === "--port" && args[i + 1]) opts.port = parseInt(args[++i], 10);
  }
  return opts;
}

function main() {
  const { host, port } = parseArgs();
  const server = createServer(handleRequest);

  server.listen(port, host, () => {
    console.log(`Serving at http://${host}:${port}/web/`);
    console.log("Press Ctrl+C to stop.");
  });
}

main();
