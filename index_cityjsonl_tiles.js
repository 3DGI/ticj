#!/usr/bin/env node
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  opendir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { serialize as serializeFlatGeobuf } from "flatgeobuf/lib/mjs/geojson.js";

const DEFAULT_PATTERN = "*.city.jsonl";

function printUsage() {
  console.error(`Usage: node index_cityjsonl_tiles.js [options] <input_dir> <output>

Build a FlatGeobuf tile index for a folder of CityJSONL tiles.

Options:
  --pattern <glob>       Glob pattern to index (default: ${DEFAULT_PATTERN})
  --non-recursive        Only scan files directly inside input_dir
  --relative-to <dir>    Base directory for stored file paths (default: input_dir)
  --layer-name <name>    Accepted for compatibility; JS output uses FGB default
  --overwrite            Replace the output file if it already exists
  -h, --help             Show this help
`);
}

function parseArgs(argv) {
  const args = {
    pattern: DEFAULT_PATTERN,
    recursive: true,
    relativeTo: null,
    layerName: "cityjsonl_tiles",
    overwrite: false,
    positionals: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
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
      case "--layer-name":
        i += 1;
        if (!argv[i]) throw new Error("--layer-name requires a value");
        args.layerName = argv[i];
        break;
      case "--overwrite":
        args.overwrite = true;
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

  if (!args.help && args.positionals.length !== 2) {
    throw new Error("expected <input_dir> and <output>");
  }

  return args;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(dirPath, label) {
  try {
    const stats = await stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${dirPath}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} is not a directory: ${dirPath}`);
    }
    throw error;
  }
}

function normalizeGlob(pattern) {
  return pattern.split(path.sep).join("/");
}

function escapeRegexChar(char) {
  return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern) {
  const glob = normalizeGlob(pattern);
  let source = "";

  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    const next = glob[i + 1];

    if (char === "*") {
      if (next === "*") {
        const following = glob[i + 2];
        if (following === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end !== -1) {
        const body = glob.slice(i + 1, end);
        const negated = body.startsWith("!") ? `^${body.slice(1)}` : body;
        source += `[${negated}]`;
        i = end;
        continue;
      }
    }

    source += escapeRegexChar(char);
  }

  return new RegExp(`^${source}$`);
}

async function* walkFiles(dirPath, recursive, root = dirPath) {
  const entries = [];
  const dir = await opendir(dirPath);
  for await (const entry of dir) {
    entries.push(entry);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        yield* walkFiles(fullPath, recursive, root);
      }
    } else if (entry.isFile()) {
      yield {
        fullPath,
        relativePath: path.relative(root, fullPath).split(path.sep).join("/"),
      };
    }
  }
}

async function cityjsonlPaths(inputDir, pattern, recursive) {
  const matcher = globToRegExp(pattern);
  const matchRelativePath = normalizeGlob(pattern).includes("/");
  const paths = [];

  for await (const file of walkFiles(inputDir, recursive)) {
    const target = matchRelativePath ? file.relativePath : path.basename(file.fullPath);
    if (matcher.test(target)) {
      paths.push(file.fullPath);
    }
  }

  return paths.sort();
}

function tileIdFromPath(filePath) {
  const name = path.basename(filePath);
  for (const suffix of [".city.jsonl", ".jsonl", ".json"]) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return path.parse(name).name;
}

function parseEpsg(referenceSystem) {
  if (typeof referenceSystem !== "string") return null;
  let match = referenceSystem.match(/EPSG\/(?:0\/)?(\d+)$/i);
  if (match) return `EPSG:${match[1]}`;
  match = referenceSystem.match(/EPSG[:/](\d+)$/i);
  if (match) return `EPSG:${match[1]}`;
  return null;
}

function toFloat(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} is not a finite number: ${value}`);
  }
  return number;
}

function updateBounds(bounds, vertices, scale, translate) {
  let minx = bounds ? bounds[0] : Infinity;
  let miny = bounds ? bounds[1] : Infinity;
  let maxx = bounds ? bounds[2] : -Infinity;
  let maxy = bounds ? bounds[3] : -Infinity;

  for (const vertex of vertices) {
    if (!Array.isArray(vertex) || vertex.length < 2) continue;

    const x = toFloat(vertex[0], "vertex x") * scale[0] + translate[0];
    const y = toFloat(vertex[1], "vertex y") * scale[1] + translate[1];
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }

  if (minx === Infinity) return null;
  return [minx, miny, maxx, maxy];
}

async function scanTile(filePath) {
  let bounds = null;
  let scale = [1, 1, 1];
  let translate = [0, 0, 0];
  let epsg = null;
  let featureCount = 0;
  let lineNumber = 0;

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${filePath}:${lineNumber}: invalid JSON: ${error.message}`);
    }

    const transform = record.transform;
    if (transform && typeof transform === "object" && !Array.isArray(transform)) {
      const recordScale = transform.scale;
      const recordTranslate = transform.translate;
      if (Array.isArray(recordScale) && recordScale.length >= 2) {
        scale = recordScale.slice(0, 3).map((value) => toFloat(value, "transform scale"));
      }
      if (Array.isArray(recordTranslate) && recordTranslate.length >= 2) {
        translate = recordTranslate
          .slice(0, 3)
          .map((value) => toFloat(value, "transform translate"));
      }
    }

    if (epsg === null) {
      const metadata = record.metadata;
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        epsg = parseEpsg(metadata.referenceSystem);
      }
    }

    const vertices = record.vertices;
    if (Array.isArray(vertices) && vertices.length > 0) {
      bounds = updateBounds(bounds, vertices, scale, translate);
      featureCount += 1;
    }
  }

  return { bounds, epsg, featureCount };
}

function polygonFromBounds(bounds) {
  const [minx, miny, maxx, maxy] = bounds;
  return [
    [
      [minx, miny],
      [maxx, miny],
      [maxx, maxy],
      [minx, maxy],
      [minx, miny],
    ],
  ];
}

function isInsideOrEqual(filePath, basePath) {
  const relative = path.relative(basePath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function geojsonFeature(filePath, relativeTo, bounds, featureCount) {
  const relpath = path.relative(relativeTo, filePath).split(path.sep).join("/");
  const [minx, miny, maxx, maxy] = bounds;
  return {
    type: "Feature",
    properties: {
      tile_id: tileIdFromPath(filePath),
      filepath: relpath,
      minx,
      miny,
      maxx,
      maxy,
      feature_count: featureCount,
    },
    geometry: {
      type: "Polygon",
      coordinates: polygonFromBounds(bounds),
    },
  };
}

function epsgToCode(epsg) {
  if (!epsg) return 0;
  const match = epsg.match(/^EPSG:(\d+)$/i);
  return match ? Number(match[1]) : 0;
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

  const [inputArg, outputArg] = args.positionals;
  const inputDir = path.resolve(inputArg);
  const output = path.resolve(outputArg);
  const relativeTo = path.resolve(args.relativeTo ?? inputArg);

  try {
    await assertDirectory(inputDir, "input_dir");
    await assertDirectory(relativeTo, "--relative-to");
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }

  if ((await exists(output)) && !args.overwrite) {
    console.error(`error: output already exists: ${output} (pass --overwrite to replace it)`);
    return 2;
  }

  if (args.layerName !== "cityjsonl_tiles") {
    console.error(
      "warning: --layer-name is ignored; the JS FlatGeobuf serializer uses its default layer name",
    );
  }

  const paths = await cityjsonlPaths(inputDir, args.pattern, args.recursive);
  if (paths.length === 0) {
    console.error(`error: no files matched ${JSON.stringify(args.pattern)} under ${inputDir}`);
    return 2;
  }

  const features = [];
  let skippedEmpty = 0;
  let skippedOutsideRelativeBase = 0;
  const epsgValues = new Set();

  for (const filePath of paths) {
    const { bounds, epsg, featureCount } = await scanTile(filePath);
    if (epsg) epsgValues.add(epsg);
    if (bounds === null) {
      skippedEmpty += 1;
      continue;
    }
    if (!isInsideOrEqual(filePath, relativeTo)) {
      skippedOutsideRelativeBase += 1;
      continue;
    }
    features.push(geojsonFeature(filePath, relativeTo, bounds, featureCount));
  }

  if (features.length === 0) {
    console.error("error: no tiles with vertices were found");
    return 1;
  }

  const sortedEpsgValues = [...epsgValues].sort();
  const epsg = sortedEpsgValues[0] ?? null;
  if (sortedEpsgValues.length > 1) {
    console.error(
      `warning: multiple CRS values found; assigning ${epsg} to the output: ${sortedEpsgValues.join(", ")}`,
    );
  }
  if (skippedEmpty) {
    console.error(`warning: skipped ${skippedEmpty} tile(s) with no vertices`);
  }
  if (skippedOutsideRelativeBase) {
    console.error(
      `warning: skipped ${skippedOutsideRelativeBase} tile(s) outside --relative-to`,
    );
  }

  await mkdir(path.dirname(output), { recursive: true });
  const featureCollection = {
    type: "FeatureCollection",
    features,
  };
  const bytes = serializeFlatGeobuf(featureCollection, epsgToCode(epsg));
  await writeFile(output, bytes, { flag: args.overwrite ? "w" : "wx" });

  console.log(`indexed ${features.length} tile(s) -> ${output}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
