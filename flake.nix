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
        ticj = pkgs.buildNpmPackage {
          pname = "ticj";
          version = "0.1.0";
          src = ./.;

          npmDepsFetcherVersion = 2;
          npmDepsHash = "sha256-A9xR+d20ewY5SbK4v/d3sJh2sqCbLMKIOg+5hZNHsbQ=";
          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/ticj $out/bin
            cp index_cityjsonl_tiles.js serve_ticj.js package.json $out/lib/ticj/
            cp -R dist $out/lib/ticj/dist
            cp -R node_modules $out/lib/ticj/node_modules
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/ticj \
              --add-flags $out/lib/ticj/serve_ticj.js
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/ticj-index-tiles \
              --add-flags $out/lib/ticj/index_cityjsonl_tiles.js

            runHook postInstall
          '';
        };
      in
      {
        packages = {
          default = ticj;
          index = ticj;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs
          ];
        };

        apps = rec {
          default = serve;

          serve = {
            type = "app";
            program = "${ticj}/bin/ticj";
            meta.description = "Build a CityJSONL tile index and serve TICJ";
          };

          index = {
            type = "app";
            program = "${ticj}/bin/ticj-index-tiles";
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
