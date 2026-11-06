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
