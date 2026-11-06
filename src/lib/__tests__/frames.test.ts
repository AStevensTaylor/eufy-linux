import { describe, expect, it } from "vitest";
import { FrameError, decodeFrame, encodeFrame } from "../frames";
import { FrameKind } from "../types";

describe("binary frame codec", () => {
  it("encodes kind, serial length, serial and payload", () => {
    const buf = encodeFrame(FrameKind.TalkbackPcm, "T8210P0123456789", new Uint8Array([1, 2, 3]));
    expect(buf[0]).toBe(0x10);
    expect(buf[1]).toBe(16);
    expect(String.fromCharCode(...buf.subarray(2, 18))).toBe("T8210P0123456789");
    expect(Array.from(buf.subarray(18))).toEqual([1, 2, 3]);
    expect(buf.length).toBe(2 + 16 + 3);
  });

  it("round-trips through decode", () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e]);
    const frame = decodeFrame(encodeFrame(FrameKind.Video, "ABC", payload));
    expect(frame.kind).toBe(0x01);
    expect(frame.serial).toBe("ABC");
    expect(Array.from(frame.payload)).toEqual(Array.from(payload));
  });

  it("decodes from an ArrayBuffer and from an offset view", () => {
    const encoded = encodeFrame(FrameKind.Audio, "X1", new Uint8Array([9]));
    const ab = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    expect(decodeFrame(ab)).toMatchObject({ kind: 0x02, serial: "X1" });
    const padded = new Uint8Array(encoded.length + 4);
    padded.set(encoded, 4);
    const view = padded.subarray(4);
    expect(decodeFrame(view).serial).toBe("X1");
    expect(Array.from(decodeFrame(view).payload)).toEqual([9]);
  });

  it("supports an empty payload", () => {
    const frame = decodeFrame(encodeFrame(0x02, "S", new Uint8Array(0)));
    expect(frame.payload.length).toBe(0);
  });

  it("rejects malformed frames", () => {
    expect(() => decodeFrame(new Uint8Array([1]))).toThrow(FrameError);
    expect(() => decodeFrame(new Uint8Array([1, 0]))).toThrow(/empty serial/);
    expect(() => decodeFrame(new Uint8Array([1, 5, 65, 66]))).toThrow(/truncated/);
  });

  it("rejects invalid inputs when encoding", () => {
    expect(() => encodeFrame(300, "A", new Uint8Array(0))).toThrow(FrameError);
    expect(() => encodeFrame(1, "", new Uint8Array(0))).toThrow(FrameError);
    expect(() => encodeFrame(1, "é", new Uint8Array(0))).toThrow(/ASCII/);
    expect(() => encodeFrame(1, "a".repeat(256), new Uint8Array(0))).toThrow(FrameError);
  });
});
