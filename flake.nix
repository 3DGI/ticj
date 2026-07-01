{
  description = "Tile index selector for CJLoupe";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs
          ];
        };

        apps = rec {
          default = index;

          index = {
            type = "app";
            program = "${pkgs.writeShellScript "ticj-index-tiles" ''
              set -euo pipefail
              exec ${pkgs.nodejs}/bin/node index_cityjsonl_tiles.js "$@"
            ''}";
            meta.description = "Build a FlatGeobuf tile index from CityJSONL tiles";
          };

          dev = {
            type = "app";
            program = "${pkgs.writeShellScript "ticj-dev" ''
              set -euo pipefail
              exec ${pkgs.bun}/bin/bun run dev "$@"
            ''}";
            meta.description = "Run the TICJ Vite development server";
          };

          build = {
            type = "app";
            program = "${pkgs.writeShellScript "ticj-build" ''
              set -euo pipefail
              exec ${pkgs.bun}/bin/bun run build "$@"
            ''}";
            meta.description = "Build TICJ for production";
          };
        };
      }
    );
}
