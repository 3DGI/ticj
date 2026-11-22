import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deserialize, serialize } from "flatgeobuf/lib/mjs/geojson.js";
import { buildTileIndex } from "./index_cityjsonl_tiles.js";
import { tileIndexFeatureToItem } from "./tile-index.js";

const indexUrl = "https://3dbag.fsn1.your-objectstorage.com/v20250903/tile_index.fgb";
const downloadUrl = "https://3dbag.fsn1.your-objectstorage.com/v20250903/tiles/8/760/72/8-760-72.city.json.gz";
// Representative feature from the 3DBAG v20250903 index: no filepath,
// bounding-box properties, or feature_count.
const bagFeature = {
  type: "Feature",
  properties: { tile_id: "8/760/72", cj_download: downloadUrl },
  geometry: {
    type: "Polygon",
    coordinates: [[
      [203593.331, 324890.397], [205593.331, 324890.397],
      [205593.331, 326890.397], [203593.331, 326890.397],
      [203593.331, 324890.397],
    ]],
  },
};

test("loads a 3DBAG download URL and polygon bounds from FlatGeobuf", async () => {
  const bytes = serialize({ type: "FeatureCollection", features: [bagFeature] }, 28992);
  const features = [];
  for await (const feature of deserialize(bytes)) features.push(feature);
  const tile = tileIndexFeatureToItem(features[0], 0, indexUrl);
  assert.equal(tile.tileId, "8/760/72");
  assert.equal(tile.tileUrl, downloadUrl);
  assert.deepEqual(tile.bounds, [203593.331, 324890.397, 205593.331, 326890.397]);
  assert.equal(tile.count, null);
  assert.equal(tile.validity, null);
});

test("round-trips file-wide val3dity verdicts alongside unvalidated tiles", async (t) => {
  const inputDir = await mkdtemp(path.join(tmpdir(), "ticj-tiles-"));
  t.after(() => rm(inputDir, { recursive: true, force: true }));
  const output = path.join(inputDir, "tile_index.fgb");
  const expected = { "a-unknown": null, "b-invalid": false, "c-valid": true };

  for (const [tileId, validity] of Object.entries(expected)) {
    const header = { type: "CityJSON", version: "2.0", CityObjects: {}, vertices: [] };
    if (validity !== null) {
      header["+val3dity-report"] = { val3dity_version: "2.7.0", validity };
    }
    const feature = { type: "CityJSONFeature", vertices: [[0, 0, 0], [1, 1, 0]] };
    const jsonl = [header, feature].map((record) => JSON.stringify(record)).join("\n");
    await writeFile(path.join(inputDir, `${tileId}.city.jsonl`), jsonl);
  }

  await buildTileIndex({ inputDir, output, logger: { log() {} } });
  const actual = {};
  for await (const feature of deserialize(await readFile(output))) {
    const tile = tileIndexFeatureToItem(feature, 0, indexUrl);
    assert.equal(feature.properties.validity, expected[tile.tileId] ?? undefined);
    actual[tile.tileId] = tile.validity;
  }
  assert.deepEqual(actual, expected);
});

test("preserves filepath indexes with explicit bounds and feature counts", () => {
  const tile = tileIndexFeatureToItem({
    properties: {
      tile_id: "2-48-16", filepath: "seq/2-48-16.city.jsonl", feature_count: 256,
      minx: 100000, miny: 400000, maxx: 101000, maxy: 401000,
    },
  }, 3, indexUrl);
  assert.equal(tile.tileUrl, new URL("seq/2-48-16.city.jsonl", indexUrl).href);
  assert.equal(tile.count, 256);
  assert.equal(tile.firstFeature, 3);
  assert.deepEqual(tile.bounds, [100000, 400000, 101000, 401000]);
});

test("prefers filepath and falls back to cj_download when filepath is empty", () => {
  const feature = { ...bagFeature, properties: { ...bagFeature.properties, filepath: "local.city.jsonl" } };
  assert.equal(tileIndexFeatureToItem(feature, 0, indexUrl).tileUrl, new URL("local.city.jsonl", indexUrl).href);
  feature.properties.filepath = " ";
  assert.equal(tileIndexFeatureToItem(feature, 0, indexUrl).tileUrl, downloadUrl);
  feature.properties.cj_download = "tiles/relative.city.json.gz";
  assert.equal(tileIndexFeatureToItem(feature, 0, indexUrl).tileUrl, new URL(feature.properties.cj_download, indexUrl).href);
});

test("keeps unknown counts distinct from an empty tile", () => {
  for (const feature_count of [undefined, null, "", -1, "unknown"]) {
    const feature = { ...bagFeature, properties: { ...bagFeature.properties, feature_count } };
    assert.equal(tileIndexFeatureToItem(feature, 0, indexUrl).count, null);
  }
  const feature = { ...bagFeature, properties: { ...bagFeature.properties, feature_count: 0 } };
  assert.equal(tileIndexFeatureToItem(feature, 0, indexUrl).count, 0);
});

test("skips features missing a path or usable geometry", () => {
  assert.equal(tileIndexFeatureToItem({ ...bagFeature, properties: {} }, 0, indexUrl), null);
  assert.equal(tileIndexFeatureToItem({ ...bagFeature, geometry: null }, 0, indexUrl), null);
});

test("uses geometry when bound properties are incomplete", () => {
  const feature = { ...bagFeature, properties: {
    ...bagFeature.properties, minx: null, miny: null, maxx: 205593.331, maxy: 326890.397,
  } };
  assert.deepEqual(tileIndexFeatureToItem(feature, 0, indexUrl).bounds, [203593.331, 324890.397, 205593.331, 326890.397]);
});
