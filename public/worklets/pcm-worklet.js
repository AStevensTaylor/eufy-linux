/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * Talkback PCM worklet: float32 (AudioContext rate) → int16 mono at
 * `targetRate` (16 kHz), batched into `chunkMs` chunks and posted to the main
 * thread as transferable Int16Array buffers.
 *
 * This file cannot import modules, so the resampler mirrors src/lib/pcm.ts.
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    this.chunkSamples = Math.max(1, Math.round(((o.chunkMs || 20) / 1000) * this.targetRate));
    this.ratio = sampleRate / this.targetRate;
    this.pos = 0;
    this.prev = 0;
    this.primed = false;
    this.buffer = new Int16Array(this.chunkSamples);
    this.fill = 0;
    this.running = true;
    this.port.onmessage = (ev) => {
      if (ev.data && ev.data.type === "stop") {
        this.flush();
        this.running = false;
      }
    };
  }

  resample(input) {
    if (this.ratio === 1) return input;
    if (!this.primed) {
      this.prev = input[0];
      this.primed = true;
      this.pos = 1;
    }
    const total = input.length + 1;
    const out = [];
    let pos = this.pos;
    while (pos < total - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      out.push(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.prev = input[input.length - 1];
    this.pos = pos - (total - 1);
    return Float32Array.from(out);
  }

  pushSample(s) {
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    this.buffer[this.fill++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    if (this.fill === this.chunkSamples) {
      this.port.postMessage({ type: "chunk", samples: this.buffer }, [this.buffer.buffer]);
      this.buffer = new Int16Array(this.chunkSamples);
      this.fill = 0;
    }
  }

  flush() {
    if (this.fill > 0) {
      const chunk = this.buffer.slice(0, this.fill);
      this.port.postMessage({ type: "chunk", samples: chunk }, [chunk.buffer]);
      this.buffer = new Int16Array(this.chunkSamples);
      this.fill = 0;
    }
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;
    let mono = input[0];
    if (input.length > 1) {
      mono = new Float32Array(input[0].length);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < mono.length; i++) mono[i] += ch[i];
      }
      const k = 1 / input.length;
      for (let i = 0; i < mono.length; i++) mono[i] *= k;
    }
    const res = this.resample(mono);
    for (let i = 0; i < res.length; i++) this.pushSample(res[i]);
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
