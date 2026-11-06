import type { AudioCodecName, Device, DeviceKind, LivestreamMetadata, Station, VideoCodecName } from "./protocol.ts";
import type { DeviceLike, EufyStreamMetadata, StationLike } from "./eufy-types.ts";

// CommandName values from eufy-security-client/build/http/types.d.ts
export const CommandName = {
  DeviceStartLivestream: "deviceStartLivestream",
  DeviceStopLivestream: "deviceStopLivestream",
  DeviceQuickResponse: "deviceQuickResponse",
  DeviceStartTalkback: "deviceStartTalkback",
  DeviceStopTalkback: "deviceStopTalkback",
  DeviceSnooze: "deviceSnooze",
} as const;

export const PICTURE_PROPERTY = "picture";

const MAX_DEPTH = 6;

/** Converts an arbitrary value into something JSON.stringify handles without surprises. */
export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value as number) ? value : null;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "function" || t === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return undefined;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: value.length };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1) ?? null);
  if (value instanceof Map) return toJsonSafe(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return toJsonSafe([...value], depth + 1);
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = toJsonSafe(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

export function serializeProperties(props: Record<string, unknown>, exclude: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (exclude.includes(k)) continue;
    const s = toJsonSafe(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function safeCall<T>(fn: (() => T) | undefined, fallback: T): T {
  try {
    return fn ? fn() : fallback;
  } catch {
    return fallback;
  }
}

export function deviceKind(d: DeviceLike): DeviceKind {
  if (safeCall(() => d.isDoorbell(), false)) return "doorbell";
  if (safeCall(() => d.isCamera(), false)) return "camera";
  if (safeCall(() => d.isLock(), false)) return "lock";
  if (safeCall(() => d.isEntrySensor(), false) || safeCall(() => d.isMotionSensor(), false)) return "sensor";
  return "other";
}

export function serializeDevice(d: DeviceLike): Device {
  const isDoorbell = safeCall(() => d.isDoorbell(), false);
  const isCamera = safeCall(() => d.isCamera(), false);
  const has = (c: string) => safeCall(() => d.hasCommand(c), false);
  return {
    serial: d.getSerial(),
    stationSerial: safeCall(() => d.getStationSerial(), ""),
    name: safeCall(() => d.getName(), ""),
    model: safeCall(() => d.getModel(), ""),
    type: safeCall(() => d.getDeviceType(), -1),
    kind: deviceKind(d),
    channel: safeCall(() => d.getChannel(), 0),
    isDoorbell,
    isCamera,
    hasBattery: safeCall(() => d.hasBattery(), false),
    capabilities: {
      livestream: has(CommandName.DeviceStartLivestream),
      talkback: has(CommandName.DeviceStartTalkback),
      quickResponse: isDoorbell && has(CommandName.DeviceQuickResponse),
      snapshot: safeCall(() => d.hasProperty(PICTURE_PROPERTY), false) || isCamera,
    },
    properties: serializeProperties(safeCall(() => d.getProperties(), {}), [PICTURE_PROPERTY]),
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function serializeStation(s: StationLike): Station {
  const lanIp = safeCall(() => s.getLANIPAddress(), undefined);
  return {
    serial: s.getSerial(),
    name: safeCall(() => s.getName(), ""),
    model: safeCall(() => s.getModel(), ""),
    guardMode: numberOrNull(safeCall(() => s.getGuardMode(), null)),
    currentMode: numberOrNull(safeCall(() => s.getCurrentMode(), null)),
    connected: safeCall(() => s.isConnected(), false),
    lanIp: typeof lanIp === "string" && lanIp.length > 0 ? lanIp : null,
    properties: serializeProperties(safeCall(() => s.getProperties(), {})),
  };
}

// VideoCodec / AudioCodec enums from eufy-security-client/build/p2p/types.d.ts
export function videoCodecName(v: number): VideoCodecName {
  switch (v) {
    case 0:
      return "h264";
    case 1:
      return "h265";
    default:
      return "unknown";
  }
}

export function audioCodecName(v: number): AudioCodecName {
  switch (v) {
    case 0:
      return "none";
    case 1:
      return "aac";
    case 2:
      return "aac_lc";
    case 3:
      return "aac_eld";
    default:
      return "unknown";
  }
}

export function serializeMetadata(m: EufyStreamMetadata): LivestreamMetadata {
  return {
    videoCodec: videoCodecName(m.videoCodec),
    videoWidth: m.videoWidth,
    videoHeight: m.videoHeight,
    videoFPS: m.videoFPS,
    audioCodec: audioCodecName(m.audioCodec),
  };
}
