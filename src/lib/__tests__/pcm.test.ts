import { describe, expect, it } from "vitest";
import {
  LinearResampler,
  PcmBatcher,
  floatToInt16,
  int16ToLEBytes,
  mixToMono,
  samplesForMs,
} from "../pcm";

describe("PCM helpers", () => {
  it("converts float to int16 with clamping", () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
  });

  it("serializes int16 little-endian", () => {
    const bytes = int16ToLEBytes(new Int16Array([1, -2, 0x1234]));
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0xfe, 0xff, 0x34, 0x12]);
  });

  it("mixes channels to mono", () => {
    const m = mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(Array.from(m)).toEqual([0.5, 0.5]);
    const single = new Float32Array([0.25]);
    expect(mixToMono([single])).toBe(single);
    expect(mixToMono([]).length).toBe(0);
  });

  it("computes chunk sizes", () => {
    expect(samplesForMs(20, 16000)).toBe(320);
    expect(samplesForMs(40, 16000)).toBe(640);
  });
});

describe("LinearResampler", () => {
  it("passes through at identity rate", () => {
    const r = new LinearResampler(16000, 16000);
    const input = new Float32Array([0.1, 0.2]);
    expect(r.process(input)).toBe(input);
  });

  it("decimates 48 kHz → 16 kHz to roughly a third of the samples", () => {
    const r = new LinearResampler(48000, 16000);
    const input = new Float32Array(4800).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
    const out = r.process(input);
    expect(Math.abs(out.length - 1600)).toBeLessThanOrEqual(2);
    // The output is still a 440 Hz sine at 16 kHz: check a few points.
    for (let i = 0; i < out.length; i += 97) {
      const expected = Math.sin((2 * Math.PI * 440 * i) / 16000);
      expect(Math.abs(out[i] - expected)).toBeLessThan(0.05);
    }
  });

  it("is continuous across chunk boundaries", () => {
    const whole = new LinearResampler(44100, 16000);
    const chunked = new LinearResampler(44100, 16000);
    const signal = new Float32Array(44100 / 10).map((_, i) => Math.sin((2 * Math.PI * 300 * i) / 44100));
    const a = whole.process(signal);
    const parts: number[] = [];
    for (let off = 0; off < signal.length; off += 128) {
      parts.push(...chunked.process(signal.subarray(off, Math.min(signal.length, off + 128))));
    }
    expect(Math.abs(parts.length - a.length)).toBeLessThanOrEqual(1);
    const n = Math.min(parts.length, a.length);
    for (let i = 0; i < n; i++) expect(Math.abs(parts[i] - a[i])).toBeLessThan(1e-5);
  });

  it("upsamples too", () => {
    const r = new LinearResampler(8000, 16000);
    const out = r.process(new Float32Array([0, 1, 0, -1]));
    expect(out.length).toBeGreaterThanOrEqual(6);
    expect(out[1]).toBeCloseTo(0.5, 5);
  });
});

describe("PcmBatcher", () => {
  it("emits fixed-size chunks and flushes the remainder", () => {
    const chunks: number[][] = [];
    const b = new PcmBatcher(4, (c) => chunks.push(Array.from(c)));
    b.push(new Int16Array([1, 2, 3]));
    expect(chunks).toEqual([]);
    b.push(new Int16Array([4, 5, 6, 7, 8, 9]));
    expect(chunks).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    b.flush();
    expect(chunks[2]).toEqual([9]);
    b.flush();
    expect(chunks.length).toBe(3);
  });

  it("rejects an invalid chunk size", () => {
    expect(() => new PcmBatcher(0, () => {})).toThrow();
  });
});
