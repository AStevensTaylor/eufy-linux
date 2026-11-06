/**
 * Wire types for docs/PROTOCOL.md. Keep in sync with that document.
 */

export const PROTOCOL_VERSION = 1 as const;

export type CommandMessage = {
  type: "command";
  id: string;
  command: string;
  params?: Record<string, unknown>;
};

export type ResultMessage =
  | { type: "result"; id: string; ok: true; result: unknown }
  | { type: "result"; id: string; ok: false; error: ErrorInfo };

export type EventMessage = { type: "event"; event: string; data: unknown };

export type ErrorInfo = { code: string; message: string };

export type AuthState =
  | "logged_out"
  | "connecting"
  | "tfa_required"
  | "captcha_required"
  | "connected"
  | "error";

export type AuthStatus = {
  state: AuthState;
  username: string | null;
  pushConnected: boolean;
  error?: ErrorInfo;
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

export type VideoCodecName = "h264" | "h265" | "unknown";
export type AudioCodecName = "aac" | "aac_lc" | "aac_eld" | "none" | "unknown";

export type LivestreamMetadata = {
  videoCodec: VideoCodecName;
  videoWidth: number;
  videoHeight: number;
  videoFPS: number;
  audioCodec: AudioCodecName;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Binary frame kinds (first byte of every binary websocket frame). */
export const FrameKind = {
  Video: 0x01,
  Audio: 0x02,
  TalkbackPcm: 0x10,
  TalkbackAac: 0x11,
} as const;
export type FrameKindValue = (typeof FrameKind)[keyof typeof FrameKind];

/** Error codes used in results and *.error events. */
export const ErrorCode = {
  Unauthorized: "unauthorized",
  NotLoggedIn: "not_logged_in",
  DeviceNotFound: "device_not_found",
  StationNotFound: "station_not_found",
  Unsupported: "unsupported",
  InvalidParams: "invalid_params",
  UnknownCommand: "unknown_command",
  EufyError: "eufy_error",
  FfmpegMissing: "ffmpeg_missing",
  TalkbackBusy: "talkback_busy",
  NotStreaming: "not_streaming",
  Internal: "internal",
} as const;

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export function errorInfo(err: unknown, fallbackCode = ErrorCode.EufyError): ErrorInfo {
  if (err instanceof BridgeError) return { code: err.code, message: err.message };
  if (err instanceof Error) {
    const name = err.name || "";
    let code: string = fallbackCode;
    if (/DeviceNotFound/i.test(name)) code = ErrorCode.DeviceNotFound;
    else if (/StationNotFound/i.test(name)) code = ErrorCode.StationNotFound;
    else if (/NotSupported/i.test(name)) code = ErrorCode.Unsupported;
    else if (/InvalidPropertyValue|InvalidCommandValue|ReadOnlyProperty/i.test(name))
      code = ErrorCode.InvalidParams;
    return { code, message: err.message || name || "Unknown error" };
  }
  return { code: fallbackCode, message: String(err) };
}
