# ticj

`ticj` is a lightweight browser tool for selecting CityJSON inputs for CJLoupe.

It supports two source types:

- FlatCityBuf `.fcb` files: reads the header and packed R-tree leaf nodes, renders a quadtree overlay, and builds CJLoupe URLs with compact feature byte ranges.
- FlatGeobuf `.fgb` tile indexes: reads tile polygons with `tile_id`, `filepath`, bounds, and `feature_count`, then opens the selected tile filepath or selected tile filepaths in CJLoupe.

For remote FlatGeobuf indexes, relative `filepath` values are resolved against the parent URL of the `.fgb` file.

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

You can load local files or remote URLs. Remote FCB files must support CORS and HTTP Range requests. Remote FGB tile indexes must support CORS.

## Build a CityJSONL tile index

```sh
bun run index:tiles -- ./seq ./tile_index.fgb --overwrite
```

With Nix:

```sh
nix run . -- ./seq ./tile_index.fgb --overwrite
```

The indexer is a Node.js script that uses the existing `flatgeobuf` package, so it does not require GDAL/OGR.
