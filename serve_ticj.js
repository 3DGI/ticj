#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildTileIndex, DEFAULT_PATTERN } from "./index_cityjsonl_tiles.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5173;
const DEFAULT_INDEX_NAME = "tile_index.fgb";
const DATA_PREFIX = "/data/";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".fgb", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jsonl", "application/x-ndjson; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

function printUsage() {
  console.error(`Usage: ticj [options] [input_dir]

Build a FlatGeobuf tile index in input_dir, then serve TICJ and input_dir on one HTTP server.

Options:
  --host <host>          Listen host (default: ${DEFAULT_HOST})
  --port <port>          Listen port (default: ${DEFAULT_PORT})
  --output <file>        Index output path (default: <input_dir>/${DEFAULT_INDEX_NAME})
  --index-name <name>    Index filename inside input_dir (default: ${DEFAULT_INDEX_NAME})
  --pattern <glob>       Glob pattern to index (default: ${DEFAULT_PATTERN})
  --non-recursive        Only scan files directly inside input_dir
  --relative-to <dir>    Base directory for stored file paths (default: input_dir)
  --no-overwrite         Do not replace an existing index output file
  -h, --help             Show this help
`);
}

function parseArgs(argv) {
  const args = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    pattern: DEFAULT_PATTERN,
    recursive: true,
    overwrite: true,
    positionals: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--host":
        i += 1;
        if (!argv[i]) throw new Error("--host requires a value");
        args.host = argv[i];
        break;
      case "--port":
        i += 1;
        if (!argv[i]) throw new Error("--port requires a value");
        args.port = parsePort(argv[i]);
        break;
      case "--output":
        i += 1;
        if (!argv[i]) throw new Error("--output requires a value");
        args.output = argv[i];
        break;
      case "--index-name":
        i += 1;
        if (!argv[i]) throw new Error("--index-name requires a value");
        args.indexName = argv[i];
        break;
      case "--pattern":
        i += 1;
        if (!argv[i]) throw new Error("--pattern requires a value");
        args.pattern = argv[i];
        break;
      case "--non-recursive":
        args.recursive = false;
        break;
      case "--relative-to":
        i += 1;
        if (!argv[i]) throw new Error("--relative-to requires a value");
        args.relativeTo = argv[i];
        break;
      case "--overwrite":
        args.overwrite = true;
        break;
      case "--no-overwrite":
        args.overwrite = false;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        args.positionals.push(arg);
        break;
    }
  }

  if (args.positionals.length > 1) {
    throw new Error("expected at most one input_dir positional argument");
  }
  if (args.indexName && path.basename(args.indexName) !== args.indexName) {
    throw new Error("--index-name must be a filename, not a path");
  }

  return args;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

function isInsideOrEqual(filePath, basePath) {
  const relative = path.relative(basePath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathToDataUrl(filePath, dataRoot) {
  const relative = path.relative(dataRoot, filePath).split(path.sep).map(encodeURIComponent).join("/");
  return `${DATA_PREFIX}${relative}`;
}

function safeResolve(root, pathname, prefix = "/") {
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }

  const resolved = path.resolve(root, relative || "index.html");
  return isInsideOrEqual(resolved, root) ? resolved : null;
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader ?? "");
  if (!match) return null;

  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

async function serveFile(request, response, filePath) {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }

  if (!stats.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }

  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "content-type": contentType(filePath),
  };

  const range = parseRange(request.headers.range, stats.size);
  if (range) {
    response.writeHead(206, {
      ...headers,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${stats.size}`,
    });
    createReadStream(filePath, range).pipe(response);
    return;
  }

  response.writeHead(200, {
    ...headers,
    "content-length": String(stats.size),
  });
  createReadStream(filePath).pipe(response);
}

function createTicjServer({ distDir, dataRoot, indexUrl }) {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("method not allowed\n");
      return;
    }

    if (requestUrl.pathname === "/" && requestUrl.search === "") {
      response.writeHead(302, {
        location: `/?index=${encodeURIComponent(indexUrl)}`,
      });
      response.end();
      return;
    }

    const filePath = requestUrl.pathname.startsWith(DATA_PREFIX)
      ? safeResolve(dataRoot, requestUrl.pathname, DATA_PREFIX)
      : safeResolve(distDir, requestUrl.pathname);

    if (!filePath) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("forbidden\n");
      return;
    }

    serveFile(request, response, filePath).catch((error) => {
      console.error(`server error: ${error.message}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("internal server error\n");
    });
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    printUsage();
    return 2;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.join(scriptDir, "dist");
  const inputDir = path.resolve(args.positionals[0] ?? process.cwd());
  const output = path.resolve(args.output ?? path.join(inputDir, args.indexName ?? DEFAULT_INDEX_NAME));
  const relativeTo = path.resolve(args.relativeTo ?? inputDir);

  if (!isInsideOrEqual(output, inputDir)) {
    console.error("error: index output must be inside input_dir so it can be served under /data/");
    return 2;
  }

  try {
    await buildTileIndex({
      inputDir,
      output,
      pattern: args.pattern,
      recursive: args.recursive,
      relativeTo,
      overwrite: args.overwrite,
    });
  } catch (error) {
    console.error(`error: ${error.message}`);
    return error.exitCode ?? 1;
  }

  const indexUrl = pathToDataUrl(output, inputDir);
  const server = createTicjServer({ distDir, dataRoot: inputDir, indexUrl });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`error: ${args.host}:${args.port} is already in use`);
      process.exitCode = 1;
      return;
    }
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(args.port, args.host, () => {
    const url = `http://${args.host}:${args.port}/?index=${encodeURIComponent(indexUrl)}`;
    console.log(`serving TICJ at ${url}`);
    console.log(`serving ${inputDir} as ${DATA_PREFIX}`);
  });

  return new Promise(() => {});
}

main()
  .then((code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  })
  .catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
