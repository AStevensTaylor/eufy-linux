import type { LogLevel } from "./protocol.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (level: LogLevel, message: string) => void;

export class Logger {
  level: LogLevel;
  private readonly sinks: LogSink[] = [];
  private readonly scope: string;

  constructor(level: LogLevel = "info", scope = "bridge") {
    this.level = level;
    this.scope = scope;
  }

  child(scope: string): Logger {
    const l = new Logger(this.level, `${this.scope}:${scope}`);
    l.sinks.push((level, message) => this.forward(level, message));
    return l;
  }

  /** Sinks receive warn/error entries (used to broadcast `bridge.log`). */
  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  enabled(level: LogLevel): boolean {
    return ORDER[level] >= ORDER[this.level];
  }

  debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.log("info", message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.log("error", message, args);
  }

  log(level: LogLevel, message: string, args: unknown[] = []): void {
    if (!this.enabled(level)) return;
    const text = args.length ? `${message} ${args.map(formatArg).join(" ")}` : message;
    const line = `${new Date().toISOString()} [${level}] ${this.scope}: ${text}`;
    try {
      process.stderr.write(line + "\n");
    } catch {
      /* stderr gone; nothing sensible to do */
    }
    for (const sink of this.sinks) {
      try {
        sink(level, `${this.scope}: ${text}`);
      } catch {
        /* never let a sink break logging */
      }
    }
  }

  private forward(level: LogLevel, message: string): void {
    for (const sink of this.sinks) {
      try {
        sink(level, message);
      } catch {
        /* ignore */
      }
    }
  }
}

export function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a, (_k, v: unknown) => {
      if (Buffer.isBuffer(v)) return `<Buffer ${v.length}>`;
      if (typeof v === "bigint") return v.toString();
      return v;
    });
  } catch {
    return String(a);
  }
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  switch ((value ?? "").toLowerCase()) {
    case "debug":
    case "trace":
      return "debug";
    case "info":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
      return "error";
    default:
      return fallback;
  }
}
