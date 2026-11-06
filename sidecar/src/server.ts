import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Bridge, Client } from "./bridge.ts";
import { decodeFrame } from "./frames.ts";
import type { Logger } from "./log.ts";
import { ErrorCode, PROTOCOL_VERSION, errorInfo, type CommandMessage, type ResultMessage } from "./protocol.ts";

export type ServerOptions = {
  bridge: Bridge;
  token: string;
  log: Logger;
  /** Unauthenticated sockets are closed after this many ms (default 5000). */
  helloTimeoutMs?: number;
  host?: string;
};

const MAX_JSON_BYTES = 1 << 20;

/**
 * Websocket front-end for the bridge. Owns the auth handshake
 * (`auth.hello` must be the first message) and JSON/binary demuxing.
 */
export class BridgeServer {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly opts: Required<Pick<ServerOptions, "helloTimeoutMs" | "host">> & ServerOptions;
  private nextClientId = 1;
  private readonly sockets = new Set<WebSocket>();

  constructor(opts: ServerOptions) {
    this.opts = { helloTimeoutMs: 5000, host: "127.0.0.1", ...opts };
    this.http = createServer((_req, res) => {
      res.statusCode = 426;
      res.setHeader("content-type", "text/plain");
      res.end("eufy-bridge: websocket only\n");
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 16 * 1024 * 1024 });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("error", (err) => this.opts.log.error("websocket server error", err));
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, this.opts.host, () => {
        this.http.off("error", reject);
        resolve((this.http.address() as AddressInfo).port);
      });
    });
  }

  get port(): number {
    const addr = this.http.address();
    return addr && typeof addr === "object" ? addr.port : 0;
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) {
      try {
        ws.close(1001, "bridge shutting down");
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }

  private onConnection(ws: WebSocket): void {
    const { bridge, log } = this.opts;
    const id = this.nextClientId++;
    this.sockets.add(ws);
    let client: Client | null = null;
    log.debug(`connection ${id}: opened`);

    const sendJson = (msg: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    };
    const sendResult = (res: ResultMessage) => sendJson(res);

    const helloTimer = setTimeout(() => {
      if (!client) {
        log.warn(`connection ${id}: no auth.hello within ${this.opts.helloTimeoutMs} ms, closing`);
        ws.close(4401, "auth.hello required");
      }
    }, this.opts.helloTimeoutMs);
    helloTimer.unref();

    ws.on("message", (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          if (!client) {
            ws.close(4401, "auth.hello required");
            return;
          }
          const buf = toBuffer(data);
          const frame = decodeFrame(buf);
          if (!frame) {
            log.debug(`client ${id}: malformed binary frame (${buf.length} bytes)`);
            return;
          }
          bridge.handleBinary(client, frame.kind, frame.serial, frame.payload);
          return;
        }
        const buf = toBuffer(data);
        if (buf.length > MAX_JSON_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        let msg: CommandMessage;
        try {
          msg = JSON.parse(buf.toString("utf8")) as CommandMessage;
        } catch {
          if (!client) ws.close(4400, "invalid JSON");
          else log.debug(`client ${id}: invalid JSON ignored`);
          return;
        }
        if (!msg || msg.type !== "command" || typeof msg.command !== "string") {
          if (!client) ws.close(4400, "first message must be an auth.hello command");
          else if (msg && typeof (msg as { id?: unknown }).id === "string") {
            sendResult({ type: "result", id: (msg as { id: string }).id, ok: false, error: { code: ErrorCode.InvalidParams, message: "malformed command" } });
          }
          return;
        }
        const msgId = typeof msg.id === "string" ? msg.id : "";

        if (!client) {
          if (msg.command !== "auth.hello") {
            sendResult({ type: "result", id: msgId, ok: false, error: { code: ErrorCode.Unauthorized, message: "auth.hello required" } });
            ws.close(4401, "auth.hello required");
            return;
          }
          const params = msg.params ?? {};
          if (typeof params.token !== "string" || !timingSafeEqualStr(params.token, this.opts.token)) {
            log.warn(`connection ${id}: bad token`);
            sendResult({ type: "result", id: msgId, ok: false, error: { code: ErrorCode.Unauthorized, message: "invalid token" } });
            ws.close(4403, "invalid token");
            return;
          }
          clearTimeout(helloTimer);
          const kind = params.client === "shell" ? "shell" : "ui";
          client = {
            id,
            kind,
            sendEvent: (event, eventData) => sendJson({ type: "event", event, data: eventData }),
            sendBinary: (frame) => {
              if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(frame, { binary: true });
            },
          };
          bridge.addClient(client);
          log.info(`client ${id}: authenticated (${kind})`);
          sendResult({ type: "result", id: msgId, ok: true, result: { version: bridge.version, protocol: PROTOCOL_VERSION } });
          return;
        }

        const c = client;
        bridge
          .handleCommand(c, msg.command, msg.params)
          .then((result) => sendResult({ type: "result", id: msgId, ok: true, result: result ?? {} }))
          .catch((err: unknown) => {
            const info = errorInfo(err);
            if (info.code === ErrorCode.EufyError || info.code === ErrorCode.Internal) {
              log.warn(`client ${id}: ${msg.command} failed: ${info.message}`);
            } else {
              log.debug(`client ${id}: ${msg.command} -> ${info.code}: ${info.message}`);
            }
            sendResult({ type: "result", id: msgId, ok: false, error: info });
          });
      } catch (err) {
        log.error(`connection ${id}: unhandled error in message handler`, err);
      }
    });

    ws.on("error", (err) => log.debug(`connection ${id}: socket error ${err.message}`));
    ws.on("close", (code) => {
      clearTimeout(helloTimer);
      this.sockets.delete(ws);
      log.debug(`connection ${id}: closed (${code})`);
      if (client) {
        bridge.removeClient(client);
        client = null;
      }
    });
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}
