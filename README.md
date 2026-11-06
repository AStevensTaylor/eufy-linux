# Eufy Linux

A tray-resident Linux desktop client for Eufy Security devices, starting with
video doorbells. It aims to offer what the mobile app offers:

- **Notifications with images** for rings, motion and person detection, shown
  as native desktop notifications with the event thumbnail.
- **Live video** from the doorbell (H.264 + AAC via the Eufy P2P protocol).
- **Two-way talk** through the doorbell, plus quick-response voice messages.
- **Pops up when something happens**: the window hides to the tray and is
  brought forward when the doorbell rings (configurable).

Built with [Tauri 2](https://tauri.app) (Rust shell + React/TypeScript UI) and a
bundled Node sidecar that wraps
[eufy-security-client](https://github.com/bropat/eufy-security-client).
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/PROTOCOL.md](docs/PROTOCOL.md) for how the pieces fit together.

## Status

Early development. Doorbells (ring / motion / person events, live view,
talkback) are the first target; other camera types should work for live view
and events because they share the same client library, but are untested.

## Quick start

```sh
export PATH=/opt/node24/bin:$PATH      # Node 24 (eufy-security-client needs >= 24)
pnpm install --ignore-workspace         # UI deps
pnpm sidecar:install && pnpm sidecar:build   # bridge → sidecar/dist/index.js
pnpm tauri dev -- -- --show             # run the app (starts hidden in the tray without --show)
```

For a packaged build, compile the sidecar binary first, then bundle:

```sh
pnpm sidecar:compile                    # → src-tauri/binaries/eufy-bridge-<triple> (needs bun)
pnpm tauri build                        # → src-tauri/target/release/bundle/{deb,rpm,appimage}
```

`pnpm check` runs every test suite, the type checks and clippy.

Runtime requirements on the target machine: `ffmpeg` (two-way talk) and the
GStreamer `good`, `bad` and `libav` plugin sets (H.264 live video in WebKitGTK).

## Building

The desktop shell lives in `src-tauri/` (Rust, Tauri 2). It needs Rust 1.85+ and
the usual Tauri Linux packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, `libxdo-dev`,
`patchelf`).

```sh
# compile + unit tests of the shell alone (no display server needed)
cd src-tauri
scripts/ensure-sidecar-placeholder.sh   # once; see "Sidecar binary" below
cargo build
cargo test
cargo clippy --all-targets
```

### Sidecar binary

`tauri.conf.json` declares `bundle.externalBin: ["binaries/eufy-bridge"]`, so
Tauri expects `src-tauri/binaries/eufy-bridge-<target-triple>` (for example
`eufy-bridge-x86_64-unknown-linux-gnu`) to exist at build time. The real file is
produced by the sidecar build (`pnpm --filter sidecar build`) and is git-ignored.
Until it exists, `src-tauri/scripts/ensure-sidecar-placeholder.sh` writes a stub
that only prints an error, which is enough for `cargo build` / `cargo test`.

### Development bridge

In debug builds (`cargo build`, `pnpm tauri dev`) the shell does not run the
sidecar binary; it runs `node sidecar/dist/index.js --port … --token … --data-dir …`
(preferring `/opt/node24/bin/node`, else `node` from `PATH`). Environment
variables:

| variable | effect |
| --- | --- |
| `EUFY_BRIDGE_DEV=1` / `0` | force the node bridge on (also in release builds) or off (use the sidecar binary even in debug builds) |
| `EUFY_BRIDGE_SCRIPT=/path/to/index.js` | bridge script to run instead of `sidecar/dist/index.js` |
| `EUFY_NODE=/path/to/node` | node executable to use |

If the script is missing the shell falls back to the sidecar binary and logs a
warning. Start the app with `--show` to force the window to open even when
`startMinimized` is on; `--minimized` (added by the autostart entry) forces it
hidden.

### Webview specifics (Linux)

The main window is created in Rust (`src-tauri/src/window.rs`), not from
`tauri.conf.json`, so the WebKitGTK view can be configured: `getUserMedia`
permission requests (microphone for two-way talk) are granted automatically,
and media streams, WebAudio and MSE are enabled. This pins the `webkit2gtk`
crate to the version wry links against (`cargo tree -i webkit2gtk`); bump it
together with Tauri. Downloads started by the UI (snapshots) are written to
`~/Pictures/eufy-linux/snapshot-<YYYYMMDD-HHMMSS>.<ext>` (or the app data dir
when there is no pictures dir) and announced with a `snapshot-saved { path }`
event.

### Packaging

`pnpm tauri build` produces `.deb`, `.rpm` and `.AppImage` bundles. The deb/rpm
packages depend on `ffmpeg` and the GStreamer `good`, `bad` and `libav` plugin
sets, which WebKitGTK needs for H.264 playback; the AppImage bundles the media
framework. Logs go to stdout and to `~/.local/share/dev.astevenstaylor.eufy-linux/logs/`;
settings are stored in `~/.config/dev.astevenstaylor.eufy-linux/settings.json`.

## Frontend

The webview UI lives in `src/` (Vite + React 19 + TypeScript). It talks to the
bridge sidecar directly over its websocket (`src/lib/bridge.ts`, protocol in
`docs/PROTOCOL.md`) and to the Rust shell through a few Tauri commands/events
(`src/lib/tauri.ts`, contract in `docs/ARCHITECTURE.md`).

```
export PATH=/opt/node24/bin:$PATH   # Node 24
pnpm install --ignore-workspace     # root deps only; the sidecar installs its own
pnpm dev                            # Vite on http://localhost:1420 (what `tauri dev` loads)
pnpm build                          # tsc + vite build → dist/
pnpm test                           # vitest: frame codec, bridge client, PCM, reducers
```

Layout:

- `src/lib/types.ts` – protocol types; `frames.ts` – binary frame codec;
  `bridge.ts` – `BridgeClient` (calls, events, media subscriptions, reconnect).
- `src/lib/player.ts` – livestream → JMuxer → `<video>` (MSE);
  `talkback.ts` + `public/worklets/pcm-worklet.js` – mic → 16 kHz PCM frames.
- `src/lib/store.tsx` – app state (React context + reducer) and the single
  `BridgeClient` instance; `src/views/*` – Login, Devices, LiveView, Events,
  Settings.

Running `pnpm dev` in a plain browser (outside Tauri) shows a "bridge
unavailable" screen with a manual URL/token form, so the UI can be developed
against a hand-started sidecar (`eufy-bridge --port 8765 --token …`).

Live video needs WebKitGTK to support H.264 via Media Source Extensions:
install the GStreamer `good`, `bad` and `libav` plugin sets (for example
`gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav` on
Debian/Ubuntu).

## Bridge sidecar (`sidecar/`)

Everything Eufy (cloud login, push notifications, P2P livestream, two-way talk)
lives in a small Node 24 bridge that the Tauri shell spawns as a sidecar and
talks to over a local websocket (see `docs/ARCHITECTURE.md` and `docs/PROTOCOL.md`).

```sh
cd sidecar
pnpm install --ignore-workspace   # Node >= 24 required
pnpm test && pnpm typecheck
pnpm build        # -> sidecar/dist/index.js (used by `tauri dev`)
pnpm compile      # -> src-tauri/binaries/eufy-bridge-<target-triple> (needs bun)
pnpm smoke        # starts the bridge, waits for READY, pings it over the websocket
```

Two-way talk needs `ffmpeg` on the PATH at runtime (PCM from the microphone is
transcoded to AAC/ADTS). Credentials and eufy state are stored under the app
data dir passed as `--data-dir`. Details in `sidecar/README.md`.
