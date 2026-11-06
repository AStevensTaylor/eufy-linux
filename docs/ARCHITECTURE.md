# Architecture

Eufy Linux is a tray-resident desktop client for Eufy Security devices,
starting with video doorbells. It is a Tauri 2 application with three parts:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Tauri app (src-tauri, Rust)                                          │
│  • tray icon, show/hide/popup main window, single instance, autostart │
│  • spawns + supervises the bridge sidecar, hands its URL/token to UI  │
│  • connects to the bridge (JSON only) for OS notifications w/ images  │
│  • emits Tauri events to the webview ("open-device", "bridge-status") │
├──────────────────────────────────────────────────────────────────────┤
│ Webview UI (src, React + TypeScript + Vite)                          │
│  • login / 2FA / captcha flow, device list, event feed, settings      │
│  • live view: H.264 + AAC from bridge → JMuxer → <video> (MSE)        │
│  • two-way talk: mic → AudioWorklet PCM → bridge (binary frames)      │
│  • connects to the bridge websocket directly (JSON + binary)          │
├──────────────────────────────────────────────────────────────────────┤
│ Bridge sidecar (sidecar, Node 24 + TypeScript)                       │
│  • wraps eufy-security-client (cloud API, push notifications, P2P)    │
│  • local websocket server on 127.0.0.1:<port>, token-authenticated    │
│  • protocol in docs/PROTOCOL.md; multiple clients at once             │
│  • transcodes talkback PCM → AAC (ADTS) with ffmpeg                   │
└──────────────────────────────────────────────────────────────────────┘
```

## Why a Node sidecar?

All of the reverse-engineered Eufy cloud/P2P/push protocol work lives in
[`eufy-security-client`](https://github.com/bropat/eufy-security-client)
(TypeScript). No Rust equivalent exists. Rather than re-implement it, the app
bundles a small Node bridge as a Tauri sidecar binary. Rust owns the desktop
integration; the bridge owns everything Eufy.

## Process lifecycle

1. Rust starts, registers the tray icon and creates the (hidden) main window.
2. Rust picks a free TCP port and a random token, then launches the sidecar:
   `eufy-bridge --port <port> --token <token> --data-dir <app data dir>`.
   In `tauri dev` the sidecar is run as `node sidecar/dist/index.js …` instead.
3. The sidecar prints `READY <port>` on stdout once listening (45 s timeout).
4. Rust connects (for notifications) and exposes `get_bridge_info` to the UI.
   On every (re)connect it asks for `events.recent` so a ring that happened
   during a brief socket drop (< 60 s old, not yet notified) is still shown.
5. The UI connects, sends `auth.hello {token}`, then `state.get`.
6. If the sidecar exits, Rust restarts it with backoff and emits
   `bridge-status` events so the UI can show the state.

## Notifications

The bridge emits `device.event` for rings / motion / person detection, with the
event picture (if any) inline as base64. Rust writes the picture to a temp file
and shows a desktop notification with it as the image. Clicking the
notification, or any ring event (configurable), shows the main window and emits
`open-device { serial, reason }` so the UI switches to that device's live view.

## Video

The bridge forwards the raw H.264 Annex-B NAL stream and AAC (ADTS) audio from
the P2P livestream as binary websocket frames (see PROTOCOL.md). The UI feeds
them to JMuxer which produces fragmented MP4 for Media Source Extensions.
WebKitGTK needs the GStreamer `good`, `bad` and `libav` plugin sets for H.264
MSE playback; the README lists the packages.

## Two-way talk

The UI captures the microphone with `getUserMedia`, down-samples to 16 kHz
mono 16-bit PCM in an AudioWorklet and sends it as binary frames. The bridge
pipes the PCM through `ffmpeg` (`-c:a aac -f adts`) and writes the AAC frames
into eufy-security-client's talkback stream.

## Directory layout

```
src/                  React UI
src-tauri/            Rust Tauri app (tray, notifications, sidecar supervisor)
src-tauri/binaries/   compiled sidecar binaries (git-ignored, built by sidecar)
sidecar/              Node bridge (TypeScript)
docs/                 this file and PROTOCOL.md
```

## Ownership of config files

- `src-tauri/tauri.conf.json`, `src-tauri/capabilities/*` — Rust side.
- `package.json`, `vite.config.ts`, `tsconfig*.json` — frontend side.
- `sidecar/package.json`, `sidecar/tsconfig.json` — sidecar side.

## Rust ⇄ webview contract (Tauri commands and events)

Commands (invoked from the UI with `invoke`):

| command | args | returns |
| --- | --- | --- |
| `get_bridge_info` | – | `{ status: "starting" \| "ready" \| "failed", url: string \| null, token: string \| null, message?: string }` |
| `restart_bridge` | – | `null` |
| `hide_window` | – | `null` (hide to tray) |
| `quit_app` | – | never returns |
| `get_settings` | – | `Settings` |
| `set_settings` | `{ settings: Settings }` | `null` (persists and applies, e.g. autostart) |
| `test_notification` | – | `null` (shows a sample notification) |

Events (emitted by Rust, listened to in the UI with `listen`):

| event | payload |
| --- | --- |
| `bridge-status` | same shape as `get_bridge_info` result |
| `open-device` | `{ serial: string, reason: "ring" \| "motion" \| "person" \| "notification" }` — may fire before the UI is mounted (best effort, no replay) |
| `window-shown` | `{}` |
| `snapshot-saved` | `{ path: string }` — a download started from the UI (snapshot) was written to `~/Pictures/eufy-linux/` |

```ts
type Settings = {
  notifications: {
    enabled: boolean;
    ring: boolean;
    motion: boolean;
    person: boolean;
    other: boolean;
    withImage: boolean;
  };
  popup: {
    onRing: boolean;      // show + focus main window when the doorbell rings
    onMotion: boolean;
    onPerson: boolean;
  };
  autostart: boolean;
  startMinimized: boolean;  // start hidden in the tray
  closeToTray: boolean;     // window close button hides instead of quitting
};
```

Settings are persisted by the Rust side with `tauri-plugin-store` in
`settings.json` inside the app config dir. Defaults: all notifications on with
images, popup on ring only, autostart off, startMinimized true, closeToTray true.

`restart_bridge` kills the sidecar; the UI then sees `bridge-status: starting`
followed by `ready` with a new url/token and must reconnect with the new token.

## Command-line flags

- `--show` forces the main window visible even when `startMinimized` is on.
- `--minimized` forces it hidden (the autostart entry passes this).

## Webview configuration (Linux)

The main window is created in Rust (`src-tauri/src/window.rs`), not from
`tauri.conf.json`, so the WebKitGTK view can be configured: microphone
permission requests (`getUserMedia`, for two-way talk) are granted
automatically, media streams / WebAudio / MSE are enabled, and downloads
started by the UI are routed to the snapshot handler. The webview only needs
the `core` and event-listen capabilities; spawning, settings storage and
autostart all happen on the Rust side.
