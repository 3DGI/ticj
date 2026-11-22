import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deserialize, serialize } from "flatgeobuf/lib/mjs/geojson.js";
import { buildTileIndex } from "./index_cityjsonl_tiles.js";
import { aggregateTileErrors, tileIndexFeatureToItem } from "./tile-index.js";

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
  assert.equal(tile.errorCounts, null);
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
  const tiles = [];
  for await (const feature of deserialize(await readFile(output))) {
    const tile = tileIndexFeatureToItem(feature, 0, indexUrl);
    assert.equal(feature.properties.validity, expected[tile.tileId] ?? undefined);
    assert.deepEqual(tile.errorCounts, []);
    actual[tile.tileId] = tile.validity;
    tiles.push(tile);
  }
  assert.deepEqual(actual, expected);
  assert.deepEqual(aggregateTileErrors(tiles), { errorCounts: [], total: 0, tileCount: 1 });
});

test("indexes val3dity occurrences by LoD and aggregates counts across tiles", async (t) => {
  const inputDir = await mkdtemp(path.join(tmpdir(), "ticj-errors-"));
  t.after(() => rm(inputDir, { recursive: true, force: true }));
  const output = path.join(inputDir, "tile_index.fgb");
  const header = {
    type: "CityJSON",
    version: "2.0",
    "geometry-templates": { templates: [{ lod: "2.2" }] },
    "+val3dity-report": {
      val3dity_version: "2.7.0",
      validity: false,
      error_code_summary: [{ code: 203, count: 8 }, { code: 305, count: 3 }],
      dataset_errors: [{ code: 901 }, { code: 901 }],
    },
  };
  const feature = {
    type: "CityJSONFeature",
    vertices: [[0, 0, 0], [1, 1, 0]],
    CityObjects: {
      building: {
        geometry: [{ lod: "1.2" }, { lod: "2.2" }],
        attributes: {
          "+val3dity-validation": {
            validity: false,
            geometries: [
              { geometryIndex: 0, errors: [{ code: 203 }, { code: 203 }] },
              { geometryIndex: 1, errors: [{ code: 203 }] },
              { geometryIndex: 99, errors: [{ code: 401 }] },
            ],
            features: [
              { code: 601, sourceId: "coid=building|geom=1&&coid=part|geom=0" },
              { code: 602, sourceId: "coid=building|geom=0&&coid=part|geom=0" },
            ],
          },
        },
      },
      part: { geometry: [{ type: "GeometryInstance", template: 0 }] },
    },
  };
  const otherFeature = {
    type: "CityJSONFeature",
    vertices: [[2, 2, 0], [3, 3, 0]],
    CityObjects: {
      other: {
        geometry: [{ lod: 1.2 }],
        attributes: {
          "+val3dity-validation": {
            validity: false,
            geometries: [{ geometryIndex: 0, errors: [{ code: 203 }] }],
          },
        },
      },
    },
  };
  const records = [header, feature, otherFeature].map((record) => JSON.stringify(record));
  await writeFile(path.join(inputDir, "a.city.jsonl"), records.join("\n"));
  await writeFile(path.join(inputDir, "b.city.jsonl"), JSON.stringify(otherFeature));

  await buildTileIndex({ inputDir, output, logger: { log() {} } });
  const tiles = [];
  for await (const indexedTile of deserialize(await readFile(output))) {
    const tile = tileIndexFeatureToItem(indexedTile, tiles.length, indexUrl);
    assert.deepEqual(tile.errorCounts, indexedTile.properties.error_counts);
    tiles.push(tile);
  }
  const firstTileCounts = [
    { lod: "1.2", code: 203, count: 3 },
    { lod: "2.2", code: 203, count: 1 },
    { lod: "2.2", code: 601, count: 1 },
    { lod: null, code: 305, count: 3 },
    { lod: null, code: 401, count: 1 },
    { lod: null, code: 602, count: 1 },
    { lod: null, code: 901, count: 2 },
  ];
  assert.deepEqual(tiles.map(({ tileId, errorCounts }) => [tileId, errorCounts]), [
    ["a", firstTileCounts],
    ["b", [{ lod: "1.2", code: 203, count: 1 }]],
  ]);
  assert.deepEqual(aggregateTileErrors(tiles), {
    errorCounts: [{ lod: "1.2", code: 203, count: 4 }, ...firstTileCounts.slice(1)],
    total: 13,
    tileCount: 2,
  });
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
