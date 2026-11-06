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
| `livestream.start` | `{ serial }` | `{}` — this connection is subscribed to the media frames |
| `livestream.stop` | `{ serial }` | `{}` — unsubscribes; stream stops when no subscribers remain |
| `talkback.start` | `{ serial }` | `{}` — only one talkback per device at a time |
| `talkback.stop` | `{ serial }` | `{}` |
| `events.recent` | `{ limit?: number }` | `{ events: DeviceEvent[] }` — ring buffer kept by the bridge (last 200) |
| `bridge.ping` | – | `{ pong: true }` |

Credentials given to `auth.login` are stored by the bridge in its data dir (so
the app can reconnect on startup without asking again). `auth.logout` removes
them. The bridge auto-connects on startup when stored credentials exist.

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
| `station.property_changed` | `{ serial, name, value }` |
| `device.event` | `DeviceEvent` |
| `livestream.started` | `{ serial, metadata: { videoCodec: "h264" \| "h265" \| "unknown", videoWidth, videoHeight, videoFPS, audioCodec: "aac" \| "aac_lc" \| "aac_eld" \| "none" \| "unknown" } }` |
| `livestream.stopped` | `{ serial }` |
| `livestream.error` | `{ serial, code, message }` |
| `talkback.started` | `{ serial }` |
| `talkback.stopped` | `{ serial }` |
| `talkback.error` | `{ serial, code, message }` |
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
- Writes persistent state (eufy-security-client persistent data, stored
  credentials, event pictures) under `<data-dir>`.
