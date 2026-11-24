export const FGB_TILE_INDEX_SOURCE_KIND = "fgb-tile-index";
const TILE_ID_TRIPLET = /^(-?\d+)[-/_](-?\d+)[-/_](-?\d+)$/;
const TILE_ID_SUFFIX = /[-_](\d+)[-_](\d+)[-_](\d+)$/;

export function tileIndexFeatureToItem(feature, index, sourceUrl) {
  const properties = feature?.properties ?? {};
  const filepath = [properties.filepath, properties.cj_download]
    .find((value) => typeof value === "string" && value.trim())?.trim();
  if (!filepath) {
    return null;
  }

  const bounds = boundsFromTileProperties(properties) ?? boundsFromGeometry(feature.geometry);
  if (!validExtent(bounds)) {
    return null;
  }

  const rawCount = properties.feature_count;
  const featureCount = rawCount == null || rawCount === "" ? NaN : Number(rawCount);
  const tileId = properties.tile_id != null && String(properties.tile_id).trim()
    ? String(properties.tile_id)
    : filepath;
  const errorCounts = Array.isArray(properties.error_counts)
    ? properties.error_counts.filter(isErrorCount)
    : null;
  return {
    kind: FGB_TILE_INDEX_SOURCE_KIND,
    key: `tile:${index}:${tileId}`,
    bounds,
    depth: 0,
    count: Number.isFinite(featureCount) && featureCount >= 0 ? featureCount : null,
    validity: typeof properties.validity === "boolean" ? properties.validity : null,
    errorCounts,
    firstFeature: index,
    tileId,
    filepath,
    tileUrl: resolveTileUrl(filepath, sourceUrl),
  };
}

export function tileDownloadFilename({ tileId, tileUrl }) {
  const pathParts = new URL(tileUrl).pathname.split("/");
  let filename = pathParts.at(-1) || "tile";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // Keep the original URL segment if it contains invalid escape sequences.
  }

  const id = tileId.trim();
  const stem = filename.replace(/(?:\.city)?\.(?:jsonl?|ndjson)(?:\.gz)?$/i, "");
  const triplet = id.match(TILE_ID_TRIPLET)
    ?? id.match(TILE_ID_SUFFIX)
    ?? stem.match(TILE_ID_TRIPLET)
    ?? stem.match(TILE_ID_SUFFIX)
    ?? [...pathParts.slice(-3, -1), stem].join("/").match(TILE_ID_TRIPLET);
  return triplet ? `${triplet.slice(1).join("-")}.city.jsonl` : filename;
}

function isErrorCount(entry) {
  return (entry?.lod === null || typeof entry?.lod === "string")
    && Number.isSafeInteger(entry.code) && Number.isSafeInteger(entry.count) && entry.count > 0;
}

export function hasTileErrorCounts({ errorCounts, validity }) {
  return errorCounts !== null && (errorCounts.length > 0 || validity === true);
}

export function aggregateTileErrors(tiles) {
  const counts = new Map();
  let total = 0;
  let tileCount = 0;
  for (const tile of tiles) {
    if (!hasTileErrorCounts(tile)) continue;
    tileCount += 1;
    for (const { lod, code, count } of tile.errorCounts) {
      const key = JSON.stringify([lod, code]);
      const aggregate = counts.get(key) ?? { lod, code, count: 0 };
      aggregate.count += count;
      counts.set(key, aggregate);
      total += count;
    }
  }

  const errorCounts = [...counts.values()].sort((a, b) => {
    if (a.lod === b.lod) return a.code - b.code;
    if (a.lod === null) return 1;
    if (b.lod === null) return -1;
    return a.lod.localeCompare(b.lod, "en", { numeric: true });
  });
  return { errorCounts, total, tileCount };
}

function resolveTileUrl(filepath, sourceUrl) {
  try {
    const url = new URL(filepath, sourceUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function boundsFromTileProperties(properties) {
  const values = [properties.minx, properties.miny, properties.maxx, properties.maxy];
  if (values.some((value) => value == null || value === "")) {
    return null;
  }
  const bounds = values.map(Number);
  return validExtent(bounds) ? bounds : null;
}

function boundsFromGeometry(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  function visit(value) {
    if (!Array.isArray(value)) return;
    if (Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      bounds[0] = Math.min(bounds[0], value[0]);
      bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]);
      bounds[3] = Math.max(bounds[3], value[1]);
      return;
    }
    for (const child of value) visit(child);
  }
  visit(geometry?.coordinates);
  return validExtent(bounds) ? bounds : null;
}

export function validExtent(extent) {
  return (
    Array.isArray(extent) &&
    extent.length === 4 &&
    extent.every(Number.isFinite) &&
    extent[2] > extent[0] &&
    extent[3] > extent[1]
  );
}
