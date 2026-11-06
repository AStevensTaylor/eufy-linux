import { spawn, type ChildProcessByStdio } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Logger } from "./log.ts";

/**
 * ffmpeg arguments: 16 kHz mono s16le PCM in, AAC-LC in ADTS framing out,
 * the format eufy-security-client's TalkbackStream expects (same settings
 * as the Home Assistant / homebridge integrations use for talkback).
 */
export const FFMPEG_TALKBACK_ARGS = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-nostdin",
  "-fflags",
  "nobuffer",
  "-f",
  "s16le",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-i",
  "pipe:0",
  "-c:a",
  "aac",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-b:a",
  "32k",
  "-flush_packets",
  "1",
  "-f",
  "adts",
  "pipe:1",
];

let ffmpegPathCache: string | null | undefined;

/** Resolves the ffmpeg executable (EUFY_BRIDGE_FFMPEG, then PATH). Cached. */
export async function findFfmpeg(force = false): Promise<string | null> {
  if (!force && ffmpegPathCache !== undefined) return ffmpegPathCache;
  const candidates: string[] = [];
  if (process.env.EUFY_BRIDGE_FFMPEG) candidates.push(process.env.EUFY_BRIDGE_FFMPEG);
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  for (const c of candidates) {
    try {
      await fs.access(c, fsConstants.X_OK);
      ffmpegPathCache = c;
      return c;
    } catch {
      /* try next */
    }
  }
  ffmpegPathCache = null;
  return null;
}

export function resetFfmpegCache(): void {
  ffmpegPathCache = undefined;
}

type FfmpegProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Per-device talkback transcoder. PCM goes in (writePcm), AAC/ADTS comes out
 * via the sink. AAC frames from clients that encode themselves bypass ffmpeg
 * (writeAac). The sink may be attached late (eufy's talkback stream arrives
 * asynchronously); output produced before that is dropped.
 */
export class TalkbackTranscoder {
  private proc: FfmpegProcess | null = null;
  private sink: Writable | null = null;
  private closed = false;
  private droppedBeforeSink = 0;

  private readonly serial: string;
  private readonly ffmpegPath: string | null;
  private readonly log: Logger;
  private readonly onError: (err: Error) => void;

  constructor(serial: string, ffmpegPath: string | null, log: Logger, onError: (err: Error) => void) {
    this.serial = serial;
    this.ffmpegPath = ffmpegPath;
    this.log = log;
    this.onError = onError;
  }

  attachSink(sink: Writable): void {
    this.sink = sink;
    if (this.droppedBeforeSink > 0) {
      this.log.debug(`talkback ${this.serial}: dropped ${this.droppedBeforeSink} bytes before stream was ready`);
      this.droppedBeforeSink = 0;
    }
  }

  get hasSink(): boolean {
    return this.sink !== null;
  }

  get ffmpegAvailable(): boolean {
    return this.ffmpegPath !== null;
  }

  writePcm(chunk: Uint8Array): boolean {
    if (this.closed) return false;
    if (!this.ffmpegPath) return false;
    if (!this.proc) this.startFfmpeg();
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return false;
    try {
      stdin.write(Buffer.from(chunk));
      return true;
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  writeAac(chunk: Uint8Array): boolean {
    return this.writeToSink(chunk);
  }

  private writeToSink(chunk: Uint8Array): boolean {
    if (this.closed) return false;
    if (!this.sink || this.sink.destroyed) {
      this.droppedBeforeSink += chunk.length;
      return false;
    }
    try {
      this.sink.write(Buffer.from(chunk));
      return true;
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private startFfmpeg(): void {
    if (!this.ffmpegPath) return;
    this.log.debug(`talkback ${this.serial}: starting ffmpeg ${this.ffmpegPath}`);
    let proc: FfmpegProcess;
    try {
      proc = spawn(this.ffmpegPath, FFMPEG_TALKBACK_ARGS, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => this.writeToSink(chunk));
    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.stdin.on("error", (err) => {
      if (!this.closed) this.log.debug(`talkback ${this.serial}: ffmpeg stdin error ${err.message}`);
    });
    proc.on("error", (err) => {
      if (this.closed) return;
      this.log.error(`talkback ${this.serial}: ffmpeg failed to start`, err);
      this.onError(err);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      if (this.closed) return;
      const msg = `ffmpeg exited (code=${code} signal=${signal})${stderrTail ? `: ${stderrTail.trim()}` : ""}`;
      this.log.warn(`talkback ${this.serial}: ${msg}`);
      this.onError(new Error(msg));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      const killer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 1500);
      killer.unref();
      proc.once("exit", () => clearTimeout(killer));
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.sink = null;
  }
}
