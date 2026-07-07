import "ol/ol.css";

import Feature from "ol/Feature.js";
import OlMap from "ol/Map.js";
import View from "ol/View.js";
import Polygon from "ol/geom/Polygon.js";
import TileLayer from "ol/layer/Tile.js";
import VectorLayer from "ol/layer/Vector.js";
import OSM from "ol/source/OSM.js";
import VectorSource from "ol/source/Vector.js";
import { Fill, Stroke, Style, Text } from "ol/style.js";
import { register } from "ol/proj/proj4.js";
import { get as getProjection, transform } from "ol/proj.js";
import { deserialize as deserializeFlatGeobuf } from "flatgeobuf/lib/mjs/geojson.js";
import proj4 from "proj4";

const MAGIC = [0x66, 0x63, 0x62, 0x01, 0x66, 0x63, 0x62, 0x00];
const FGB_MAGIC = [0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00];
const NODE_ITEM_BYTES = 40;
const ATTRIBUTE_INDEX_BYTES = 16;
const LEAF_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const HEADER_SIZE_LIMIT = 512 * 1024 * 1024;
const MAP_PROJECTION = "EPSG:3857";
const RD_NEW_PROJECTION = "EPSG:28992";
const FCB_SOURCE_KIND = "fcb";
const FGB_TILE_INDEX_SOURCE_KIND = "fgb-tile-index";

proj4.defs(
  RD_NEW_PROJECTION,
  "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs +type=crs",
);
register(proj4);

const rdProjection = getProjection(RD_NEW_PROJECTION);
rdProjection?.setExtent([-285401.92, 22598.08, 595401.92, 903401.92]);

const mapEl = document.querySelector("#map");
const tooltip = document.querySelector("#tooltip");

const urlInput = document.querySelector("#urlInput");
const loadUrlButton = document.querySelector("#loadUrlButton");
const thresholdInput = document.querySelector("#thresholdInput");
const thresholdNumber = document.querySelector("#thresholdNumber");
const thresholdValue = document.querySelector("#thresholdValue");
const fitButton = document.querySelector("#fitButton");
const clearButton = document.querySelector("#clearButton");
const openCjLoupeButton = document.querySelector("#openCjLoupeButton");
const projectionSelect = document.querySelector("#projectionSelect");
const statusEl = document.querySelector("#status");
const fcbOnlyElements = document.querySelectorAll("[data-source-mode='fcb']");

const featureCountEl = document.querySelector("#featureCount");
const nodeSizeEl = document.querySelector("#nodeSize");
const levelCountEl = document.querySelector("#levelCount");
const visibleCountEl = document.querySelector("#visibleCount");
const selectedCountEl = document.querySelector("#selectedCount");

let app = null;
let hoveredKey = null;
let thresholdDebounce = null;

const cellsSource = new VectorSource();
const cellsLayer = new VectorLayer({
  source: cellsSource,
  style: cellStyle,
});

const map = new OlMap({
  target: mapEl,
  layers: [
    new TileLayer({
      source: new OSM(),
    }),
    cellsLayer,
  ],
  view: new View({
    center: transform([5.3, 52.1], "EPSG:4326", MAP_PROJECTION),
    zoom: 8,
  }),
});

class UrlSource {
  constructor(url) {
    this.url = new URL(url, window.location.href).href;
    this.label = this.url;
    this.size = null;
  }

  async read(start, length) {
    const end = start + length - 1;
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (response.status !== 206) {
      throw new Error(`HTTP ${response.status}; this URL must support Range requests.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < length) {
      throw new Error(`Expected ${length} bytes, got ${bytes.byteLength}`);
    }
    return bytes.slice(0, length);
  }

  async readAll() {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}; could not fetch ${this.url}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

class FcbIndex {
  constructor(source, header) {
    this.source = source;
    this.header = header;
    this.featuresCount = header.featuresCount;
    this.branchingFactor = header.indexNodeSize;
    this.headerSectionSize = 8 + 4 + header.headerSize;
    this.rtreeStart = this.headerSectionSize;
    this.levelBounds = generateLevelBounds(this.featuresCount, this.branchingFactor);
    this.numNodes = this.levelBounds[0].end;
    this.rtreeSize = this.numNodes * NODE_ITEM_BYTES;
    this.attrIndexSize = header.attrIndexSize;
    this.featureSectionStart = this.rtreeStart + this.rtreeSize + this.attrIndexSize;
    this.cache = new globalThis.Map();
    this.leafOffsets = null;
  }

  async readNode(index) {
    if (this.cache.has(index)) {
      return this.cache.get(index);
    }
    const bytes = await this.source.read(this.rtreeStart + index * NODE_ITEM_BYTES, NODE_ITEM_BYTES);
    const node = parseNodeItem(bytes, index);
    this.cache.set(index, node);
    return node;
  }

  async readNodes(start, end) {
    const nodes = [];
    let cursor = start;
    while (cursor < end) {
      if (this.cache.has(cursor)) {
        nodes.push(this.cache.get(cursor));
        cursor += 1;
        continue;
      }

      let missEnd = cursor + 1;
      while (missEnd < end && !this.cache.has(missEnd)) {
        missEnd += 1;
      }
      const bytes = await this.source.read(
        this.rtreeStart + cursor * NODE_ITEM_BYTES,
        (missEnd - cursor) * NODE_ITEM_BYTES,
      );
      for (let i = cursor; i < missEnd; i += 1) {
        const offset = (i - cursor) * NODE_ITEM_BYTES;
        const node = parseNodeItem(bytes.slice(offset, offset + NODE_ITEM_BYTES), i);
        this.cache.set(i, node);
        nodes.push(node);
      }
      cursor = missEnd;
    }
    return nodes;
  }

  childRange(node, level) {
    if (level <= 0) {
      return null;
    }
    const childLevel = level - 1;
    const start = Number(node.offset);
    const end = Math.min(start + this.branchingFactor, this.levelBounds[childLevel].end);
    return { level: childLevel, start, end };
  }

  featureIndexRange(nodeIndex, level) {
    const within = nodeIndex - this.levelBounds[level].start;
    const capacity = this.branchingFactor ** level;
    const start = within * capacity;
    const end = Math.min(this.featuresCount, start + capacity);
    return [start, end];
  }

  inferredCount(nodeIndex, level) {
    const [start, end] = this.featureIndexRange(nodeIndex, level);
    return Math.max(0, end - start);
  }

  async featureByteRanges(featureSpans) {
    await this.ensureLeafOffsets();
    const ranges = [];
    for (const [startIndex, endIndex] of featureSpans) {
      for (let featureIndex = startIndex; featureIndex < endIndex; featureIndex += 1) {
        const start = this.featureSectionStart + this.leafOffsets[featureIndex];
        let end = null;
        if (featureIndex + 1 < this.featuresCount) {
          end = this.featureSectionStart + this.leafOffsets[featureIndex + 1];
        } else {
          const sizePrefix = await this.source.read(start, 4);
          end = start + 4 + readU32(sizePrefix, 0);
        }
        ranges.push({ start, end });
      }
    }
    return mergeRanges(ranges);
  }

  async leafIndex(chunkSize = Math.max(1, Math.floor(LEAF_READ_CHUNK_BYTES / NODE_ITEM_BYTES))) {
    if (this.featuresCount > 0xffffffff) {
      throw new Error("ticj currently supports up to 4,294,967,295 indexed features.");
    }

    const leafStart = this.levelBounds[0].start;
    const leafEnd = this.levelBounds[0].end;
    const count = leafEnd - leafStart;
    const centersX = new Float64Array(count);
    const centersY = new Float64Array(count);
    const leafOffsets = new Float64Array(count);
    const allIndexes = new Uint32Array(count);

    for (let start = leafStart; start < leafEnd; start += chunkSize) {
      const end = Math.min(leafEnd, start + chunkSize);
      const bytes = await this.source.read(
        this.rtreeStart + start * NODE_ITEM_BYTES,
        (end - start) * NODE_ITEM_BYTES,
      );
      for (let i = 0; i < end - start; i += 1) {
        const byteOffset = i * NODE_ITEM_BYTES;
        const featureIndex = start + i - leafStart;
        centersX[featureIndex] =
          (readF64(bytes, byteOffset) + readF64(bytes, byteOffset + 16)) / 2;
        centersY[featureIndex] =
          (readF64(bytes, byteOffset + 8) + readF64(bytes, byteOffset + 24)) / 2;
        leafOffsets[featureIndex] = Number(readU64(bytes, byteOffset + 32));
        allIndexes[featureIndex] = featureIndex;
      }
    }
    this.leafOffsets = leafOffsets;
    return { centersX, centersY, allIndexes, count };
  }

  async ensureLeafOffsets() {
    if (this.leafOffsets) {
      return;
    }
    await this.leafIndex();
  }
}

async function loadSource(source) {
  if (isLikelyFlatGeobufSource(source)) {
    await loadFlatGeobufTileIndexSource(source);
    return;
  }

  const prefix = await source.read(0, 8);
  if (matchesMagic(prefix, FGB_MAGIC)) {
    await loadFlatGeobufTileIndexSource(source);
    return;
  }

  if (!matchesMagic(prefix, MAGIC)) {
    throw new Error("Source is neither a FlatCityBuf file nor a FlatGeobuf tile index.");
  }

  await loadFlatCityBufSource(source);
}

async function loadFlatCityBufSource(source) {
  setStatus(`Reading FlatCityBuf header from ${source.label}...`);
  const header = await readHeader(source);
  if (header.featuresCount <= 0) {
    throw new Error("Header has no feature count; cannot reconstruct the R-tree.");
  }
  if (header.indexNodeSize < 2) {
    throw new Error("This file has no usable spatial index.");
  }

  const index = new FcbIndex(source, header);
  const root = await index.readNode(0);
  const extent = [root.minX, root.minY, root.maxX, root.maxY];

  app = {
    mode: FCB_SOURCE_KIND,
    index,
    source,
    threshold: Number(thresholdNumber.value),
    visible: [],
    selected: new globalThis.Map(),
    extent,
    leafIndex: null,
    sourceProjection: resolveSourceProjection(extent),
  };
  setSourceModeUi(app.mode);
  await rebuildVisible();
  updateHeaderStats();
  updateProjectionControl();
  setButtons(true);
  fitToExtent();
  setStatus(`Loaded ${source.label} using ${app.sourceProjection}.`);
}

async function loadFlatGeobufTileIndexSource(source) {
  setStatus(`Reading FlatGeobuf tile index from ${source.label}...`);
  const bytes = await source.readAll();
  const tiles = [];
  let tileIndex = 0;

  for await (const feature of deserializeFlatGeobuf(bytes)) {
    const tile = tileIndexFeatureToItem(feature, tileIndex, source.url);
    if (tile) {
      tiles.push(tile);
    }
    tileIndex += 1;
  }

  if (tiles.length === 0) {
    throw new Error("FlatGeobuf tile index did not contain usable tile features.");
  }

  const extent = extentFromItems(tiles);
  app = {
    mode: FGB_TILE_INDEX_SOURCE_KIND,
    source,
    threshold: Number(thresholdNumber.value),
    visible: tiles,
    tiles,
    selected: new globalThis.Map(),
    extent,
    leafIndex: null,
    sourceProjection: resolveSourceProjection(extent),
  };

  setSourceModeUi(app.mode);
  visibleCountEl.textContent = String(tiles.length);
  updateHeaderStats();
  updateProjectionControl();
  updateSelectionStats();
  setButtons(true);
  renderCells();
  fitToExtent();
  setStatus(`Loaded ${tiles.length.toLocaleString()} tiles from ${source.label} using ${app.sourceProjection}.`);
}

async function readHeader(source) {
  const prefix = await source.read(0, 12);
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (prefix[i] !== MAGIC[i]) {
      throw new Error("Missing FlatCityBuf magic bytes.");
    }
  }
  const headerSize = readU32(prefix, 8);
  if (headerSize < 8 || headerSize > HEADER_SIZE_LIMIT) {
    throw new Error(`Illegal header size: ${headerSize}`);
  }
  const bytes = await source.read(8, 4 + headerSize);
  return parseHeaderFlatBuffer(bytes, headerSize);
}

function parseHeaderFlatBuffer(bytes, headerSize) {
  const table = 4 + readU32(bytes, 4);
  const vtable = table - readI32(bytes, table);

  const featuresCountOffset = fieldOffset(bytes, vtable, 4);
  const indexNodeSizeOffset = fieldOffset(bytes, vtable, 5);
  const featuresCount = featuresCountOffset
    ? Number(readU64(bytes, table + featuresCountOffset))
    : 0;
  const indexNodeSize = indexNodeSizeOffset
    ? readU16(bytes, table + indexNodeSizeOffset)
    : 16;
  const attrIndexOffset = fieldOffset(bytes, vtable, 6);
  const attrIndexSize = attrIndexOffset
    ? readAttributeIndexSize(bytes, table + attrIndexOffset)
    : 0;

  let extent = null;
  const extentOffset = fieldOffset(bytes, vtable, 7);
  if (extentOffset) {
    const p = table + extentOffset;
    extent = [
      readF64(bytes, p),
      readF64(bytes, p + 8),
      readF64(bytes, p + 24),
      readF64(bytes, p + 32),
    ];
  }

  return { headerSize, featuresCount, indexNodeSize, attrIndexSize, extent };
}

function readAttributeIndexSize(bytes, fieldPosition) {
  const vector = fieldPosition + readU32(bytes, fieldPosition);
  const length = readU32(bytes, vector);
  let total = 0;
  let cursor = vector + 4;
  for (let i = 0; i < length; i += 1) {
    total += readU32(bytes, cursor + 4);
    cursor += ATTRIBUTE_INDEX_BYTES;
  }
  return total;
}

function tileIndexFeatureToItem(feature, index, sourceUrl) {
  const properties = feature?.properties ?? {};
  const filepath = typeof properties.filepath === "string" ? properties.filepath : "";
  if (!filepath) {
    return null;
  }

  const bounds = boundsFromTileProperties(properties) ?? boundsFromGeometry(feature.geometry);
  if (!validExtent(bounds)) {
    return null;
  }

  const featureCount = Number(properties.feature_count);
  const tileId = typeof properties.tile_id === "string" && properties.tile_id
    ? properties.tile_id
    : filepath;
  return {
    kind: FGB_TILE_INDEX_SOURCE_KIND,
    key: `tile:${index}:${tileId}`,
    bounds,
    depth: 0,
    count: Number.isFinite(featureCount) && featureCount >= 0 ? featureCount : 1,
    firstFeature: index,
    tileId,
    filepath,
    tileUrl: resolveTileUrl(filepath, sourceUrl),
  };
}

function resolveTileUrl(filepath, sourceUrl) {
  try {
    if (sourceUrl) {
      return new URL(filepath, sourceUrl).href;
    }

    const url = new URL(filepath);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function boundsFromTileProperties(properties) {
  const bounds = [
    Number(properties.minx),
    Number(properties.miny),
    Number(properties.maxx),
    Number(properties.maxy),
  ];
  return validExtent(bounds) ? bounds : null;
}

function boundsFromGeometry(geometry) {
  const points = [];
  collectGeometryPoints(geometry?.coordinates, points);
  if (points.length === 0) {
    return null;
  }

  const xs = points.map(([x]) => x).filter(Number.isFinite);
  const ys = points.map(([, y]) => y).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) {
    return null;
  }

  return [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
}

function collectGeometryPoints(value, points) {
  if (!Array.isArray(value)) {
    return;
  }
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    points.push([value[0], value[1]]);
    return;
  }
  for (const child of value) {
    collectGeometryPoints(child, points);
  }
}

function extentFromItems(items) {
  return items.reduce((extent, item) => {
    if (!extent) {
      return [...item.bounds];
    }
    extent[0] = Math.min(extent[0], item.bounds[0]);
    extent[1] = Math.min(extent[1], item.bounds[1]);
    extent[2] = Math.max(extent[2], item.bounds[2]);
    extent[3] = Math.max(extent[3], item.bounds[3]);
    return extent;
  }, null);
}

async function rebuildVisible() {
  if (!app) {
    return;
  }
  if (app.mode === FGB_TILE_INDEX_SOURCE_KIND) {
    app.visible = app.tiles;
    visibleCountEl.textContent = String(app.visible.length);
    updateSelectionStats();
    renderCells();
    setStatus(`Showing ${app.visible.length.toLocaleString()} tiles.`);
    return;
  }

  if (!app.leafIndex) {
    setStatus(`Reading ${app.index.featuresCount.toLocaleString()} R-tree leaf entries...`);
    app.leafIndex = await app.index.leafIndex();
  }

  setStatus("Building quadtree cells...");
  app.visible = buildQuadtree(app.leafIndex, app.extent, app.threshold);
  visibleCountEl.textContent = String(app.visible.length);
  updateSelectionStats();
  renderCells();
  setStatus(`Showing ${app.visible.length.toLocaleString()} quadtree cells.`);
}

function fitToExtent() {
  if (!app || !validExtent(app.extent)) {
    return;
  }
  map.getView().fit(transformBoundsToMapExtent(app.extent, app.sourceProjection), {
    padding: [48, 48, 48, 48],
    duration: 180,
    maxZoom: 18,
  });
}

function renderCells() {
  cellsSource.clear();
  if (!app) {
    return;
  }

  const features = app.visible.map((item) => {
    const feature = new Feature({
      geometry: new Polygon([boundsToMapRing(item.bounds, app.sourceProjection)]),
      item,
      itemKey: item.key,
    });
    return feature;
  });
  cellsSource.addFeatures(features);
  cellsLayer.changed();
}

function cellStyle(feature) {
  const item = feature.get("item");
  const selected = app?.selected.has(item.key) ?? false;
  const hovered = hoveredKey === item.key;
  const showLabel = item.count > 0 && (selected || hovered || item.depth <= 7);

  return new Style({
    fill: new Fill({
      color: selected ? "rgba(40, 102, 110, 0.26)" : "rgba(93, 125, 96, 0.10)",
    }),
    stroke: new Stroke({
      color: selected ? "#0b525b" : hovered ? "#8a4f23" : "#55705c",
      width: selected || hovered ? 2 : 1,
    }),
    text: showLabel
      ? new Text({
          text: formatCompact(item.count),
          font: "12px Inter, sans-serif",
          fill: new Fill({ color: selected ? "#0b525b" : "#24332b" }),
          stroke: new Stroke({ color: "rgba(255,255,255,0.82)", width: 3 }),
          overflow: true,
        })
      : undefined,
  });
}

function boundsToMapRing(bounds, sourceProjection) {
  const [minX, minY, maxX, maxY] = bounds;
  return [
    transformCoordinate([minX, minY], sourceProjection),
    transformCoordinate([maxX, minY], sourceProjection),
    transformCoordinate([maxX, maxY], sourceProjection),
    transformCoordinate([minX, maxY], sourceProjection),
    transformCoordinate([minX, minY], sourceProjection),
  ];
}

function transformBoundsToMapExtent(bounds, sourceProjection) {
  const ring = boundsToMapRing(bounds, sourceProjection);
  const xs = ring.map(([x]) => x);
  const ys = ring.map(([, y]) => y);
  return [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
}

function transformCoordinate(coordinate, sourceProjection) {
  return sourceProjection === MAP_PROJECTION
    ? coordinate
    : transform(coordinate, sourceProjection, MAP_PROJECTION);
}

function resolveSourceProjection(extent) {
  const selected = projectionSelect.value;
  if (selected !== "auto") {
    return selected;
  }

  return inferSourceProjection(extent);
}

function inferSourceProjection(extent) {
  const [minX, minY, maxX, maxY] = extent;
  if (minX >= -200000 && maxX <= 400000 && minY >= 250000 && maxY <= 700000) {
    return RD_NEW_PROJECTION;
  }
  if (minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90) {
    return "EPSG:4326";
  }
  return MAP_PROJECTION;
}

function updateProjectionControl() {
  if (!app || projectionSelect.value !== "auto") {
    return;
  }

  projectionSelect.title = `Auto detected ${app.sourceProjection}`;
}

function updateHeaderStats() {
  if (!app) {
    return;
  }
  if (app.mode === FGB_TILE_INDEX_SOURCE_KIND) {
    const totalFeatureCount = app.tiles.reduce((sum, item) => sum + item.count, 0);
    featureCountEl.textContent = totalFeatureCount.toLocaleString();
    nodeSizeEl.textContent = "-";
    levelCountEl.textContent = "-";
    visibleCountEl.textContent = app.visible.length.toLocaleString();
    return;
  }

  featureCountEl.textContent = app.index.featuresCount.toLocaleString();
  nodeSizeEl.textContent = String(app.index.branchingFactor);
  levelCountEl.textContent = String(app.index.levelBounds.length);
}

function updateSelectionStats() {
  if (!app) {
    selectedCountEl.textContent = "0";
    return;
  }
  let count = 0;
  for (const item of app.selected.values()) {
    count += item.count;
  }
  selectedCountEl.textContent = count.toLocaleString();
  clearButton.disabled = app.selected.size === 0;
  openCjLoupeButton.disabled = !canOpenSelectedCjLoupeUrl();
}

function setButtons(enabled) {
  fitButton.disabled = !enabled;
  clearButton.disabled = true;
  openCjLoupeButton.disabled = true;
}

function setSourceModeUi(mode) {
  for (const element of fcbOnlyElements) {
    element.hidden = mode !== FCB_SOURCE_KIND;
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function syncThreshold(value) {
  const threshold = Math.max(1, Number(value) || 1);
  thresholdInput.value = String(Math.min(Number(thresholdInput.max), threshold));
  thresholdNumber.value = String(threshold);
  thresholdValue.textContent = threshold.toLocaleString();
  if (!app) {
    return;
  }
  app.threshold = threshold;
  app.selected.clear();
  clearTimeout(thresholdDebounce);
  if (app.mode === FGB_TILE_INDEX_SOURCE_KIND) {
    updateSelectionStats();
    renderCells();
  } else {
    thresholdDebounce = setTimeout(() => rebuildVisible().catch(showError), 120);
  }
}

function parseNodeItem(bytes, index) {
  return {
    index,
    minX: readF64(bytes, 0),
    minY: readF64(bytes, 8),
    maxX: readF64(bytes, 16),
    maxY: readF64(bytes, 24),
    offset: readU64(bytes, 32),
  };
}

function buildQuadtree(leafIndex, extent, threshold) {
  const leaves = [];
  const maxDepth = 24;
  const minSize = 1e-9;
  const rootBounds = padDegenerateBounds(extent);
  const { centersX, centersY, allIndexes } = leafIndex;

  function split(bounds, bucket, depth, path) {
    if (
      bucket.length <= threshold ||
      depth >= maxDepth ||
      Math.abs(bounds[2] - bounds[0]) <= minSize ||
      Math.abs(bounds[3] - bounds[1]) <= minSize
    ) {
      leaves.push(makeCell(bounds, bucket, depth, path));
      return;
    }

    const midX = (bounds[0] + bounds[2]) / 2;
    const midY = (bounds[1] + bounds[3]) / 2;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < bucket.length; i += 1) {
      const featureIndex = bucket[i];
      const east = centersX[featureIndex] >= midX ? 1 : 0;
      const north = centersY[featureIndex] >= midY ? 2 : 0;
      counts[east + north] += 1;
    }

    const buckets = [
      new Uint32Array(counts[0]),
      new Uint32Array(counts[1]),
      new Uint32Array(counts[2]),
      new Uint32Array(counts[3]),
    ];
    const offsets = [0, 0, 0, 0];
    for (let i = 0; i < bucket.length; i += 1) {
      const featureIndex = bucket[i];
      const east = centersX[featureIndex] >= midX ? 1 : 0;
      const north = centersY[featureIndex] >= midY ? 2 : 0;
      const quadrant = east + north;
      buckets[quadrant][offsets[quadrant]] = featureIndex;
      offsets[quadrant] += 1;
    }

    const childBounds = [
      [bounds[0], bounds[1], midX, midY],
      [midX, bounds[1], bounds[2], midY],
      [bounds[0], midY, midX, bounds[3]],
      [midX, midY, bounds[2], bounds[3]],
    ];

    let emittedChild = false;
    for (let i = 0; i < buckets.length; i += 1) {
      if (buckets[i].length === 0) {
        continue;
      }
      emittedChild = true;
      split(childBounds[i], buckets[i], depth + 1, `${path}${i}`);
    }

    if (!emittedChild) {
      leaves.push(makeCell(bounds, bucket, depth, path));
    }
  }

  split(rootBounds, allIndexes, 0, "r");
  return leaves;
}

function makeCell(bounds, featureIndexes, depth, path) {
  const sortedFeatureIndexes = sortUint32(featureIndexes);
  return {
    key: `q:${path}`,
    bounds,
    depth,
    count: sortedFeatureIndexes.length,
    featureIndexes: sortedFeatureIndexes,
    firstFeature: sortedFeatureIndexes[0] ?? 0,
  };
}

function sortUint32(values) {
  const sorted = new Uint32Array(values);
  sorted.sort();
  return sorted;
}

function padDegenerateBounds(bounds) {
  const padded = [...bounds];
  if (padded[2] <= padded[0]) {
    padded[2] = padded[0] + 1;
  }
  if (padded[3] <= padded[1]) {
    padded[3] = padded[1] + 1;
  }
  return padded;
}

function generateLevelBounds(numItems, nodeSize) {
  const sizes = [];
  let n = numItems;
  let numNodes = n;
  sizes.push(n);
  while (true) {
    n = Math.ceil(n / nodeSize);
    numNodes += n;
    sizes.push(n);
    if (n === 1) {
      break;
    }
  }

  const offsets = [];
  n = numNodes;
  for (const size of sizes) {
    offsets.push(n - size);
    n -= size;
  }
  return sizes.map((size, i) => ({ start: offsets[i], end: offsets[i] + size }));
}

function fieldOffset(bytes, vtable, fieldId) {
  const vtableLength = readU16(bytes, vtable);
  const slot = 4 + fieldId * 2;
  if (slot + 2 > vtableLength) {
    return 0;
  }
  return readU16(bytes, vtable + slot);
}

function readU16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function readI32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true);
}

function readU64(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

function readF64(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0, true);
}

function indicesToSpans(indexes) {
  const sorted = ArrayBuffer.isView(indexes)
    ? indexes
    : [...new Set(indexes)].sort((a, b) => a - b);
  const spans = [];
  let previous = -1;
  for (const index of sorted) {
    if (index === previous) {
      continue;
    }
    const last = spans[spans.length - 1];
    if (last && index === last[1]) {
      last[1] += 1;
    } else {
      spans.push([index, index + 1]);
    }
    previous = index;
  }
  return spans;
}

function indicesToSpansFromCells(cells) {
  let total = 0;
  for (const cell of cells) {
    total += cell.featureIndexes.length;
  }
  const indexes = new Uint32Array(total);
  let offset = 0;
  for (const cell of cells) {
    indexes.set(cell.featureIndexes, offset);
    offset += cell.featureIndexes.length;
  }
  indexes.sort();
  return indicesToSpans(indexes);
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range.end === null || range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || last.end === null || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }
    if (range.end === null) {
      last.end = null;
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }
  return merged;
}

const CJLOUPE_URL = "https://3dgi.github.io/CJLoupe/";

function buildByteRangeCjLoupeUrl(fcbUrl, ranges) {
  const url = new URL(CJLOUPE_URL);
  url.search = "";
  url.hash = "";
  url.searchParams.set("fcbUrl", fcbUrl);
  url.searchParams.set("ranges", encodeCompactRanges(ranges));
  return url.href;
}

function buildCityJsonCjLoupeUrl(cityJsonUrls) {
  const urls = Array.isArray(cityJsonUrls) ? cityJsonUrls : [cityJsonUrls];
  const url = new URL(CJLOUPE_URL);
  url.search = "";
  url.hash = "";
  for (const cityJsonUrl of urls) {
    url.searchParams.append("cj", cityJsonUrl);
  }
  return url.href;
}

function canOpenSelectedCjLoupeUrl() {
  if (!app || app.selected.size === 0) {
    return false;
  }

  if (app.mode === FGB_TILE_INDEX_SOURCE_KIND) {
    const selected = selectedItems();
    return selected.length > 0 && selected.every((item) => Boolean(item.tileUrl));
  }

  return Boolean(app.index.source.url);
}

async function getSelectedCjLoupeUrl() {
  if (!canOpenSelectedCjLoupeUrl()) {
    return null;
  }

  if (app.mode === FGB_TILE_INDEX_SOURCE_KIND) {
    const selected = selectedItems();
    const tileUrls = selected.map((item) => item.tileUrl);
    setStatus(`Building CJLoupe URL for ${selected.length.toLocaleString()} selected ${selected.length === 1 ? "tile" : "tiles"}.`);
    return buildCityJsonCjLoupeUrl(tileUrls);
  }

  setStatus("Resolving feature byte ranges from leaf offsets...");
  const selected = selectedItems();
  const spans = indicesToSpansFromCells(selected);
  const ranges = await app.index.featureByteRanges(spans);
  setStatus(`Resolved ${ranges.length.toLocaleString()} merged byte ranges.`);
  return buildByteRangeCjLoupeUrl(app.index.source.url, ranges);
}

function firstSelectedItem() {
  return selectedItems()[0] ?? null;
}

function selectedItems() {
  return [...app.selected.values()].sort((a, b) => a.firstFeature - b.firstFeature);
}

function encodeCompactRanges(ranges) {
  let previousEnd = 0;
  return ranges.map((range, index) => {
    const startOrDelta = index === 0 ? range.start : range.start - previousEnd;
    const length = range.end === null ? "*" : range.end - range.start;
    previousEnd = range.end ?? range.start;
    return `${startOrDelta}:${length}`;
  }).join(",");
}

function formatCompact(value) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function validExtent(extent) {
  return (
    Array.isArray(extent) &&
    extent.length === 4 &&
    extent.every(Number.isFinite) &&
    extent[2] > extent[0] &&
    extent[3] > extent[1]
  );
}

function matchesMagic(bytes, magic) {
  return magic.every((value, index) => bytes[index] === value);
}

function isLikelyFlatGeobufSource(source) {
  const label = source.label.toLowerCase().split(/[?#]/u)[0];
  return label.endsWith(".fgb") || label.endsWith(".flatgeobuf");
}

function showError(error) {
  console.error(error);
  setStatus(error.message || String(error));
}

function fcbTooltipLines(item) {
  const spans = indicesToSpans(item.featureIndexes);
  const spanLabel = spans.length === 1
    ? `${spans[0][0]}..${spans[0][1]}`
    : `${spans.length} spans`;
  return [
    `cell depth ${item.depth}`,
    `${item.count.toLocaleString()} features`,
    `feature indexes ${spanLabel}`,
  ];
}

function loadUrlValue(url) {
  const trimmed = url.trim();
  if (!trimmed) {
    setStatus("Enter a URL first.");
    return;
  }
  let source;
  try {
    source = new UrlSource(trimmed);
  } catch {
    setStatus(`Invalid URL: ${trimmed}`);
    return;
  }
  urlInput.value = source.url;
  loadSource(source).catch(showError);
}

function initialSourceUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("url") || params.get("index") || params.get("source");
}

loadUrlButton.addEventListener("click", () => {
  loadUrlValue(urlInput.value);
});

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadUrlValue(urlInput.value);
  }
});

thresholdInput.addEventListener("input", () => syncThreshold(thresholdInput.value));
thresholdNumber.addEventListener("change", () => syncThreshold(thresholdNumber.value));

fitButton.addEventListener("click", fitToExtent);

clearButton.addEventListener("click", () => {
  if (!app) {
    return;
  }
  app.selected.clear();
  updateSelectionStats();
  cellsLayer.changed();
});

openCjLoupeButton.addEventListener("click", async () => {
  const url = await getSelectedCjLoupeUrl().catch((error) => {
    showError(error);
    return null;
  });
  if (!url) {
    setStatus(app?.mode === FGB_TILE_INDEX_SOURCE_KIND
      ? "Select a tile from a remote FlatGeobuf tile index first."
      : "Select features from a remote FCB URL first.");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
});

map.on("pointermove", (event) => {
  const feature = map.forEachFeatureAtPixel(event.pixel, (candidate) => candidate, {
    hitTolerance: 3,
  });
  const item = feature?.get("item") ?? null;
  hoveredKey = item?.key || null;
  if (item) {
    const rect = mapEl.getBoundingClientRect();
    const detailLines = item.kind === FGB_TILE_INDEX_SOURCE_KIND
      ? [
          `tile ${item.tileId}`,
          item.filepath,
          `${item.count.toLocaleString()} features`,
        ]
      : fcbTooltipLines(item);
    tooltip.hidden = false;
    tooltip.style.left = `${event.originalEvent.clientX - rect.left + 14}px`;
    tooltip.style.top = `${event.originalEvent.clientY - rect.top + 14}px`;
    tooltip.innerHTML = [
      ...detailLines,
      `${item.bounds[0].toFixed(3)}, ${item.bounds[1].toFixed(3)}`,
      `${item.bounds[2].toFixed(3)}, ${item.bounds[3].toFixed(3)}`,
    ].join("<br>");
  } else {
    tooltip.hidden = true;
  }
  cellsLayer.changed();
});

map.on("singleclick", (event) => {
  if (!app) {
    return;
  }
  const feature = map.forEachFeatureAtPixel(event.pixel, (candidate) => candidate, {
    hitTolerance: 3,
  });
  const item = feature?.get("item") ?? null;
  if (!item) {
    return;
  }
  if (app.selected.has(item.key)) {
    app.selected.delete(item.key);
  } else {
    app.selected.set(item.key, item);
  }
  updateSelectionStats();
  cellsLayer.changed();
});

projectionSelect.addEventListener("change", () => {
  if (!app) {
    return;
  }
  app.sourceProjection = resolveSourceProjection(app.extent);
  renderCells();
  fitToExtent();
  setStatus(`Using ${app.sourceProjection}.`);
});

const sourceUrl = initialSourceUrl();
if (sourceUrl) {
  loadUrlValue(sourceUrl);
}

map.updateSize();
