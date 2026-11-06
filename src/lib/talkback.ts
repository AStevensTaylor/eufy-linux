/**
 * Two-way talk: microphone → AudioWorklet (float32 → int16 @16 kHz mono) →
 * binary 0x10 frames on the bridge socket.
 */
import type { BridgeClient } from "./bridge";
import { createObservable, type Observable } from "./observable";
import {
  LinearResampler,
  PcmBatcher,
  TALKBACK_SAMPLE_RATE,
  floatToInt16,
  int16ToLEBytes,
  mixToMono,
  samplesForMs,
} from "./pcm";
import { FrameKind } from "./types";

export type TalkbackState = "idle" | "starting" | "active" | "stopping" | "error";

export type TalkbackInfo = {
  state: TalkbackState;
  error: string | null;
  /** AudioContext sample rate actually in use. */
  contextRate: number | null;
  /** "worklet" | "script-processor" | null */
  capture: "worklet" | "script-processor" | null;
  bytesSent: number;
};

const CHUNK_MS = 20;
const WORKLET_URL = `${import.meta.env.BASE_URL}worklets/pcm-worklet.js`;

export function talkbackSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof (globalThis as { AudioContext?: unknown }).AudioContext === "function"
  );
}

export class TalkbackSession {
  readonly info: Observable<TalkbackInfo> = createObservable<TalkbackInfo>({
    state: "idle",
    error: null,
    contextRate: null,
    capture: null,
    bytesSent: 0,
  });

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private bytesSent = 0;

  constructor(
    private readonly bridge: BridgeClient,
    readonly serial: string,
  ) {}

  get state(): TalkbackState {
    return this.info.get().state;
  }

  private patch(p: Partial<TalkbackInfo>): void {
    this.info.set({ ...this.info.get(), ...p });
  }

  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "active") return;
    if (!talkbackSupported()) {
      this.patch({ state: "error", error: "Microphone capture is not supported in this webview." });
      return;
    }
    this.patch({ state: "starting", error: null, bytesSent: 0 });
    this.bytesSent = 0;
    this.listenToBridge();
    try {
      await this.bridge.call("talkback.start", { serial: this.serial });
      this.started = true;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      await this.setupAudioGraph(this.stream);
      // `talkback.started` from the bridge flips us to active; if the bridge
      // already emitted it (race), move on now.
      if (this.info.get().state === "starting") this.patch({ state: "active" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.cleanup();
      if (this.started) {
        this.started = false;
        void this.bridge.call("talkback.stop", { serial: this.serial }).catch(() => {});
      }
      this.patch({ state: "error", error: message });
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    this.patch({ state: "stopping" });
    await this.cleanup();
    if (this.started) {
      this.started = false;
      try {
        await this.bridge.call("talkback.stop", { serial: this.serial });
      } catch {
        /* bridge may already have stopped it */
      }
    }
    this.unlistenBridge();
    this.patch({ state: "idle", capture: null, contextRate: null });
  }

  /** Release everything without talking to the bridge (unmount). */
  async dispose(): Promise<void> {
    await this.stop();
  }

  private listenToBridge(): void {
    this.unlistenBridge();
    this.unsubscribers.push(
      this.bridge.on("talkback.started", (d) => {
        if (d.serial === this.serial && this.state === "starting") this.patch({ state: "active" });
      }),
      this.bridge.on("talkback.stopped", (d) => {
        if (d.serial !== this.serial) return;
        if (this.state === "active" || this.state === "starting") {
          this.started = false;
          void this.cleanup().then(() => this.patch({ state: "idle", capture: null }));
        }
      }),
      this.bridge.on("talkback.error", (d) => {
        if (d.serial !== this.serial) return;
        this.started = false;
        void this.cleanup().then(() => this.patch({ state: "error", error: d.message }));
      }),
      this.bridge.status.subscribe((s) => {
        if (s !== "connected" && this.state !== "idle") {
          this.started = false;
          void this.cleanup().then(() =>
            this.patch({ state: "error", error: "Bridge disconnected during talkback." }),
          );
        }
      }),
    );
  }

  private unlistenBridge(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private send(samples: Int16Array): void {
    const bytes = int16ToLEBytes(samples);
    if (this.bridge.sendBinary(FrameKind.TalkbackPcm, this.serial, bytes)) {
      this.bytesSent += bytes.length;
      this.patch({ bytesSent: this.bytesSent });
    }
  }

  private async setupAudioGraph(stream: MediaStream): Promise<void> {
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: TALKBACK_SAMPLE_RATE });
    } catch {
      context = new AudioContext();
    }
    this.context = context;
    if (context.state === "suspended") await context.resume();
    this.patch({ contextRate: context.sampleRate });
    const source = context.createMediaStreamSource(stream);

    if (typeof context.audioWorklet !== "undefined" && typeof AudioWorkletNode === "function") {
      try {
        await context.audioWorklet.addModule(WORKLET_URL);
        const node = new AudioWorkletNode(context, "pcm-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          processorOptions: { targetRate: TALKBACK_SAMPLE_RATE, chunkMs: CHUNK_MS },
        });
        node.port.onmessage = (ev: MessageEvent<{ type: string; samples: Int16Array }>) => {
          if (ev.data?.type === "chunk" && ev.data.samples) this.send(ev.data.samples);
        };
        source.connect(node);
        this.node = node;
        this.patch({ capture: "worklet" });
        return;
      } catch (err) {
        console.warn("AudioWorklet unavailable, falling back to ScriptProcessorNode", err);
      }
    }

    // Fallback: deprecated ScriptProcessorNode with manual decimation.
    const resampler = new LinearResampler(context.sampleRate, TALKBACK_SAMPLE_RATE);
    const batcher = new PcmBatcher(samplesForMs(CHUNK_MS, TALKBACK_SAMPLE_RATE), (c) =>
      this.send(c),
    );
    const node = context.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (ev) => {
      const chans: Float32Array[] = [];
      for (let c = 0; c < ev.inputBuffer.numberOfChannels; c++) {
        chans.push(ev.inputBuffer.getChannelData(c));
      }
      batcher.push(floatToInt16(resampler.process(mixToMono(chans))));
    };
    source.connect(node);
    // ScriptProcessor needs a destination to run; a muted gain keeps it silent.
    const gain = context.createGain();
    gain.gain.value = 0;
    node.connect(gain);
    gain.connect(context.destination);
    this.node = node;
    this.patch({ capture: "script-processor" });
  }

  private async cleanup(): Promise<void> {
    if (this.node) {
      try {
        if ("port" in this.node) this.node.port.postMessage({ type: "stop" });
        this.node.disconnect();
      } catch {
        /* ignore */
      }
      this.node = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.context) {
      const ctx = this.context;
      this.context = null;
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }
}
