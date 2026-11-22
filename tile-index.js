export const FGB_TILE_INDEX_SOURCE_KIND = "fgb-tile-index";

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
  return {
    kind: FGB_TILE_INDEX_SOURCE_KIND,
    key: `tile:${index}:${tileId}`,
    bounds,
    depth: 0,
    count: Number.isFinite(featureCount) && featureCount >= 0 ? featureCount : null,
    validity: typeof properties.validity === "boolean" ? properties.validity : null,
    firstFeature: index,
    tileId,
    filepath,
    tileUrl: resolveTileUrl(filepath, sourceUrl),
  };
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
