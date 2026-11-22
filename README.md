# ticj

`ticj` is a lightweight browser tool for selecting CityJSON inputs for CJLoupe.

It supports two source types:

- FlatCityBuf `.fcb` files: reads the header and packed R-tree leaf nodes, renders a quadtree overlay, and builds CJLoupe URLs with compact feature byte ranges.
- FlatGeobuf `.fgb` tile indexes: reads tile polygons with `tile_id` and either `filepath` or `cj_download`, then opens the selected tile URLs in CJLoupe. Bounds can come from `minx`, `miny`, `maxx`, `maxy` properties or the polygon geometry. If `feature_count` is absent, the statistics show tile counts.

For remote FlatGeobuf indexes, relative `filepath` values are resolved against the parent URL of the `.fgb` file.
Relative `cj_download` values are resolved the same way; `filepath` takes precedence when both are present.

For example, load the 3DBAG index by pasting this URL into the URL field:

```text
https://3dbag.fsn1.your-objectstorage.com/v20250903/tile_index.fgb
```

## Usage

```sh
bun install
bun run dev
```

Then open the URL printed by Vite.

With Nix:

```sh
nix develop
bun install
bun run dev
```

You can also run the flake apps directly:

```sh
nix run .#dev
nix run .#build
```

You can load remote FCB or FGB tile index URLs. Remote FCB files must support CORS and HTTP Range requests. Remote FGB tile indexes must support CORS.

To load an index on startup, pass it as a URL parameter:

```text
https://example.com/ticj/?index=https%3A%2F%2Fexample.com%2Ftile_index.fgb
```

## Build a CityJSONL tile index

```sh
bun run index:tiles -- ./seq ./tile_index.fgb --overwrite
```

With Nix:

```sh
nix run . -- ./seq ./tile_index.fgb --overwrite
```

From the remote repository, build only the tile index with:

```sh
nix run github:3dgi/ticj#index -- ./seq ./tile_index.fgb --overwrite
```

To build (or reuse) `./seq/tile_index.fgb` and launch TICJ for that directory:

```sh
nix run github:3dgi/ticj -- ./seq --reindex
```

The indexer uses the trailing numeric `x-y-z` portion of each tile filename as
`tile_id`; for example, `reconstruction-2-48-16.city.jsonl` is indexed as
`2-48-16`.

The indexer reads the file-wide verdict from `+val3dity-report.validity` in the
[val3dity extension](https://github.com/cityjson/extensions/tree/main/extensions/val3dity/0.3.0)
and stores it as the Boolean `validity` tile attribute. The viewer colors valid
tiles green and invalid tiles red. Tiles without a verdict use the default tile
style.

The `error_counts` attribute contains counts grouped by LoD and error code.
The indexer uses detailed diagnostics when available for a code and falls back
to the report summary for other codes. Dataset errors and errors without a
resolvable LoD appear under **Unspecified**. Select tiles to inspect their counts,
or expand **All tiles** to see totals and coverage for the full index. Rebuild
an existing index with `--overwrite` to include this data.

The indexer is a Node.js script that uses the existing `flatgeobuf` package, so it does not require GDAL/OGR.
