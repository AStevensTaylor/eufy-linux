/**
 * Pure PCM helpers shared by the talkback path (and mirrored, without
 * imports, inside public/worklets/pcm-worklet.js which cannot import modules).
 */

export const TALKBACK_SAMPLE_RATE = 16_000;

/** Convert float samples in [-1, 1] to signed 16-bit (clamped, rounded). */
export function floatToInt16(input: Float32Array, out?: Int16Array): Int16Array {
  const dst = out ?? new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    dst[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return dst;
}

/** Serialize int16 samples as little-endian bytes (as the bridge expects). */
export function int16ToLEBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return out;
}

/** Average multiple channels of planar float audio into one mono buffer. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/**
 * Streaming linear-interpolation resampler. Keeps the fractional read
 * position and the last input sample across calls so chunk boundaries are
 * continuous. Good enough for 16 kHz speech; a real anti-aliasing filter is
 * overkill for a doorbell speaker.
 */
export class LinearResampler {
  private readonly ratio: number;
  private pos = 0; // fractional position relative to `prev`
  private prev = 0;
  private primed = false;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    if (fromRate <= 0 || toRate <= 0) throw new Error("sample rates must be positive");
    this.ratio = fromRate / toRate;
  }

  get isIdentity(): boolean {
    return this.fromRate === this.toRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.isIdentity) return input;
    if (input.length === 0) return new Float32Array(0);
    // Virtual input: [prev, ...input]; `pos` is the next output index (in
    // input samples) measured from `prev` (index 0).
    if (!this.primed) {
      this.prev = input[0];
      this.primed = true;
      this.pos = 1; // start at the first real sample
    }
    const total = input.length + 1;
    const out: number[] = [];
    let pos = this.pos;
    while (pos < total - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      out.push(a + (b - a) * frac);
      pos += this.ratio;
    }
    // Slide the window so the last input sample becomes `prev`.
    this.prev = input[input.length - 1];
    this.pos = pos - (total - 1);
    return Float32Array.from(out);
  }

  reset(): void {
    this.pos = 0;
    this.prev = 0;
    this.primed = false;
  }
}

/** Collects int16 samples and emits fixed-size chunks. */
export class PcmBatcher {
  private buffer: Int16Array;
  private fill = 0;

  constructor(
    readonly samplesPerChunk: number,
    private readonly emit: (chunk: Int16Array) => void,
  ) {
    if (!Number.isInteger(samplesPerChunk) || samplesPerChunk <= 0) {
      throw new Error("samplesPerChunk must be a positive integer");
    }
    this.buffer = new Int16Array(samplesPerChunk);
  }

  push(samples: Int16Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, this.samplesPerChunk - this.fill);
      this.buffer.set(samples.subarray(offset, offset + take), this.fill);
      this.fill += take;
      offset += take;
      if (this.fill === this.samplesPerChunk) {
        this.emit(this.buffer);
        this.buffer = new Int16Array(this.samplesPerChunk);
        this.fill = 0;
      }
    }
  }

  /** Emit whatever is buffered (zero-padded to a chunk) and reset. */
  flush(): void {
    if (this.fill > 0) {
      this.emit(this.buffer.subarray(0, this.fill));
      this.buffer = new Int16Array(this.samplesPerChunk);
      this.fill = 0;
    }
  }
}

export function samplesForMs(ms: number, sampleRate: number): number {
  return Math.max(1, Math.round((ms / 1000) * sampleRate));
}
