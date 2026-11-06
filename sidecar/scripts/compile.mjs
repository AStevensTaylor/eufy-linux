// Produces a self-contained executable for Tauri's sidecar convention:
//   ../src-tauri/binaries/eufy-bridge-<target-triple>
// Requires dist/index.js (run `pnpm build` first; `pnpm compile` does both).
// Uses `bun build --compile` (bun >= 1.1). Override the bun binary with $BUN.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.resolve(root, "../src-tauri/binaries");
const entry = path.join(root, "dist/index.js");

if (!existsSync(entry)) {
  console.error("dist/index.js is missing; run `pnpm build` first");
  process.exit(1);
}

function hostTriple() {
  // Prefer rustc's notion of the host triple, since that's what Tauri uses.
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/^host:\s*(\S+)$/m);
    if (m) return m[1];
  } catch {
    /* rustc not available; derive from node */
  }
  const arch = { x64: "x86_64", arm64: "aarch64", arm: "armv7", ia32: "i686" }[process.arch] ?? process.arch;
  switch (process.platform) {
    case "linux":
      return `${arch}-unknown-linux-gnu`;
    case "darwin":
      return `${arch}-apple-darwin`;
    case "win32":
      return `${arch}-pc-windows-msvc`;
    default:
      return `${arch}-unknown-${process.platform}`;
  }
}

function findBun() {
  const candidates = [process.env.BUN, "bun", path.join(os.homedir(), ".bun/bin/bun"), "/root/.bun/bin/bun"].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { bin: c, version: r.stdout.trim() };
  }
  return null;
}

const triple = process.env.TAURI_TARGET_TRIPLE ?? process.argv[2] ?? hostTriple();
const ext = triple.includes("windows") ? ".exe" : "";
const outFile = path.join(outDir, `eufy-bridge-${triple}${ext}`);
mkdirSync(outDir, { recursive: true });

const bun = findBun();
if (!bun) {
  console.error("bun was not found (needed for `bun build --compile`). Install it from https://bun.sh or set $BUN.");
  process.exit(1);
}
console.log(`compiling ${path.relative(root, entry)} -> ${path.relative(root, outFile)} with bun ${bun.version}`);

// Map the rust triple to a bun --target, if it's not the host.
const bunTargets = {
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};
const args = ["build", "--compile", entry, "--outfile", outFile];
if (triple !== hostTriple() && bunTargets[triple]) args.push("--target", bunTargets[triple]);

const r = spawnSync(bun.bin, args, { stdio: "inherit", cwd: root, env: { ...process.env, BUN_INSTALL_BIN: undefined } });
if (r.status !== 0) {
  console.error("bun build --compile failed");
  process.exit(r.status ?? 1);
}
if (!ext) chmodSync(outFile, 0o755);
console.log(`wrote ${outFile} (${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB)`);
