/**
 * Binary websocket frame codec, per docs/PROTOCOL.md:
 *
 *   +------+------+----------------+-------------------+
 *   | kind | n    | serial (n)     | payload           |
 *   +------+------+----------------+-------------------+
 *
 * `kind` and `n` are single bytes; the serial is ASCII.
 */
import type { MediaFrame } from "./types";

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

function asciiBytes(serial: string): Uint8Array {
  const out = new Uint8Array(serial.length);
  for (let i = 0; i < serial.length; i++) {
    const c = serial.charCodeAt(i);
    if (c > 0x7f) throw new FrameError(`serial is not ASCII: ${serial}`);
    out[i] = c;
  }
  return out;
}

/** Encode a frame to a single contiguous buffer, ready for `WebSocket.send`. */
export function encodeFrame(kind: number, serial: string, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) {
    throw new FrameError(`invalid frame kind ${kind}`);
  }
  const serialBytes = asciiBytes(serial);
  if (serialBytes.length === 0 || serialBytes.length > 0xff) {
    throw new FrameError(`serial length out of range: ${serialBytes.length}`);
  }
  const out = new Uint8Array(2 + serialBytes.length + payload.length);
  out[0] = kind;
  out[1] = serialBytes.length;
  out.set(serialBytes, 2);
  out.set(payload, 2 + serialBytes.length);
  return out;
}

/**
 * Decode a frame. The returned payload is a view into `buf` (no copy), so
 * callers that keep it around beyond the current tick should copy it.
 */
export function decodeFrame(buf: ArrayBufferLike | Uint8Array): MediaFrame {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 2) throw new FrameError("frame too short");
  const kind = bytes[0];
  const n = bytes[1];
  if (n === 0) throw new FrameError("empty serial");
  if (bytes.length < 2 + n) throw new FrameError("truncated serial");
  let serial = "";
  for (let i = 0; i < n; i++) serial += String.fromCharCode(bytes[2 + i]);
  const payload = bytes.subarray(2 + n);
  return { kind, serial, payload };
}
