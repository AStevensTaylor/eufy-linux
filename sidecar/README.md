# eufy-bridge (sidecar)

The bridge is a small Node 24 program that wraps
[eufy-security-client](https://github.com/bropat/eufy-security-client) and
exposes it to the Tauri shell and the webview over a local, token-authenticated
websocket. The wire protocol is documented in [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md);
the overall design in [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

```
eufy-bridge --port <port> --token <token> --data-dir <dir> [--log-level debug|info|warn|error]
```

It binds `127.0.0.1` only, prints `READY <port>` on stdout once listening, logs to
stderr and exits 0 on SIGTERM/SIGINT. `--port 0` picks a free port.
Environment fallbacks: `EUFY_BRIDGE_PORT`, `EUFY_BRIDGE_TOKEN`, `EUFY_BRIDGE_DATA_DIR`,
`EUFY_BRIDGE_LOG_LEVEL`, `EUFY_BRIDGE_FFMPEG` (path to ffmpeg).

## Requirements

- Node >= 24 (eufy-security-client requires it). `pnpm` for the scripts.
- **ffmpeg** on `PATH` (or `EUFY_BRIDGE_FFMPEG`) for two-way talk: the UI sends raw
  16 kHz mono PCM, the bridge transcodes it to AAC/ADTS with
  `ffmpeg -f s16le -ar 16000 -ac 1 -i pipe:0 -c:a aac -ar 16000 -ac 1 -b:a 32k -f adts pipe:1`.
  Without ffmpeg everything else works; `talkback.start` answers with error code
  `ffmpeg_missing` unless the client sends pre-encoded AAC (`format: "aac"`, frame kind `0x11`).
- [bun](https://bun.sh) only for `pnpm compile` (self-contained binary).

## Scripts

| script | what it does |
| --- | --- |
| `pnpm install --ignore-workspace` | install dependencies (keeps the lockfile local to `sidecar/`) |
| `pnpm build` | bundle `src/index.ts` into `dist/index.js` with esbuild (single ESM file, node24 target) |
| `pnpm dev` | build and run with `--port 0 --token dev --data-dir ../.eufy-data --log-level debug` |
| `pnpm test` | unit tests (`node --test`): frame codec, command dispatcher against a fake eufy client, websocket auth gate, ffmpeg transcoding |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm smoke [binary]` | start `dist/index.js` (or the given binary), wait for `READY`, run `auth.hello`/`bridge.ping`/`auth.status`, SIGTERM |
| `pnpm compile` | build, then `bun build --compile` to `../src-tauri/binaries/eufy-bridge-<target-triple>` (triple from `rustc -vV`, override with `TAURI_TARGET_TRIPLE` or argv) |

In `tauri dev` the Rust side runs `node sidecar/dist/index.js …`; release builds use the
compiled binary from `src-tauri/binaries/`.

## Layout

```
src/index.ts        CLI entry: args, logger, server, signals
src/server.ts       websocket server, auth.hello gate, JSON/binary demux
src/bridge.ts       everything Eufy: auth flow, inventory, events, livestream fan-out, talkback
src/serialize.ts    Device/Station/metadata -> protocol JSON
src/frames.ts       binary frame encoder/decoder
src/talkback.ts     ffmpeg PCM -> AAC transcoder
src/credentials.ts  <data-dir>/credentials.json (0600)
src/eufy-types.ts   structural interface of eufy-security-client the bridge programs against
src/eufy-factory.ts the only module importing eufy-security-client
src/eufy-assets.ts  proto/CA files the library reads at runtime, inlined by the bundler
scripts/build.mjs   esbuild bundle (+ rewrites the library's __dirname for the assets)
scripts/compile.mjs bun --compile wrapper
scripts/smoke.mjs   end-to-end start/ping check
test/               node --test suites with a scripted FakeEufy
```

## Data dir

- `credentials.json` – username/password/country/language/trustedDeviceName, mode 0600.
  Written by `auth.login`, removed by `auth.logout`; auto-connect on start when present.
- `persistent.json` – eufy-security-client's own state (tokens, push credentials). Removed by `auth.logout`.
- `pictures/<serial>.<ext>` – last event thumbnail per device (served by `device.picture`).
- `assets/` – protobuf schemas and the MQTT CA extracted from the bundle at startup.

## Behavioural notes

- `device.event` with `state: true` for ring/motion/person/… is held for up to ~2.5 s so the
  event thumbnail that eufy fetches right after the push notification can be attached
  (`picture`); it is sent immediately once the picture arrives, or without one on timeout.
  `state: false` events are sent at once. Thumbnails arriving later still update the entry
  returned by `events.recent`.
- `livestream.start` on an already running stream re-sends `livestream.started` (with
  metadata) to the new subscriber only. The eufy stream is stopped when the last subscriber
  calls `livestream.stop` or disconnects. eufy-security-client's own 30 s maximum stream
  duration is disabled; if the station ends the stream anyway, clients get
  `livestream.stopped` and simply call `livestream.start` again.
- Talkback requires a running livestream on the same device (library limitation). One owner
  per device; others get `talkback_busy`.
- `events.recent` returns newest first; `limit` defaults to the whole buffer (200).
- warn/error log lines are also broadcast as `bridge.log` events.
