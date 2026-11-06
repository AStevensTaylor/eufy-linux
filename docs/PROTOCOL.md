# Bridge protocol

The bridge sidecar exposes a websocket server on `ws://127.0.0.1:<port>/`.
Every client (the Rust shell and the webview UI) opens its own connection.
A connection must send `auth.hello` as its first message or it is closed.

Two frame types are used:

- **Text frames** carry one JSON object each.
- **Binary frames** carry media (livestream video/audio, talkback audio).

## JSON messages

### Client → bridge: commands

```json
{ "type": "command", "id": "<client-chosen unique string>", "command": "<name>", "params": { ... } }
```

### Bridge → client: results

```json
{ "type": "result", "id": "<same id>", "ok": true,  "result": { ... } }
{ "type": "result", "id": "<same id>", "ok": false, "error": { "code": "<snake_case>", "message": "<human text>" } }
```

### Bridge → client: events

```json
{ "type": "event", "event": "<name>", "data": { ... } }
```

Events are broadcast to every authenticated client, except livestream /
talkback media which only goes to clients that subscribed (see below).

A connection that fails authentication is closed with code 4400 (malformed
first message), 4401 (hello required / 5 s timeout) or 4403 (bad token).

## Commands

| command | params | result |
| --- | --- | --- |
| `auth.hello` | `{ token: string, client: "ui" \| "shell" }` | `{ version: string, protocol: 1 }` |
| `auth.status` | – | `AuthStatus` |
| `auth.login` | `{ username, password, country?: "GB", language?: "en", trustedDeviceName?: string }` | `{ started: true }` — outcome arrives via `auth.*` events |
| `auth.verify_code` | `{ code: string }` | `{ started: true }` |
| `auth.captcha` | `{ id: string, code: string }` | `{ started: true }` |
| `auth.logout` | – | `{}` — clears stored credentials and persistent data |
| `state.get` | – | `{ auth: AuthStatus, stations: Station[], devices: Device[] }` |
| `devices.list` | – | `Device[]` |
| `device.get` | `{ serial }` | `Device` |
| `device.set_property` | `{ serial, name, value }` | `{}` |
| `device.picture` | `{ serial }` | `{ picture: Picture \| null }` — last event picture |
| `device.quick_response` | `{ serial, voiceId: number }` | `{}` |
| `device.voices` | `{ serial }` | `{ voices: { id: number, name: string }[] }` |
| `station.set_guard_mode` | `{ serial, mode: number }` | `{}` |
| `livestream.start` | `{ serial }` | `{}` — this connection is subscribed to the media frames; if the stream is already running, `livestream.started` is re-sent to this connection only |
| `livestream.stop` | `{ serial }` | `{}` — unsubscribes; stream stops when no subscribers remain |
| `talkback.start` | `{ serial, format?: "pcm" \| "aac" }` | `{}` — requires a running livestream on this connection (`not_streaming`); one talkback per device (`talkback_busy`); `format` defaults to `pcm` (frames `0x10`, transcoded by ffmpeg, error `ffmpeg_missing` if absent) or `aac` (frames `0x11`) |
| `talkback.stop` | `{ serial }` | `{}` |
| `events.recent` | `{ limit?: number }` | `{ events: DeviceEvent[] }` — ring buffer kept by the bridge (last 200), newest first |
| `bridge.ping` | – | `{ pong: true }` |

Credentials given to `auth.login` are stored by the bridge in its data dir (so
the app can reconnect on startup without asking again). `auth.logout` removes
them. The bridge auto-connects on startup when stored credentials exist.

### Error codes

`unauthorized`, `unknown_command`, `invalid_params`, `not_logged_in`,
`device_not_found`, `station_not_found`, `unsupported`, `not_streaming`,
`talkback_busy`, `ffmpeg_missing`, `ffmpeg_error`, `eufy_error`.
`AuthStatus.error.code` may also be `connection_closed` when Eufy drops the
connection while credentials are still stored (state `error`, so the UI can
offer a retry).

## Events

| event | data |
| --- | --- |
| `auth.status` | `AuthStatus` — emitted on every change |
| `auth.tfa_required` | `{}` — call `auth.verify_code` |
| `auth.captcha_required` | `{ id: string, image: string }` — `image` is a data URL (`data:image/...;base64,...`) |
| `auth.error` | `{ code, message }` |
| `station.added` / `station.updated` / `station.removed` | `Station` |
| `device.added` / `device.updated` / `device.removed` | `Device` |
| `device.property_changed` | `{ serial, name, value }` — `picture` is excluded; see `device.event` |
| `device.updated` / `station.updated` | debounced (400 ms) after property bursts and station connect/close |
| `station.property_changed` | `{ serial, name, value }` |
| `device.event` | `DeviceEvent` |
| `livestream.started` | `{ serial, metadata: { videoCodec: "h264" \| "h265" \| "unknown", videoWidth, videoHeight, videoFPS, audioCodec: "aac" \| "aac_lc" \| "aac_eld" \| "none" \| "unknown" } }` |
| `livestream.stopped` | `{ serial }` — subscriptions are retained; call `livestream.start` again to resume. Any talkback on the device is ended too |
| `livestream.error` | `{ serial, code, message }` |
| `talkback.started` | `{ serial }` |
| `talkback.stopped` | `{ serial }` |
| `talkback.error` | `{ serial, code, message }` — `ffmpeg_missing` when `0x10` frames arrive without ffmpeg, `ffmpeg_error` when the transcoder dies (talkback ends) |
| `push.message` | raw push message from eufy-security-client (for debugging/log) |
| `bridge.log` | `{ level: "debug" \| "info" \| "warn" \| "error", message: string }` |

## Types

```ts
type AuthStatus = {
  state: "logged_out" | "connecting" | "tfa_required" | "captcha_required" | "connected" | "error";
  username: string | null;     // stored username, if any
  pushConnected: boolean;
  error?: { code: string; message: string };
};

type Station = {
  serial: string;
  name: string;
  model: string;
  guardMode: number | null;
  currentMode: number | null;
  connected: boolean;          // P2P connection state
  lanIp: string | null;
  properties: Record<string, unknown>;
};

type Device = {
  serial: string;
  stationSerial: string;
  name: string;
  model: string;
  type: number;                // eufy device type id
  kind: "doorbell" | "camera" | "sensor" | "lock" | "other";
  channel: number;
  isDoorbell: boolean;
  isCamera: boolean;
  hasBattery: boolean;
  capabilities: {
    livestream: boolean;
    talkback: boolean;
    quickResponse: boolean;
    snapshot: boolean;
  };
  properties: Record<string, unknown>;   // all public properties from eufy-security-client, except picture
};

type Picture = { mime: string; data: string };   // data = base64 (no data: prefix)

type DeviceEvent = {
  id: string;                  // unique per event
  serial: string;
  stationSerial: string;
  deviceName: string;
  kind: "ring" | "motion" | "person" | "stranger" | "pet" | "vehicle" | "sound" | "crying"
      | "package_delivered" | "package_taken" | "package_stranded" | "loitering"
      | "radar_motion" | "dog" | "low_battery" | "other";
  state: boolean;              // true = started, false = ended (eventDurationSeconds)
  personName?: string;
  title?: string;              // from the push message where available
  content?: string;
  timestamp: number;           // ms since epoch
  picture?: Picture;           // present when eufy delivered an event thumbnail
};

// Picture timing: a `state: true` event of a picture-bearing kind is held for
// up to 2.5 s waiting for the thumbnail that follows the push notification; it
// is emitted without `picture` on timeout. Pictures arriving within 15 s are
// patched into the entry returned by `events.recent`. `title`, `content` and
// `personName` come from the matching push message when one arrived within 15 s.
```

## Binary frames

All binary frames start with a 1-byte `kind`, then a 1-byte serial length `n`,
then `n` bytes of ASCII device serial, then the payload.

```
+------+------+----------------+-------------------+
| kind | n    | serial (n)     | payload           |
+------+------+----------------+-------------------+
```

| kind | direction | payload |
| --- | --- | --- |
| `0x01` | bridge → client | livestream video chunk: H.264 Annex-B NAL unit(s) (start-code prefixed) as delivered by eufy-security-client |
| `0x02` | bridge → client | livestream audio chunk: AAC ADTS frame(s) |
| `0x10` | client → bridge | talkback audio: raw PCM, signed 16-bit little-endian, 16 kHz, mono |
| `0x11` | client → bridge | talkback audio: AAC ADTS frames (already encoded; passed through) |

The bridge only forwards media to connections that ran `livestream.start` for
that serial. A client that disconnects is unsubscribed automatically, and a
talkback it owned is stopped.

## Sidecar process contract

```
eufy-bridge --port <port> --token <token> --data-dir <dir> [--log-level info]
```

- Binds `127.0.0.1:<port>` (port `0` = pick a free one).
- Prints `READY <port>` as a single line on stdout once listening.
- Logs go to stderr, one line per entry.
- Exits with code 0 on SIGTERM / SIGINT after closing eufy connections.
- Writes persistent state under `<data-dir>`: `persistent.json`
  (eufy-security-client), `credentials.json` (0600), `pictures/<serial>.<ext>`
  (last thumbnail per device) and `assets/` (protobuf/CA files the library
  loads from disk). `auth.logout` removes credentials, persistent data and
  pictures.
- `dist/index.js` is a single ESM bundle; the compiled binary is produced
  with `bun build --compile`.
