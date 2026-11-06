/**
 * eufy-security-client loads a few data files at runtime relative to its own
 * build directory (protobuf schemas for push/MQTT and the MQTT CA cert).
 * Those paths do not survive bundling into a single file / binary, so the
 * build script (scripts/build.mjs) inlines the files here and rewrites the
 * library's `__dirname` to point at EUFY_BRIDGE_ASSET_DIR. At startup we
 * materialize them under <data-dir>/assets.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

// Filled in by esbuild via the `text` loader; see scripts/build.mjs.
// When running unbundled (tests / tsx), the real library files are used instead.
declare const __EUFY_ASSETS__: Record<string, string> | undefined;

export const ASSET_FILES = [
  "push/proto/mcs.proto",
  "push/proto/checkin.proto",
  "mqtt/proto/lock.proto",
  "mqtt/mqtt-eufy.crt",
] as const;

export function bundledAssets(): Record<string, string> | null {
  try {
    return typeof __EUFY_ASSETS__ === "undefined" ? null : __EUFY_ASSETS__;
  } catch {
    return null;
  }
}

/** Writes bundled assets to disk and exports their location for the library. */
export async function materializeAssets(dataDir: string): Promise<string | null> {
  const assets = bundledAssets();
  if (!assets) return null;
  const dir = path.join(dataDir, "assets");
  for (const rel of ASSET_FILES) {
    const content = assets[rel];
    if (content === undefined) continue;
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    let existing: string | null = null;
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      /* missing */
    }
    if (existing !== content) await fs.writeFile(file, content);
  }
  process.env.EUFY_BRIDGE_ASSET_DIR = dir;
  return dir;
}
