/**
 * Live video player: bridge media frames (H.264 Annex-B + AAC ADTS) → JMuxer →
 * fragmented MP4 → <video> via Media Source Extensions.
 */
import JMuxer, { type JMuxerMode } from "jmuxer";
import type { BridgeClient } from "./bridge";
import { createObservable, type Observable } from "./observable";
import { FrameKind, type LivestreamMetadata, type MediaFrame } from "./types";

export type PlayerState = "idle" | "starting" | "playing" | "stopped" | "error";

export type PlayerInfo = {
  state: PlayerState;
  error: string | null;
  warning: string | null;
  metadata: LivestreamMetadata | null;
  mode: JMuxerMode | null;
  videoBytes: number;
  audioBytes: number;
  videoChunks: number;
  audioChunks: number;
};

const H264_MSE_TYPE = 'video/mp4; codecs="avc1.42E01E"';
const AUDIO_GRACE_MS = 3_000;
/** How long to wait for `livestream.started` after `livestream.start` succeeds. */
const STARTED_TIMEOUT_MS = 30_000;

export function mseSupported(): boolean {
  const w = globalThis as { MediaSource?: { isTypeSupported?: (t: string) => boolean } };
  if (!w.MediaSource) return false;
  try {
    return typeof w.MediaSource.isTypeSupported === "function"
      ? w.MediaSource.isTypeSupported(H264_MSE_TYPE)
      : true;
  } catch {
    return false;
  }
}

/** Decide the JMuxer mode for a stream. `aac_eld` is not decodable via MSE. */
export function chooseMode(meta: LivestreamMetadata): { mode: JMuxerMode; warning: string | null } {
  switch (meta.audioCodec) {
    case "aac":
    case "aac_lc":
      return { mode: "both", warning: null };
    case "none":
      return { mode: "video", warning: null };
    case "aac_eld":
      return { mode: "video", warning: "Audio uses AAC-ELD, which the webview cannot decode; playing video only." };
    default:
      return { mode: "video", warning: "Unknown audio codec; playing video only." };
  }
}

const initialInfo = (): PlayerInfo => ({
  state: "idle",
  error: null,
  warning: null,
  metadata: null,
  mode: null,
  videoBytes: 0,
  audioBytes: 0,
  videoChunks: 0,
  audioChunks: 0,
});

export class LivePlayer {
  readonly info: Observable<PlayerInfo> = createObservable<PlayerInfo>(initialInfo());

  private muxer: JMuxer | null = null;
  private video: HTMLVideoElement | null = null;
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private audioGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private startedTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private counters = { videoBytes: 0, audioBytes: 0, videoChunks: 0, audioChunks: 0 };

  constructor(
    private readonly bridge: BridgeClient,
    readonly serial: string,
  ) {}

  private patch(p: Partial<PlayerInfo>): void {
    this.info.set({ ...this.info.get(), ...p });
  }

  get state(): PlayerState {
    return this.info.get().state;
  }

  attach(video: HTMLVideoElement): void {
    this.video = video;
  }

  async start(): Promise<void> {
    if (!this.video) throw new Error("attach() a <video> element first");
    if (this.state === "starting" || this.state === "playing") return;
    this.counters = { videoBytes: 0, audioBytes: 0, videoChunks: 0, audioChunks: 0 };
    this.info.set({ ...initialInfo(), state: "starting" });
    if (!mseSupported()) {
      this.patch({
        state: "error",
        error: "Media Source Extensions with H.264 are not available in this webview (install the GStreamer good/bad/libav plugins).",
      });
      return;
    }
    const gen = ++this.generation;
    this.listen();
    try {
      await this.bridge.call("livestream.start", { serial: this.serial }, { timeoutMs: 30_000 });
      if (gen !== this.generation) return; // stop()/start() raced us
      this.started = true;
      if (this.info.get().state === "starting") {
        this.startedTimer = setTimeout(() => {
          this.startedTimer = null;
          if (gen === this.generation && this.info.get().state === "starting") {
            this.patch({ state: "error", error: "The bridge accepted the request but no stream started." });
          }
        }, STARTED_TIMEOUT_MS);
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.unlisten();
      this.patch({ state: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.unlisten();
    this.destroyMuxer();
    if (this.started) {
      this.started = false;
      try {
        await this.bridge.call("livestream.stop", { serial: this.serial });
      } catch {
        /* bridge may be gone */
      }
    }
    if (this.state !== "error") this.patch({ state: "stopped" });
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.video = null;
  }

  /** Grab the current frame as a PNG blob (null when nothing is decoded yet). */
  async snapshot(): Promise<Blob | null> {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  }

  // ---- internals -----------------------------------------------------------

  private listen(): void {
    this.unlisten();
    this.unsubscribers.push(
      this.bridge.on("livestream.started", (d) => {
        if (d.serial === this.serial) this.onStarted(d.metadata);
      }),
      this.bridge.on("livestream.stopped", (d) => {
        if (d.serial !== this.serial) return;
        this.started = false;
        this.destroyMuxer();
        if (this.state !== "error") this.patch({ state: "stopped" });
      }),
      this.bridge.on("livestream.error", (d) => {
        if (d.serial !== this.serial) return;
        this.started = false;
        this.destroyMuxer();
        this.patch({ state: "error", error: `${d.message} (${d.code})` });
      }),
      this.bridge.onMedia(this.serial, (f) => this.onFrame(f)),
      this.bridge.status.subscribe((s) => {
        if (s !== "connected" && (this.state === "playing" || this.state === "starting")) {
          this.started = false;
          this.destroyMuxer();
          this.patch({ state: "error", error: "Bridge disconnected." });
        }
      }),
    );
  }

  private unlisten(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private onStarted(metadata: LivestreamMetadata): void {
    if (this.startedTimer) {
      clearTimeout(this.startedTimer);
      this.startedTimer = null;
    }
    if (metadata.videoCodec !== "h264") {
      this.patch({
        state: "error",
        metadata,
        error: `Video codec ${metadata.videoCodec.toUpperCase()} cannot be decoded in the webview; only H.264 is supported.`,
      });
      return;
    }
    const { mode, warning } = chooseMode(metadata);
    this.patch({ metadata, mode, warning, state: "playing" });
    this.createMuxer(mode, metadata.videoFPS);
    if (mode === "both") {
      // If audio never shows up, JMuxer would wait forever; fall back to video.
      this.audioGraceTimer = setTimeout(() => {
        this.audioGraceTimer = null;
        if (this.counters.audioChunks === 0 && this.muxer) {
          this.destroyMuxer();
          this.createMuxer("video", metadata.videoFPS);
          this.patch({ mode: "video", warning: "No audio received; playing video only." });
        }
      }, AUDIO_GRACE_MS);
    }
    this.statsTimer = setInterval(() => this.patch({ ...this.counters }), 1_000);
  }

  private createMuxer(mode: JMuxerMode, fps: number): void {
    if (!this.video) return;
    this.muxer = new JMuxer({
      node: this.video,
      mode,
      videoCodec: "H264",
      flushingTime: 100,
      maxDelay: 300,
      clearBuffer: true,
      fps: fps > 0 ? fps : 15,
      readFpsFromTrack: false,
      debug: false,
      onError: (data) => {
        console.warn("jmuxer buffer error", data);
      },
      onUnsupportedCodec: (codec) => {
        this.patch({ state: "error", error: `Browser cannot decode ${codec}.` });
      },
      onReady: () => {
        void this.video?.play().catch(() => {
          /* autoplay may need a gesture; the <video> has controls */
        });
      },
    });
    this.patch({ mode });
  }

  private destroyMuxer(): void {
    if (this.startedTimer) {
      clearTimeout(this.startedTimer);
      this.startedTimer = null;
    }
    if (this.audioGraceTimer) {
      clearTimeout(this.audioGraceTimer);
      this.audioGraceTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.muxer) {
      try {
        this.muxer.destroy();
      } catch {
        /* ignore */
      }
      this.muxer = null;
    }
    if (this.video) {
      try {
        this.video.pause();
        this.video.removeAttribute("src");
        this.video.load();
      } catch {
        /* ignore */
      }
    }
  }

  private onFrame(frame: MediaFrame): void {
    if (!this.muxer) return;
    // Copy: the payload is a view into the websocket buffer and JMuxer keeps it.
    const payload = frame.payload.slice();
    if (frame.kind === FrameKind.Video) {
      this.counters.videoBytes += payload.length;
      this.counters.videoChunks += 1;
      this.muxer.feed({ video: payload });
    } else if (frame.kind === FrameKind.Audio) {
      this.counters.audioBytes += payload.length;
      this.counters.audioChunks += 1;
      if (this.info.get().mode === "both") this.muxer.feed({ audio: payload });
    }
  }
}
