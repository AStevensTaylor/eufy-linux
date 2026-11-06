/**
 * Typed client for the bridge sidecar websocket (docs/PROTOCOL.md).
 *
 *  - JSON commands with promise-based results, id matching and timeouts
 *  - typed events via `on(event, handler)`
 *  - binary media frames dispatched to per-serial subscribers
 *  - auto-reconnect with exponential backoff
 *  - `status` observable: disconnected | connecting | connected
 */
import { decodeFrame, encodeFrame } from "./frames";
import { createObservable, type Observable } from "./observable";
import type {
  BridgeError,
  CommandName,
  CommandParams,
  CommandResult,
  EventData,
  EventName,
  MediaFrame,
  WireMessage,
} from "./types";

export type BridgeStatus = "disconnected" | "connecting" | "connected";

export class BridgeCallError extends Error {
  readonly code: string;
  readonly command: string;
  constructor(command: string, error: BridgeError) {
    super(error.message);
    this.name = "BridgeCallError";
    this.code = error.code;
    this.command = command;
  }
}

/** The subset of the WebSocket API the client needs (lets tests inject a fake). */
export interface BridgeSocket {
  binaryType: BinaryType;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type BridgeSocketFactory = (url: string) => BridgeSocket;

export type BridgeEndpoint = { url: string; token: string };

export type BridgeClientOptions = {
  /** Default: `url => new WebSocket(url)`. */
  socketFactory?: BridgeSocketFactory;
  /** Per-call timeout; default 15 s. */
  requestTimeoutMs?: number;
  /** Timeout for the initial auth.hello handshake; default 5 s. */
  helloTimeoutMs?: number;
  /** Reconnect automatically after an unexpected close; default true. */
  autoReconnect?: boolean;
  /** Backoff bounds in ms; defaults 500 → 10 000. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Generates command ids; default: counter + random suffix. */
  idGenerator?: () => string;
  /** Log sink for diagnostics; default: console.debug in dev, silent otherwise. */
  log?: (message: string) => void;
};

type Pending = {
  command: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (data: unknown) => void;
type MediaHandler = (frame: MediaFrame) => void;
type AnyEventHandler = (event: string, data: unknown) => void;

const WS_OPEN = 1;

export class BridgeClient {
  readonly status: Observable<BridgeStatus> = createObservable<BridgeStatus>("disconnected");
  /** Human-readable reason for the last disconnect/failure, if any. */
  readonly lastError: Observable<string | null> = createObservable<string | null>(null);
  /** Bridge version reported by auth.hello, once connected. */
  readonly bridgeVersion: Observable<string | null> = createObservable<string | null>(null);

  private endpoint: BridgeEndpoint | null = null;
  private socket: BridgeSocket | null = null;
  private pending = new Map<string, Pending>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private anyHandlers = new Set<AnyEventHandler>();
  private mediaHandlers = new Map<string, Set<MediaHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closedByUser = true;
  private seq = 0;
  private readonly opts: Required<BridgeClientOptions>;

  constructor(options: BridgeClientOptions = {}) {
    this.opts = {
      socketFactory: options.socketFactory ?? ((url) => new WebSocket(url) as unknown as BridgeSocket),
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      helloTimeoutMs: options.helloTimeoutMs ?? 5_000,
      autoReconnect: options.autoReconnect ?? true,
      backoffMinMs: options.backoffMinMs ?? 500,
      backoffMaxMs: options.backoffMaxMs ?? 10_000,
      idGenerator:
        options.idGenerator ??
        (() => `${++this.seq}-${Math.random().toString(36).slice(2, 8)}`),
      log: options.log ?? (() => {}),
    };
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Current endpoint, if `connect` has been called. */
  getEndpoint(): BridgeEndpoint | null {
    return this.endpoint;
  }

  /**
   * Connect to a bridge. Calling it again with a different endpoint drops the
   * current connection and reconnects; with the same endpoint while connected
   * it is a no-op.
   */
  connect(endpoint: BridgeEndpoint): void {
    const same =
      this.endpoint !== null &&
      this.endpoint.url === endpoint.url &&
      this.endpoint.token === endpoint.token;
    if (same && (this.socket || this.reconnectTimer)) return;
    this.endpoint = endpoint;
    this.closedByUser = false;
    this.attempt = 0;
    this.teardownSocket("reconnecting to new endpoint");
    this.open();
  }

  /** Close and stop reconnecting. */
  disconnect(): void {
    this.closedByUser = true;
    this.clearReconnect();
    this.teardownSocket("disconnected");
    this.status.set("disconnected");
  }

  /** Force an immediate reconnect attempt (resets backoff). */
  reconnectNow(): void {
    if (!this.endpoint) return;
    this.closedByUser = false;
    this.attempt = 0;
    this.clearReconnect();
    this.teardownSocket("manual reconnect");
    this.open();
  }

  get connected(): boolean {
    return this.status.get() === "connected";
  }

  // ---- commands ------------------------------------------------------------

  call<C extends CommandName>(
    command: C,
    ...rest: CommandParams<C> extends undefined
      ? [params?: CommandParams<C>, options?: { timeoutMs?: number }]
      : [params: CommandParams<C>, options?: { timeoutMs?: number }]
  ): Promise<CommandResult<C>> {
    const [params, options] = rest;
    return this.rawCall(command, params, options?.timeoutMs) as Promise<CommandResult<C>>;
  }

  /** Untyped escape hatch (also used for auth.hello before `connected`). */
  rawCall(command: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) {
      return Promise.reject(
        new BridgeCallError(command, { code: "not_connected", message: "Bridge is not connected" }),
      );
    }
    if (command !== "auth.hello" && this.status.get() !== "connected") {
      return Promise.reject(
        new BridgeCallError(command, {
          code: "not_connected",
          message: "Bridge handshake not complete",
        }),
      );
    }
    const id = this.opts.idGenerator();
    const payload = JSON.stringify({ type: "command", id, command, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeCallError(command, {
            code: "timeout",
            message: `${command} timed out after ${timeoutMs ?? this.opts.requestTimeoutMs} ms`,
          }),
        );
      }, timeoutMs ?? this.opts.requestTimeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      try {
        socket.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new BridgeCallError(command, {
            code: "send_failed",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });
  }

  // ---- events --------------------------------------------------------------

  on<E extends EventName>(event: E, handler: (data: EventData<E>) => void): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    const h = handler as EventHandler;
    set.add(h);
    return () => {
      set?.delete(h);
    };
  }

  /** Receive every event (useful for logging / a generic reducer). */
  onAny(handler: AnyEventHandler): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to binary media frames for a serial (`"*"` for all). Payloads
   * are views into the websocket message buffer; copy if retained.
   */
  onMedia(serial: string, handler: MediaHandler): () => void {
    let set = this.mediaHandlers.get(serial);
    if (!set) {
      set = new Set();
      this.mediaHandlers.set(serial, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  // ---- binary --------------------------------------------------------------

  /** Send a binary frame; returns false (and drops it) when not connected. */
  sendBinary(kind: number, serial: string, payload: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN || this.status.get() !== "connected") {
      return false;
    }
    try {
      socket.send(encodeFrame(kind, serial, payload));
      return true;
    } catch (err) {
      this.opts.log(`sendBinary failed: ${String(err)}`);
      return false;
    }
  }

  // ---- internals -----------------------------------------------------------

  private open(): void {
    if (!this.endpoint) return;
    this.status.set("connecting");
    let socket: BridgeSocket;
    try {
      socket = this.opts.socketFactory(this.endpoint.url);
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.hello(socket);
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      // The close event follows; nothing to do here beyond noting it.
      this.opts.log("websocket error");
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      const reason =
        typeof ev === "object" && ev && "reason" in ev && typeof ev.reason === "string" && ev.reason
          ? ev.reason
          : "connection closed";
      this.socket = null;
      this.failPending({ code: "disconnected", message: reason });
      this.status.set("disconnected");
      this.bridgeVersion.set(null);
      if (!this.closedByUser) {
        this.lastError.set(reason);
        this.scheduleReconnect();
      }
    };
  }

  private async hello(socket: BridgeSocket): Promise<void> {
    if (!this.endpoint) return;
    try {
      const res = (await this.rawCall(
        "auth.hello",
        { token: this.endpoint.token, client: "ui" },
        this.opts.helloTimeoutMs,
      )) as { version?: string; protocol?: number };
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.lastError.set(null);
      this.bridgeVersion.set(typeof res?.version === "string" ? res.version : null);
      this.status.set("connected");
    } catch (err) {
      if (this.socket !== socket) return;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(`handshake failed: ${message}`);
      this.opts.log(`auth.hello failed: ${message}`);
      // A rejected token will not fix itself by retrying quickly; still retry
      // with backoff so a restarted bridge (new token via bridge-status) works.
      this.teardownSocket("handshake failed");
      this.status.set("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      let msg: WireMessage;
      try {
        msg = JSON.parse(data) as WireMessage;
      } catch {
        this.opts.log(`ignoring non-JSON text frame: ${data.slice(0, 80)}`);
        return;
      }
      this.handleJson(msg);
      return;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      let frame: MediaFrame;
      try {
        frame = decodeFrame(
          data instanceof ArrayBuffer
            ? data
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      } catch (err) {
        this.opts.log(`bad binary frame: ${String(err)}`);
        return;
      }
      this.dispatchMedia(frame);
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      // Should not happen with binaryType = "arraybuffer", but be tolerant.
      void data.arrayBuffer().then((buf) => this.handleMessage(buf));
    }
  }

  private handleJson(msg: WireMessage): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.opts.log(`result for unknown id ${msg.id}`);
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else
        p.reject(
          new BridgeCallError(
            p.command,
            msg.error ?? { code: "unknown", message: "unknown bridge error" },
          ),
        );
      return;
    }
    if (msg.type === "event") {
      const set = this.eventHandlers.get(msg.event);
      if (set) for (const h of Array.from(set)) this.safely(() => h(msg.data));
      for (const h of Array.from(this.anyHandlers)) this.safely(() => h(msg.event, msg.data));
      return;
    }
    this.opts.log(`unexpected message type ${(msg as { type?: string }).type}`);
  }

  private dispatchMedia(frame: MediaFrame): void {
    const specific = this.mediaHandlers.get(frame.serial);
    if (specific) for (const h of Array.from(specific)) this.safely(() => h(frame));
    const all = this.mediaHandlers.get("*");
    if (all) for (const h of Array.from(all)) this.safely(() => h(frame));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.log(`handler threw: ${String(err)}`);
    }
  }

  private failPending(error: BridgeError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeCallError(p.command, error));
      this.pending.delete(id);
    }
  }

  private teardownSocket(reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, reason);
    } catch {
      /* ignore */
    }
    this.failPending({ code: "disconnected", message: reason });
  }

  private scheduleReconnect(): void {
    if (!this.opts.autoReconnect || this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(
      this.opts.backoffMaxMs,
      this.opts.backoffMinMs * 2 ** Math.min(this.attempt, 10),
    );
    const jitter = Math.floor(Math.random() * Math.min(250, delay / 4));
    this.attempt += 1;
    this.opts.log(`reconnecting in ${delay + jitter} ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay + jitter);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
