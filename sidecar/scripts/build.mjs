// Bundles src/index.ts into dist/index.js (single CommonJS file, node24 target).
//
// eufy-security-client reads a few data files relative to its own build dir at
// runtime (protobuf schemas, MQTT CA cert). A bundle has no such directory, so
// we (1) inline those files as strings into the bundle and (2) rewrite the
// library's `__dirname` in the affected modules to point at
// process.env.EUFY_BRIDGE_ASSET_DIR, which src/eufy-assets.ts populates at
// startup. See src/eufy-assets.ts.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const escRoot = path.dirname(require.resolve("eufy-security-client/package.json"));
const escBuild = path.join(escRoot, "build");
const ASSET_FILES = ["push/proto/mcs.proto", "push/proto/checkin.proto", "mqtt/proto/lock.proto", "mqtt/mqtt-eufy.crt"];
const assets = Object.fromEntries(ASSET_FILES.map((rel) => [rel, readFileSync(path.join(escBuild, rel), "utf8")]));

/** Rewrites __dirname in eufy-security-client modules that load data files. */
const eufyAssetPlugin = {
  name: "eufy-asset-dirname",
  setup(b) {
    const dirs = ["push", "mqtt"];
    b.onLoad({ filter: /eufy-security-client[\\/]build[\\/](push|mqtt)[\\/][^\\/]+\.js$/ }, (args) => {
      const sub = dirs.find((d) => args.path.includes(`${path.sep}build${path.sep}${d}${path.sep}`));
      let contents = readFileSync(args.path, "utf8");
      if (contents.includes("__dirname")) {
        contents = contents.replace(
          /\b__dirname\b/g,
          `(process.env.EUFY_BRIDGE_ASSET_DIR ? require("path").join(process.env.EUFY_BRIDGE_ASSET_DIR, ${JSON.stringify(sub)}) : __dirname)`,
        );
      }
      return { contents, loader: "js" };
    });
  },
};

const watch = process.argv.includes("--watch");

const result = await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: process.argv.includes("--sourcemap") ? "inline" : false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
  define: {
    __BRIDGE_VERSION__: JSON.stringify(pkg.version),
    __EUFY_ASSETS__: JSON.stringify(assets),
  },
  // ESM output (the package is "type": "module"), with CommonJS shims so the
  // bundled CJS dependencies (and our __dirname rewrite) keep working.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  plugins: [eufyAssetPlugin],
  metafile: true,
});

if (watch) {
  console.log("watch mode is not implemented; run the build again after changes");
}
const out = Object.entries(result.metafile.outputs).find(([k]) => k.endsWith("index.js"));
if (out) console.log(`bundled ${out[0]} (${(out[1].bytes / 1024 / 1024).toFixed(1)} MB)`);
