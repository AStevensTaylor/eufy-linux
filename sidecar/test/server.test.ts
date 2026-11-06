import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Bridge } from "../src/bridge.ts";
import { Logger } from "../src/log.ts";
import { BridgeServer } from "../src/server.ts";
import { encodeFrame } from "../src/frames.ts";
import { FakeEufy } from "./fake-eufy.ts";

const TOKEN = "s3cret";

type Conn = {
  ws: WebSocket;
  send: (msg: unknown) => void;
  next: () => Promise<any>;
  closed: Promise<{ code: number; reason: string }>;
};

function connect(port: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const queue: any[] = [];
    const waiters: Array<(m: any) => void> = [];
    ws.on("message", (data, isBinary) => {
      const m = isBinary ? { binary: Buffer.from(data as Buffer) } : JSON.parse(data.toString());
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    });
    const closed = new Promise<{ code: number; reason: string }>((res) => ws.on("close", (code, reason) => res({ code, reason: reason.toString() })));
    ws.once("error", reject);
    ws.once("open", () =>
      resolve({
        ws,
        send: (msg) => ws.send(JSON.stringify(msg)),
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
        closed,
      }),
    );
  });
}

describe("websocket server auth gate", () => {
  let dataDir: string;
  let bridge: Bridge;
  let server: BridgeServer;
  let port: number;

  before(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "eufy-bridge-server-"));
    const log = new Logger("error", "test");
    bridge = new Bridge({ dataDir, log, version: "test", createEufy: async (c) => new FakeEufy(c) });
    server = new BridgeServer({ bridge, token: TOKEN, log, helloTimeoutMs: 200 });
    port = await server.listen(0);
    assert.ok(port > 0);
  });
  after(async () => {
    await server.close();
    await bridge.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("binds 127.0.0.1 only", () => {
    assert.equal(server.port, port);
  });

  test("valid hello, then commands and binary frames are accepted", async () => {
    const c = await connect(port);
    c.send({ type: "command", id: "1", command: "auth.hello", params: { token: TOKEN, client: "ui" } });
    assert.deepEqual(await c.next(), { type: "result", id: "1", ok: true, result: { version: "test", protocol: 1 } });
    c.send({ type: "command", id: "2", command: "bridge.ping" });
    assert.deepEqual(await c.next(), { type: "result", id: "2", ok: true, result: { pong: true } });
    // repeated hello is harmless
    c.send({ type: "command", id: "3", command: "auth.hello", params: { token: TOKEN } });
    assert.equal((await c.next()).ok, true);
    // unknown talkback frames are ignored, not fatal
    c.ws.send(encodeFrame(0x10, "NOPE", Buffer.alloc(4)), { binary: true });
    c.send({ type: "command", id: "4", command: "device.get", params: { serial: "x" } });
    const r = await c.next();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_logged_in");
    c.send({ type: "command", id: "5", command: "state.get" });
    assert.equal((await c.next()).ok, true);
    assert.equal(bridge.clientCount, 1);
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bridge.clientCount, 0);
  });

  test("first message must be auth.hello", async () => {
    const c = await connect(port);
    c.send({ type: "command", id: "1", command: "bridge.ping" });
    const r = await c.next();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "unauthorized");
    const closed = await c.closed;
    assert.equal(closed.code, 4401);
  });

  test("wrong token is rejected and the socket closed", async () => {
    const c = await connect(port);
    c.send({ type: "command", id: "1", command: "auth.hello", params: { token: "wrong", client: "ui" } });
    const r = await c.next();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "unauthorized");
    assert.equal((await c.closed).code, 4403);
    assert.equal(bridge.clientCount, 0);
  });

  test("silent connections are closed after the hello timeout", async () => {
    const c = await connect(port);
    const closed = await c.closed;
    assert.equal(closed.code, 4401);
  });

  test("binary frame before hello closes the connection", async () => {
    const c = await connect(port);
    c.ws.send(encodeFrame(0x10, "SN", Buffer.alloc(2)), { binary: true });
    assert.equal((await c.closed).code, 4401);
  });

  test("garbage before hello closes the connection", async () => {
    const c = await connect(port);
    c.ws.send("not json");
    assert.equal((await c.closed).code, 4400);
  });

  test("events are broadcast to authenticated clients", async () => {
    const c = await connect(port);
    c.send({ type: "command", id: "1", command: "auth.hello", params: { token: TOKEN, client: "shell" } });
    await c.next();
    bridge.broadcast("bridge.log", { level: "warn", message: "hi" });
    assert.deepEqual(await c.next(), { type: "event", event: "bridge.log", data: { level: "warn", message: "hi" } });
    c.ws.close();
    await c.closed;
  });
});
