import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame, frameEncoder } from "../src/frames.ts";
import { FrameKind } from "../src/protocol.ts";

test("encodeFrame lays out kind, serial length, serial, payload", () => {
  const buf = encodeFrame(FrameKind.Video, "T8210N0123456789", Buffer.from([0, 0, 0, 1, 0x67]));
  assert.equal(buf[0], 0x01);
  assert.equal(buf[1], 16);
  assert.equal(buf.subarray(2, 18).toString("ascii"), "T8210N0123456789");
  assert.deepEqual([...buf.subarray(18)], [0, 0, 0, 1, 0x67]);
  assert.equal(buf.length, 2 + 16 + 5);
});

test("decodeFrame round-trips every kind", () => {
  for (const kind of Object.values(FrameKind)) {
    const payload = Buffer.from("payload-" + kind);
    const frame = decodeFrame(encodeFrame(kind, "SN1", payload));
    assert.ok(frame);
    assert.equal(frame.kind, kind);
    assert.equal(frame.serial, "SN1");
    assert.equal(frame.payload.toString(), payload.toString());
  }
});

test("decodeFrame handles empty payload and empty serial", () => {
  const f = decodeFrame(encodeFrame(0x10, "", new Uint8Array(0)));
  assert.ok(f);
  assert.equal(f.serial, "");
  assert.equal(f.payload.length, 0);
});

test("decodeFrame rejects truncated frames", () => {
  assert.equal(decodeFrame(new Uint8Array([])), null);
  assert.equal(decodeFrame(new Uint8Array([0x01])), null);
  assert.equal(decodeFrame(new Uint8Array([0x01, 5, 65, 66])), null);
});

test("decodeFrame accepts a plain Uint8Array view", () => {
  const encoded = encodeFrame(0x02, "AB", Buffer.from([9, 8, 7]));
  const view = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const f = decodeFrame(view);
  assert.ok(f);
  assert.equal(f.serial, "AB");
  assert.deepEqual([...f.payload], [9, 8, 7]);
});

test("encodeFrame validates inputs", () => {
  assert.throws(() => encodeFrame(256, "X", new Uint8Array(0)), RangeError);
  assert.throws(() => encodeFrame(1, "x".repeat(256), new Uint8Array(0)), RangeError);
  assert.throws(() => encodeFrame(1, "Ω", new Uint8Array(0)), RangeError);
});

test("frameEncoder matches encodeFrame", () => {
  const enc = frameEncoder(FrameKind.Audio, "SERIAL");
  const payload = Buffer.from([0xff, 0xf1, 0x50]);
  assert.deepEqual([...enc(payload)], [...encodeFrame(FrameKind.Audio, "SERIAL", payload)]);
});
