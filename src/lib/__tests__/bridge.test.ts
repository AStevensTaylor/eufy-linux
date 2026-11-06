import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeCallError, BridgeClient, type BridgeSocket } from "../bridge";
import { decodeFrame, encodeFrame } from "../frames";
import { FrameKind } from "../types";

class FakeSocket implements BridgeSocket {
  static instances: FakeSocket[] = [];
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: Array<string | Uint8Array> = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("not open");
    if (typeof data === "string") this.sent.push(data);
    else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else this.sent.push(new Uint8Array(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // --- test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  receiveBinary(buf: Uint8Array): void {
    this.onmessage?.({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  }
  serverClose(reason = "bye"): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason });
  }
  lastCommand(): { type: string; id: string; command: string; params?: unknown } {
    const text = [...this.sent].reverse().find((s): s is string => typeof s === "string");
    if (!text) throw new Error("no command sent");
    return JSON.parse(text) as { type: string; id: string; command: string; params?: unknown };
  }
  /** Reply ok to a command by id. */
  reply(id: string, result: unknown): void {
    this.receive({ type: "result", id, ok: true, result });
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof BridgeClient>[0]> = {}) {
  return new BridgeClient({
    socketFactory: (url) => new FakeSocket(url),
    requestTimeoutMs: 1000,
    helloTimeoutMs: 1000,
    backoffMinMs: 100,
    backoffMaxMs: 400,
    ...overrides,
  });
}

/** Open the socket and complete the auth.hello handshake. */
function handshake(sock: FakeSocket) {
  sock.open();
  const hello = sock.lastCommand();
  expect(hello.command).toBe("auth.hello");
  expect(hello.params).toEqual({ token: "tok", client: "ui" });
  sock.reply(hello.id, { version: "1.2.3", protocol: 1 });
}

describe("BridgeClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs auth.hello on open and reports connected", async () => {
    const client = makeClient();
    const statuses: string[] = [];
    client.status.subscribe((s) => statuses.push(s));
    client.connect({ url: "ws://127.0.0.1:1/", token: "tok" });
    expect(client.status.get()).toBe("connecting");
    const sock = FakeSocket.instances[0];
    expect(sock.binaryType).toBe("arraybuffer");
    handshake(sock);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.status.get()).toBe("connected");
    expect(client.bridgeVersion.get()).toBe("1.2.3");
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("matches results to calls by id and rejects errors with the bridge code", async () => {
    const client = makeClient();
    client.connect({ url: "ws://x/", token: "tok" });
    const sock = FakeSocket.instances[0];
    handshake(sock);
    await vi.advanceTimersByTimeAsync(0);

    const p1 = client.call("bridge.ping");
    const c1 = sock.lastCommand();
    const p2 = client.call("device.get", { serial: "S1" });
    const c2 = sock.lastCommand();
    expect(c1.id).not.toBe(c2.id);
    expect(c2.params).toEqual({ serial: "S1" });

    // Reply out of order.
    sock.receive({ type: "result", id: c2.id, ok: false, error: { code: "not_found", message: "nope" } });
    sock.reply(c1.id, { pong: true });

    await expect(p1).resolves.toEqual({ pong: true });
    const err = await p2.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeCallError);
    expect((err as BridgeCallError).code).toBe("not_found");
    expect((err as BridgeCallError).command).toBe("device.get");
  });

  it("times out calls that never get a result", async () => {
    const client = makeClient({ requestTimeoutMs: 500 });
    client.connect({ url: "ws://x/", token: "tok" });
    const sock = FakeSocket.instances[0];
    handshake(sock);
    await vi.advanceTimersByTimeAsync(0);
    const p = client.call("bridge.ping");
    const rejection = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600);
    const err = await rejection;
    expect((err as BridgeCallError).code).toBe("timeout");
  });

  it("rejects calls while not connected and before the handshake", async () => {
    const client = makeClient();
    await expect(client.call("bridge.ping")).rejects.toMatchObject({ code: "not_connected" });
    client.connect({ url: "ws://x/", token: "tok" });
    FakeSocket.instances[0].open();
    await expect(client.call("bridge.ping")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("dispatches typed events and binary media frames per serial", async () => {
    const client = makeClient();
    client.connect({ url: "ws://x/", token: "tok" });
    const sock = FakeSocket.instances[0];
    handshake(sock);
    await vi.advanceTimersByTimeAsync(0);

    const seen: string[] = [];
    const off = client.on("livestream.started", (d) => seen.push(`${d.serial}:${d.metadata.videoCodec}`));
    const any: string[] = [];
    client.onAny((e) => any.push(e));
    sock.receive({
      type: "event",
      event: "livestream.started",
      data: { serial: "A", metadata: { videoCodec: "h264", videoWidth: 1, videoHeight: 1, videoFPS: 15, audioCodec: "aac" } },
    });
    expect(seen).toEqual(["A:h264"]);
    expect(any).toEqual(["livestream.started"]);
    off();
    sock.receive({ type: "event", event: "livestream.started", data: { serial: "B", metadata: {} } });
    expect(seen).toEqual(["A:h264"]);

    const framesA: number[] = [];
    const framesAll: string[] = [];
    client.onMedia("A", (f) => framesA.push(f.kind));
    client.onMedia("*", (f) => framesAll.push(f.serial));
    sock.receiveBinary(encodeFrame(FrameKind.Video, "A", new Uint8Array([1])));
    sock.receiveBinary(encodeFrame(FrameKind.Audio, "B", new Uint8Array([2])));
    expect(framesA).toEqual([FrameKind.Video]);
    expect(framesAll).toEqual(["A", "B"]);
  });

  it("sends binary frames only when connected", async () => {
    const client = makeClient();
    expect(client.sendBinary(FrameKind.TalkbackPcm, "A", new Uint8Array([1]))).toBe(false);
    client.connect({ url: "ws://x/", token: "tok" });
    const sock = FakeSocket.instances[0];
    handshake(sock);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sendBinary(FrameKind.TalkbackPcm, "A", new Uint8Array([1, 2]))).toBe(true);
    const last = sock.sent[sock.sent.length - 1];
    expect(last).toBeInstanceOf(Uint8Array);
    const frame = decodeFrame(last as Uint8Array);
    expect(frame).toMatchObject({ kind: 0x10, serial: "A" });
    expect(Array.from(frame.payload)).toEqual([1, 2]);
  });

  it("fails pending calls on close and reconnects with backoff", async () => {
    const client = makeClient({ backoffMinMs: 100, backoffMaxMs: 400 });
    client.connect({ url: "ws://x/", token: "tok" });
    const sock = FakeSocket.instances[0];
    handshake(sock);
    await vi.advanceTimersByTimeAsync(0);
    const p = client.call("bridge.ping");
    const rejection = p.catch((e: unknown) => e);
    sock.serverClose("gone");
    expect(client.status.get()).toBe("disconnected");
    expect((await rejection) as BridgeCallError).toMatchObject({ code: "disconnected" });
    expect(client.lastError.get()).toBe("gone");

    expect(FakeSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeSocket.instances.length).toBe(2);
    const sock2 = FakeSocket.instances[1];
    handshake(sock2);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.status.get()).toBe("connected");
    expect(client.lastError.get()).toBeNull();
  });

  it("does not reconnect after disconnect()", async () => {
    const client = makeClient();
    client.connect({ url: "ws://x/", token: "tok" });
    const sock = FakeSocket.instances[0];
    handshake(sock);
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect();
    expect(sock.closed).toBe(true);
    expect(client.status.get()).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("switches endpoints when connect() is called with a new token", async () => {
    const client = makeClient();
    client.connect({ url: "ws://x/", token: "tok" });
    handshake(FakeSocket.instances[0]);
    await vi.advanceTimersByTimeAsync(0);
    client.connect({ url: "ws://x/", token: "tok" }); // same: no-op
    expect(FakeSocket.instances.length).toBe(1);
    client.connect({ url: "ws://y/", token: "tok2" });
    expect(FakeSocket.instances[0].closed).toBe(true);
    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[1].url).toBe("ws://y/");
  });

  it("retries when the handshake is rejected", async () => {
    const client = makeClient();
    client.connect({ url: "ws://x/", token: "bad" });
    const sock = FakeSocket.instances[0];
    sock.open();
    const hello = sock.lastCommand();
    sock.receive({ type: "result", id: hello.id, ok: false, error: { code: "unauthorized", message: "bad token" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.status.get()).toBe("disconnected");
    expect(client.lastError.get()).toMatch(/bad token/);
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeSocket.instances.length).toBe(2);
  });
});
