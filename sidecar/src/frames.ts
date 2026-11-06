/**
 * Binary websocket frame layout (docs/PROTOCOL.md "Binary frames"):
 *
 *   +------+------+----------------+---------+
 *   | kind | n    | serial (n)     | payload |
 *   +------+------+----------------+---------+
 */

export type Frame = { kind: number; serial: string; payload: Buffer };

export function encodeFrame(kind: number, serial: string, payload: Uint8Array): Buffer {
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) {
    throw new RangeError(`frame kind out of range: ${kind}`);
  }
  const serialBytes = Buffer.from(serial, "ascii");
  if (serialBytes.length > 0xff) throw new RangeError("serial too long");
  if (serialBytes.toString("ascii") !== serial) throw new RangeError("serial must be ASCII");
  const out = Buffer.allocUnsafe(2 + serialBytes.length + payload.length);
  out[0] = kind;
  out[1] = serialBytes.length;
  serialBytes.copy(out, 2);
  out.set(payload, 2 + serialBytes.length);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame | null {
  if (buf.length < 2) return null;
  const kind = buf[0]!;
  const n = buf[1]!;
  if (buf.length < 2 + n) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const serial = b.subarray(2, 2 + n).toString("ascii");
  // subarray shares memory with the websocket's receive buffer; that's fine
  // because we always consume the payload synchronously or copy it.
  const payload = b.subarray(2 + n);
  return { kind, serial, payload };
}

/**
 * Pre-computes the header for a given (kind, serial) so a hot path (livestream
 * fan-out) only has to concatenate.
 */
export function frameEncoder(kind: number, serial: string): (payload: Uint8Array) => Buffer {
  const header = encodeFrame(kind, serial, new Uint8Array(0));
  return (payload) => {
    const out = Buffer.allocUnsafe(header.length + payload.length);
    header.copy(out, 0);
    out.set(payload, header.length);
    return out;
  };
}
