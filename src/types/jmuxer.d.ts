declare module "jmuxer" {
  export type JMuxerMode = "both" | "video" | "audio";

  export interface JMuxerOptions {
    /** Target `<video>` element or its id. */
    node: HTMLMediaElement | string;
    mode?: JMuxerMode;
    videoCodec?: "H264" | "H265";
    /** How often (ms) buffered samples are flushed into MSE. */
    flushingTime?: number;
    maxDelay?: number;
    clearBuffer?: boolean;
    fps?: number;
    readFpsFromTrack?: boolean;
    debug?: boolean;
    onReady?: (isReset: boolean, mediaSource: MediaSource) => void;
    onData?: (data: Uint8Array) => void;
    onError?: (data: unknown) => void;
    onUnsupportedCodec?: (codec: string) => void;
    onMissingVideoFrames?: () => void;
    onMissingAudioFrames?: () => void;
    onKeyframePosition?: (time: number) => void;
    onLoggerLog?: (...args: unknown[]) => void;
    onLoggerErr?: (...args: unknown[]) => void;
  }

  export interface JMuxerFeed {
    video?: Uint8Array;
    audio?: Uint8Array;
    /** Duration in ms of the chunk (optional). */
    duration?: number;
  }

  export default class JMuxer {
    static isSupported(codec: string): boolean;
    constructor(options: JMuxerOptions);
    feed(data: JMuxerFeed): void;
    reset(): void;
    destroy(): void;
  }
}
