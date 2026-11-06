/**
 * Shared TypeScript types for the bridge websocket protocol.
 * Source of truth: docs/PROTOCOL.md.
 */

export type AuthState =
  | "logged_out"
  | "connecting"
  | "tfa_required"
  | "captcha_required"
  | "connected"
  | "error";

export type BridgeError = { code: string; message: string };

export type AuthStatus = {
  state: AuthState;
  username: string | null;
  pushConnected: boolean;
  error?: BridgeError;
};

export type Station = {
  serial: string;
  name: string;
  model: string;
  guardMode: number | null;
  currentMode: number | null;
  connected: boolean;
  lanIp: string | null;
  properties: Record<string, unknown>;
};

export type DeviceKind = "doorbell" | "camera" | "sensor" | "lock" | "other";

export type Device = {
  serial: string;
  stationSerial: string;
  name: string;
  model: string;
  type: number;
  kind: DeviceKind;
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
  properties: Record<string, unknown>;
};

/** `data` is base64 without the `data:` prefix. */
export type Picture = { mime: string; data: string };

export type DeviceEventKind =
  | "ring"
  | "motion"
  | "person"
  | "stranger"
  | "pet"
  | "vehicle"
  | "sound"
  | "crying"
  | "package_delivered"
  | "package_taken"
  | "package_stranded"
  | "loitering"
  | "radar_motion"
  | "dog"
  | "low_battery"
  | "other";

export type DeviceEvent = {
  id: string;
  serial: string;
  stationSerial: string;
  deviceName: string;
  kind: DeviceEventKind;
  state: boolean;
  personName?: string;
  title?: string;
  content?: string;
  timestamp: number;
  picture?: Picture;
};

export type VideoCodec = "h264" | "h265" | "unknown";
export type AudioCodec = "aac" | "aac_lc" | "aac_eld" | "none" | "unknown";

export type LivestreamMetadata = {
  videoCodec: VideoCodec;
  videoWidth: number;
  videoHeight: number;
  videoFPS: number;
  audioCodec: AudioCodec;
};

export type Voice = { id: number; name: string };

export type PropertyChanged = { serial: string; name: string; value: unknown };

export type LogLevel = "debug" | "info" | "warn" | "error";

// ---------------------------------------------------------------------------
// Commands: params and results, keyed by command name.
// ---------------------------------------------------------------------------

export type CommandMap = {
  "auth.hello": {
    params: { token: string; client: "ui" | "shell" };
    result: { version: string; protocol: 1 };
  };
  "auth.status": { params: undefined; result: AuthStatus };
  "auth.login": {
    params: {
      username: string;
      password: string;
      country?: string;
      language?: string;
      trustedDeviceName?: string;
    };
    result: { started: true };
  };
  "auth.verify_code": { params: { code: string }; result: { started: true } };
  "auth.captcha": { params: { id: string; code: string }; result: { started: true } };
  "auth.logout": { params: undefined; result: Record<string, never> };
  "state.get": {
    params: undefined;
    result: { auth: AuthStatus; stations: Station[]; devices: Device[] };
  };
  "devices.list": { params: undefined; result: Device[] };
  "device.get": { params: { serial: string }; result: Device };
  "device.set_property": {
    params: { serial: string; name: string; value: unknown };
    result: Record<string, never>;
  };
  "device.picture": { params: { serial: string }; result: { picture: Picture | null } };
  "device.quick_response": {
    params: { serial: string; voiceId: number };
    result: Record<string, never>;
  };
  "device.voices": { params: { serial: string }; result: { voices: Voice[] } };
  "station.set_guard_mode": {
    params: { serial: string; mode: number };
    result: Record<string, never>;
  };
  "livestream.start": { params: { serial: string }; result: Record<string, never> };
  "livestream.stop": { params: { serial: string }; result: Record<string, never> };
  "talkback.start": { params: { serial: string }; result: Record<string, never> };
  "talkback.stop": { params: { serial: string }; result: Record<string, never> };
  "events.recent": { params: { limit?: number } | undefined; result: { events: DeviceEvent[] } };
  "bridge.ping": { params: undefined; result: { pong: true } };
};

export type CommandName = keyof CommandMap;
export type CommandParams<C extends CommandName> = CommandMap[C]["params"];
export type CommandResult<C extends CommandName> = CommandMap[C]["result"];

// ---------------------------------------------------------------------------
// Events: payloads keyed by event name.
// ---------------------------------------------------------------------------

export type EventMap = {
  "auth.status": AuthStatus;
  "auth.tfa_required": Record<string, never>;
  "auth.captcha_required": { id: string; image: string };
  "auth.error": BridgeError;
  "station.added": Station;
  "station.updated": Station;
  "station.removed": Station;
  "device.added": Device;
  "device.updated": Device;
  "device.removed": Device;
  "device.property_changed": PropertyChanged;
  "station.property_changed": PropertyChanged;
  "device.event": DeviceEvent;
  "livestream.started": { serial: string; metadata: LivestreamMetadata };
  "livestream.stopped": { serial: string };
  "livestream.error": { serial: string; code: string; message: string };
  "talkback.started": { serial: string };
  "talkback.stopped": { serial: string };
  "talkback.error": { serial: string; code: string; message: string };
  "push.message": unknown;
  "bridge.log": { level: LogLevel; message: string };
};

export type EventName = keyof EventMap;
export type EventData<E extends EventName> = EventMap[E];

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type WireCommand = {
  type: "command";
  id: string;
  command: string;
  params?: unknown;
};

export type WireResult =
  | { type: "result"; id: string; ok: true; result: unknown }
  | { type: "result"; id: string; ok: false; error: BridgeError };

export type WireEvent = { type: "event"; event: string; data: unknown };

export type WireMessage = WireCommand | WireResult | WireEvent;

// ---------------------------------------------------------------------------
// Binary frame kinds
// ---------------------------------------------------------------------------

export const FrameKind = {
  /** bridge → client: H.264 Annex-B NAL unit(s) */
  Video: 0x01,
  /** bridge → client: AAC ADTS frame(s) */
  Audio: 0x02,
  /** client → bridge: talkback PCM s16le 16 kHz mono */
  TalkbackPcm: 0x10,
  /** client → bridge: talkback AAC ADTS frames */
  TalkbackAac: 0x11,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export type MediaFrame = { kind: number; serial: string; payload: Uint8Array };
