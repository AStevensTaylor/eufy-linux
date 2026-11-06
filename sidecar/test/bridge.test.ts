import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge, type Client } from "../src/bridge.ts";
import { Logger } from "../src/log.ts";
import { BridgeError, FrameKind, type DeviceEvent } from "../src/protocol.ts";
import { decodeFrame } from "../src/frames.ts";
import { CommandName } from "../src/serialize.ts";
import { FakeEufy, tick, waitFor } from "./fake-eufy.ts";
import { findFfmpeg } from "../src/talkback.ts";

class FakeClient implements Client {
  static nextId = 1;
  readonly id = FakeClient.nextId++;
  readonly kind = "ui" as const;
  readonly events: Array<{ event: string; data: any }> = [];
  readonly frames: Buffer[] = [];
  sendEvent(event: string, data: unknown) {
    this.events.push({ event, data });
  }
  sendBinary(frame: Buffer) {
    this.frames.push(frame);
  }
  of(event: string) {
    return this.events.filter((e) => e.event === event).map((e) => e.data);
  }
  last(event: string) {
    const all = this.of(event);
    return all[all.length - 1];
  }
}

const DOORBELL = {
  serial: "T8210DOORBELL01",
  stationSerial: "T8010STATION01",
  name: "Front Door",
  doorbell: true,
  battery: true,
  type: 7,
  commands: [CommandName.DeviceStartLivestream, CommandName.DeviceStopLivestream, CommandName.DeviceStartTalkback, CommandName.DeviceStopTalkback, CommandName.DeviceQuickResponse],
  properties: { name: "Front Door", enabled: true, battery: 88, picture: { data: Buffer.from("x"), type: { mime: "image/jpeg", ext: "jpg" } }, nested: { when: new Date(0), big: 10n } },
  voices: { 1: { voice_id: 1, desc: "Leave the package" }, 2: { voice_id: 2, desc: "Be right there" } },
};
const SENSOR = { serial: "T8900SENSOR01", stationSerial: "T8010STATION01", name: "Door sensor", sensor: true, type: 2, commands: [], properties: { sensorOpen: false } };

type Ctx = { dataDir: string; bridge: Bridge; eufy: FakeEufy | null; client: FakeClient; ffmpeg: string | null; log: Logger; logLines: string[] };

function makeCtx(opts: { ffmpeg?: string | null; pictureWaitMs?: number } = {}): Ctx {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "eufy-bridge-test-"));
  const log = new Logger("error", "test");
  const logLines: string[] = [];
  log.addSink((level, message) => logLines.push(`${level} ${message}`));
  const ctx: Ctx = { dataDir, eufy: null, client: new FakeClient(), ffmpeg: opts.ffmpeg ?? null, log, logLines } as Ctx;
  ctx.bridge = new Bridge({
    dataDir,
    log,
    version: "test",
    pictureWaitMs: opts.pictureWaitMs ?? 150,
    pictureRecentMs: 1000,
    findFfmpeg: async () => ctx.ffmpeg,
    createEufy: async (config) => {
      const e = new FakeEufy(config);
      e.addStation("T8010STATION01");
      e.addDevice(DOORBELL);
      e.addDevice(SENSOR);
      ctx.eufy = e;
      return e;
    },
  });
  ctx.bridge.addClient(ctx.client);
  return ctx;
}

async function call(ctx: Ctx, command: string, params?: Record<string, unknown>, client: Client = ctx.client) {
  return ctx.bridge.handleCommand(client, command, params);
}

async function expectError(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof BridgeError, `expected BridgeError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

async function loginAndConnect(ctx: Ctx) {
  const r = await call(ctx, "auth.login", { username: "u@example.com", password: "pw" });
  assert.deepEqual(r, { started: true });
  await waitFor(() => ctx.bridge.authStatus.state === "connected", 2000, "connected");
}

describe("bridge", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(async () => {
    await ctx.bridge.shutdown();
    rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test("bridge.ping and auth.hello work while logged out", async () => {
    assert.deepEqual(await call(ctx, "bridge.ping"), { pong: true });
    assert.deepEqual(await call(ctx, "auth.hello", { token: "x" }), { version: "test", protocol: 1 });
    assert.deepEqual(await call(ctx, "auth.status"), { state: "logged_out", username: null, pushConnected: false });
    assert.deepEqual(await call(ctx, "state.get"), { auth: { state: "logged_out", username: null, pushConnected: false }, stations: [], devices: [] });
  });

  test("unknown command and bad params are reported with codes", async () => {
    await expectError(call(ctx, "nope.command"), "unknown_command");
    await expectError(call(ctx, "auth.login", { username: "x" }), "invalid_params");
    await expectError(call(ctx, "device.get", { serial: "X" }), "not_logged_in");
    await expectError(call(ctx, "auth.verify_code", { code: "1" }), "not_logged_in");
  });

  test("login stores credentials (0600), connects and broadcasts auth.status", async () => {
    await loginAndConnect(ctx);
    const file = path.join(ctx.dataDir, "credentials.json");
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.username, "u@example.com");
    assert.equal(saved.country, "GB");
    assert.equal(ctx.eufy!.config.persistentDir, ctx.dataDir);
    assert.equal(ctx.eufy!.config.p2pConnectionSetup, 2);
    assert.equal(ctx.eufy!.maxLivestreamSeconds, 0);
    const states = ctx.client.of("auth.status").map((s) => s.state);
    assert.deepEqual(states.slice(0, 2), ["connecting", "connected"]);
    assert.equal(ctx.client.last("auth.status").pushConnected, true);
    assert.equal(ctx.client.last("auth.status").username, "u@example.com");
  });

  test("2FA flow", async () => {
    ctx.bridge = new Bridge({
      dataDir: ctx.dataDir,
      log: ctx.log,
      version: "test",
      createEufy: async (config) => {
        const e = new FakeEufy(config);
        e.connectBehaviour = "tfa";
        ctx.eufy = e;
        return e;
      },
    });
    ctx.bridge.addClient(ctx.client);
    await call(ctx, "auth.login", { username: "u", password: "p" });
    await waitFor(() => ctx.bridge.authStatus.state === "tfa_required");
    assert.equal(ctx.client.of("auth.tfa_required").length, 1);
    await call(ctx, "auth.verify_code", { code: "123456" });
    await waitFor(() => ctx.bridge.authStatus.state === "connected");
    const connectCalls = ctx.eufy!.calls.filter(([n]) => n === "connect");
    assert.deepEqual(connectCalls[1]![1][0], { verifyCode: "123456", force: false });
  });

  test("captcha flow delivers a data URL and passes the answer back", async () => {
    ctx.bridge = new Bridge({
      dataDir: ctx.dataDir,
      log: ctx.log,
      version: "test",
      createEufy: async (config) => {
        const e = new FakeEufy(config);
        e.connectBehaviour = "captcha";
        ctx.eufy = e;
        return e;
      },
    });
    ctx.bridge.addClient(ctx.client);
    await call(ctx, "auth.login", { username: "u", password: "p" });
    await waitFor(() => ctx.bridge.authStatus.state === "captcha_required");
    const cap = ctx.client.last("auth.captcha_required");
    assert.equal(cap.id, "cap-1");
    assert.equal(cap.image, "data:image/png;base64,iVBORw0KGgo=");
    await call(ctx, "auth.captcha", { id: "cap-1", code: "abcd" });
    await waitFor(() => ctx.bridge.authStatus.state === "connected");
    const connectCalls = ctx.eufy!.calls.filter(([n]) => n === "connect");
    assert.deepEqual(connectCalls[1]![1][0], { captcha: { captchaId: "cap-1", captchaCode: "abcd" }, force: false });
  });

  test("connect failure becomes auth.status error + auth.error", async () => {
    ctx.bridge = new Bridge({
      dataDir: ctx.dataDir,
      log: ctx.log,
      version: "test",
      createEufy: async (config) => {
        const e = new FakeEufy(config);
        e.connectBehaviour = "error";
        return e;
      },
    });
    ctx.bridge.addClient(ctx.client);
    await call(ctx, "auth.login", { username: "u", password: "p" });
    await waitFor(() => ctx.bridge.authStatus.state === "error");
    assert.equal(ctx.bridge.authStatus.error?.code, "eufy_error");
    assert.equal(ctx.client.last("auth.error").message, "boom");
  });

  test("auto-connects on start when credentials are stored", async () => {
    writeFileSync(path.join(ctx.dataDir, "credentials.json"), JSON.stringify({ username: "stored@example.com", password: "pw" }));
    await ctx.bridge.start();
    await waitFor(() => ctx.bridge.authStatus.state === "connected");
    assert.equal(ctx.bridge.authStatus.username, "stored@example.com");
  });

  test("state.get serializes devices and stations per the protocol", async () => {
    await loginAndConnect(ctx);
    const state = (await call(ctx, "state.get")) as any;
    assert.equal(state.auth.state, "connected");
    assert.equal(state.stations.length, 1);
    assert.deepEqual(state.stations[0], {
      serial: "T8010STATION01",
      name: "HomeBase",
      model: "T8010",
      guardMode: 1,
      currentMode: 1,
      connected: true,
      lanIp: "192.168.1.10",
      properties: { guardMode: 1, lanIpAddress: "192.168.1.10" },
    });
    const db = state.devices.find((d: any) => d.serial === DOORBELL.serial);
    assert.equal(db.kind, "doorbell");
    assert.equal(db.isDoorbell, true);
    assert.equal(db.isCamera, true);
    assert.equal(db.hasBattery, true);
    assert.equal(db.stationSerial, "T8010STATION01");
    assert.deepEqual(db.capabilities, { livestream: true, talkback: true, quickResponse: true, snapshot: true });
    assert.equal("picture" in db.properties, false, "picture must be excluded from properties");
    assert.deepEqual(db.properties.nested, { when: "1970-01-01T00:00:00.000Z", big: "10" });
    const sensor = state.devices.find((d: any) => d.serial === SENSOR.serial);
    assert.equal(sensor.kind, "sensor");
    assert.deepEqual(sensor.capabilities, { livestream: false, talkback: false, quickResponse: false, snapshot: false });
    assert.equal(ctx.client.of("device.added").length, 2);
    assert.equal(ctx.client.of("station.added").length, 1);
    assert.deepEqual(await call(ctx, "devices.list"), state.devices);
    assert.deepEqual(await call(ctx, "device.get", { serial: SENSOR.serial }), sensor);
    await expectError(call(ctx, "device.get", { serial: "unknown" }), "device_not_found");
  });

  test("device.set_property, station.set_guard_mode, quick_response, voices", async () => {
    await loginAndConnect(ctx);
    assert.deepEqual(await call(ctx, "device.set_property", { serial: DOORBELL.serial, name: "enabled", value: false }), {});
    assert.deepEqual(ctx.eufy!.calls.find(([n]) => n === "setDeviceProperty")![1], [DOORBELL.serial, "enabled", false]);
    assert.deepEqual(ctx.client.last("device.property_changed"), { serial: DOORBELL.serial, name: "enabled", value: false });
    await expectError(call(ctx, "device.set_property", { serial: DOORBELL.serial, name: "enabled" }), "invalid_params");

    assert.deepEqual(await call(ctx, "station.set_guard_mode", { serial: "T8010STATION01", mode: 63 }), {});
    assert.deepEqual(ctx.eufy!.stations.get("T8010STATION01")!.calls[0], ["setGuardMode", [63]]);
    await expectError(call(ctx, "station.set_guard_mode", { serial: "nope", mode: 1 }), "station_not_found");

    assert.deepEqual(await call(ctx, "device.quick_response", { serial: DOORBELL.serial, voiceId: 2 }), {});
    assert.deepEqual(ctx.eufy!.stations.get("T8010STATION01")!.calls[1], ["quickResponse", [DOORBELL.serial, 2]]);
    await expectError(call(ctx, "device.quick_response", { serial: SENSOR.serial, voiceId: 2 }), "unsupported");

    assert.deepEqual(await call(ctx, "device.voices", { serial: DOORBELL.serial }), {
      voices: [
        { id: 1, name: "Leave the package" },
        { id: 2, name: "Be right there" },
      ],
    });
    await expectError(call(ctx, "device.voices", { serial: SENSOR.serial }), "unsupported");
    // debounced device.updated follows the property change
    await waitFor(() => ctx.client.of("device.updated").length > 0, 1500, "device.updated");
    await waitFor(() => ctx.client.of("station.updated").length > 0, 1500, "station.updated");
  });

  test("device events: mapping, push title, picture attach, ring buffer, device.picture", async () => {
    await loginAndConnect(ctx);
    const eufy = ctx.eufy!;
    const dev = eufy.devices.get(DOORBELL.serial)!;
    // a state=false event is emitted immediately and without picture
    eufy.emit("device motion detected", dev, false);
    assert.equal(ctx.client.of("device.event").length, 1);
    let ev = ctx.client.last("device.event") as DeviceEvent;
    assert.equal(ev.kind, "motion");
    assert.equal(ev.state, false);
    assert.equal(ev.picture, undefined);
    assert.equal(ev.deviceName, "Front Door");
    assert.equal(ev.stationSerial, "T8010STATION01");

    // ring with push title and a thumbnail arriving shortly after
    eufy.emit("push message", { device_sn: DOORBELL.serial, station_sn: "T8010STATION01", title: "Front Door", content: "Someone is at the door", type: 3101 });
    assert.equal(ctx.client.of("push.message").length, 1);
    eufy.emit("device rings", dev, true);
    assert.equal(ctx.client.of("device.event").length, 1, "ring is held while waiting for its picture");
    eufy.emit("device property changed", dev, "picture", { data: Buffer.from("JPEGDATA"), type: { mime: "image/jpeg", ext: "jpg" } });
    assert.equal(ctx.client.of("device.event").length, 2);
    ev = ctx.client.last("device.event");
    assert.equal(ev.kind, "ring");
    assert.equal(ev.state, true);
    assert.equal(ev.title, "Front Door");
    assert.equal(ev.content, "Someone is at the door");
    assert.deepEqual(ev.picture, { mime: "image/jpeg", data: Buffer.from("JPEGDATA").toString("base64") });
    assert.equal(ctx.client.of("device.property_changed").some((p) => p.name === "picture"), false, "picture never goes out as property_changed");

    // person detected carries the name; recent picture (within pictureRecentMs) attaches immediately
    eufy.emit("device person detected", dev, true, "Alice");
    assert.equal(ctx.client.of("device.event").length, 3);
    ev = ctx.client.last("device.event");
    assert.equal(ev.kind, "person");
    assert.equal(ev.personName, "Alice");
    assert.ok(ev.picture);

    // event without a picture is released after pictureWaitMs
    eufy.emit("device property changed", dev, "picture", { data: Buffer.from("OLD"), type: { mime: "image/png", ext: "png" } });
    await tick(1100);
    eufy.emit("device pet detected", dev, true);
    assert.equal(ctx.client.of("device.event").length, 3);
    await waitFor(() => ctx.client.of("device.event").length === 4, 1000, "delayed pet event");
    ev = ctx.client.last("device.event");
    assert.equal(ev.kind, "pet");
    assert.equal(ev.picture, undefined);

    // other mappings
    for (const [name, kind] of [
      ["device stranger person detected", "stranger"],
      ["device vehicle detected", "vehicle"],
      ["device sound detected", "sound"],
      ["device crying detected", "crying"],
      ["device package delivered", "package_delivered"],
      ["device package taken", "package_taken"],
      ["device package stranded", "package_stranded"],
      ["device someone loitering", "loitering"],
      ["device radar motion detected", "radar_motion"],
      ["device dog detected", "dog"],
      ["device low battery", "low_battery"],
      ["device open", "other"],
    ] as const) {
      eufy.emit(name, dev, false);
      assert.equal((ctx.client.last("device.event") as DeviceEvent).kind, kind, name);
    }

    const recent = (await call(ctx, "events.recent", { limit: 3 })) as { events: DeviceEvent[] };
    assert.equal(recent.events.length, 3);
    assert.equal(recent.events[0]!.kind, "other", "newest first");
    const all = (await call(ctx, "events.recent")) as { events: DeviceEvent[] };
    assert.equal(all.events.length, 16);
    assert.ok(all.events.every((e) => typeof e.id === "string" && typeof e.timestamp === "number"));

    const pic = (await call(ctx, "device.picture", { serial: DOORBELL.serial })) as any;
    assert.deepEqual(pic, { picture: { mime: "image/png", data: Buffer.from("OLD").toString("base64") } });
    assert.ok(existsSync(path.join(ctx.dataDir, "pictures", `${DOORBELL.serial}.png`)));
    assert.deepEqual(await call(ctx, "device.picture", { serial: SENSOR.serial }), { picture: null });
  });

  test("livestream subscription, fan-out, refcounting and late joiners", async () => {
    await loginAndConnect(ctx);
    const eufy = ctx.eufy!;
    const c2 = new FakeClient();
    ctx.bridge.addClient(c2);

    await expectError(call(ctx, "livestream.start", { serial: SENSOR.serial }), "unsupported");
    assert.deepEqual(await call(ctx, "livestream.start", { serial: DOORBELL.serial }), {});
    await waitFor(() => ctx.client.of("livestream.started").length === 1, 1000, "livestream.started");
    assert.deepEqual(ctx.client.last("livestream.started"), {
      serial: DOORBELL.serial,
      metadata: { videoCodec: "h264", videoWidth: 1600, videoHeight: 1200, videoFPS: 15, audioCodec: "aac" },
    });
    assert.equal(c2.of("livestream.started").length, 1, "started is broadcast to everyone");
    assert.equal(ctx.bridge.isLivestreamActive(DOORBELL.serial), true);

    eufy.liveVideo.get(DOORBELL.serial)!.write(Buffer.from([0, 0, 0, 1, 0x65, 1, 2]));
    eufy.liveAudio.get(DOORBELL.serial)!.write(Buffer.from([0xff, 0xf1]));
    await tick(5);
    assert.equal(ctx.client.frames.length, 2);
    assert.equal(c2.frames.length, 0, "media only goes to subscribers");
    const v = decodeFrame(ctx.client.frames[0]!)!;
    assert.equal(v.kind, FrameKind.Video);
    assert.equal(v.serial, DOORBELL.serial);
    assert.deepEqual([...v.payload], [0, 0, 0, 1, 0x65, 1, 2]);
    const a = decodeFrame(ctx.client.frames[1]!)!;
    assert.equal(a.kind, FrameKind.Audio);
    assert.deepEqual([...a.payload], [0xff, 0xf1]);

    // second subscriber joins late: no new eufy start, but it gets the metadata
    await call(ctx, "livestream.start", { serial: DOORBELL.serial }, c2);
    assert.equal(eufy.calls.filter(([n]) => n === "startStationLivestream").length, 1);
    assert.equal(c2.of("livestream.started").length, 2);
    eufy.liveVideo.get(DOORBELL.serial)!.write(Buffer.from([9]));
    await tick(5);
    assert.equal(c2.frames.length, 1);
    assert.equal(ctx.client.frames.length, 3);

    // first leaves: stream keeps running
    await call(ctx, "livestream.stop", { serial: DOORBELL.serial });
    assert.equal(eufy.calls.filter(([n]) => n === "stopStationLivestream").length, 0);
    eufy.liveVideo.get(DOORBELL.serial)!.write(Buffer.from([8]));
    await tick(5);
    assert.equal(ctx.client.frames.length, 3, "unsubscribed client receives nothing");
    assert.equal(c2.frames.length, 2);

    // last one disconnects: stream is stopped and livestream.stopped broadcast
    ctx.bridge.removeClient(c2);
    await waitFor(() => eufy.calls.filter(([n]) => n === "stopStationLivestream").length === 1, 1000, "stop");
    await waitFor(() => ctx.client.of("livestream.stopped").length === 1, 1000, "livestream.stopped");
    assert.equal(ctx.bridge.isLivestreamActive(DOORBELL.serial), false);

    // re-request after a stop works (client-driven restart after eufy's max duration)
    await call(ctx, "livestream.start", { serial: DOORBELL.serial });
    await waitFor(() => ctx.client.of("livestream.started").length === 2, 1000, "restart");
    assert.equal(eufy.calls.filter(([n]) => n === "startStationLivestream").length, 2);
  });

  test("livestream start failure is reported as result error and livestream.error", async () => {
    await loginAndConnect(ctx);
    ctx.eufy!.failStartLivestream = Object.assign(new Error("nope"), { name: "NotSupportedError" });
    await expectError(call(ctx, "livestream.start", { serial: DOORBELL.serial }), "unsupported");
    assert.deepEqual(ctx.client.last("livestream.error"), { serial: DOORBELL.serial, code: "unsupported", message: "nope" });
    assert.equal(ctx.bridge.isLivestreamActive(DOORBELL.serial), false);
  });

  test("talkback: ownership, ffmpeg_missing, AAC passthrough, stop on disconnect", async () => {
    await loginAndConnect(ctx);
    const eufy = ctx.eufy!;
    await expectError(call(ctx, "talkback.start", { serial: DOORBELL.serial }), "not_streaming");
    await call(ctx, "livestream.start", { serial: DOORBELL.serial });
    await waitFor(() => ctx.bridge.isLivestreamActive(DOORBELL.serial));

    ctx.ffmpeg = null;
    await expectError(call(ctx, "talkback.start", { serial: DOORBELL.serial }), "ffmpeg_missing");
    await expectError(call(ctx, "talkback.start", { serial: DOORBELL.serial, format: "opus" }), "invalid_params");
    await expectError(call(ctx, "talkback.start", { serial: SENSOR.serial, format: "aac" }), "unsupported");

    assert.deepEqual(await call(ctx, "talkback.start", { serial: DOORBELL.serial, format: "aac" }), {});
    await waitFor(() => ctx.client.of("talkback.started").length === 1, 1000, "talkback.started");
    assert.deepEqual(ctx.client.last("talkback.started"), { serial: DOORBELL.serial });

    const c2 = new FakeClient();
    ctx.bridge.addClient(c2);
    await expectError(call(ctx, "talkback.start", { serial: DOORBELL.serial, format: "aac" }, c2), "talkback_busy");
    await expectError(call(ctx, "talkback.stop", { serial: DOORBELL.serial }, c2), "talkback_busy");

    // AAC frames from the owner go straight into eufy's talkback stream; others are dropped
    ctx.bridge.handleBinary(ctx.client, FrameKind.TalkbackAac, DOORBELL.serial, Buffer.from([0xff, 0xf1, 0x50, 0x80]));
    ctx.bridge.handleBinary(c2, FrameKind.TalkbackAac, DOORBELL.serial, Buffer.from([1]));
    await tick(5);
    const tbs = eufy.talkbackStreams.get(DOORBELL.serial)!;
    assert.equal(tbs.received.length, 1);
    assert.deepEqual([...tbs.received[0]!], [0xff, 0xf1, 0x50, 0x80]);

    // PCM frames without ffmpeg produce a single ffmpeg_missing talkback.error
    ctx.bridge.handleBinary(ctx.client, FrameKind.TalkbackPcm, DOORBELL.serial, Buffer.alloc(320));
    ctx.bridge.handleBinary(ctx.client, FrameKind.TalkbackPcm, DOORBELL.serial, Buffer.alloc(320));
    assert.equal(ctx.client.of("talkback.error").length, 1);
    assert.equal(ctx.client.last("talkback.error").code, "ffmpeg_missing");

    assert.deepEqual(await call(ctx, "talkback.stop", { serial: DOORBELL.serial }), {});
    assert.equal(ctx.client.of("talkback.stopped").length, 1);
    assert.equal(eufy.calls.filter(([n]) => n === "stopStationTalkback").length, 1);
    await tick(5);
    assert.equal(ctx.client.of("talkback.stopped").length, 1, "eufy's stop event does not emit a second talkback.stopped");

    // owner disconnect ends the talkback
    await call(ctx, "talkback.start", { serial: DOORBELL.serial, format: "aac" });
    await waitFor(() => ctx.client.of("talkback.started").length === 2);
    ctx.bridge.removeClient(ctx.client);
    await waitFor(() => eufy.calls.filter(([n]) => n === "stopStationTalkback").length === 2, 1000, "stop on disconnect");
    assert.equal(ctx.bridge.isTalkbackActive(DOORBELL.serial), false);
    assert.equal(c2.of("talkback.stopped").length, 2);
  });

  test("talkback: PCM is transcoded to ADTS by ffmpeg", { skip: (await findFfmpeg()) === null ? "ffmpeg not installed" : false }, async () => {
    ctx.ffmpeg = await findFfmpeg();
    await loginAndConnect(ctx);
    const eufy = ctx.eufy!;
    await call(ctx, "livestream.start", { serial: DOORBELL.serial });
    await waitFor(() => ctx.bridge.isLivestreamActive(DOORBELL.serial));
    await call(ctx, "talkback.start", { serial: DOORBELL.serial });
    await waitFor(() => ctx.client.of("talkback.started").length === 1, 1000, "talkback.started");
    // one second of 16 kHz mono s16le (a 440 Hz tone), in 20 ms chunks
    const samples = 16000;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000), i * 2);
    for (let off = 0; off < pcm.length; off += 640) {
      ctx.bridge.handleBinary(ctx.client, FrameKind.TalkbackPcm, DOORBELL.serial, pcm.subarray(off, off + 640));
    }
    const tbs = eufy.talkbackStreams.get(DOORBELL.serial)!;
    await waitFor(() => tbs.received.length > 0, 5000, "ADTS output from ffmpeg");
    const out = Buffer.concat(tbs.received);
    assert.equal(out[0], 0xff, "ADTS syncword");
    assert.equal(out[1]! & 0xf0, 0xf0, "ADTS syncword");
    await call(ctx, "talkback.stop", { serial: DOORBELL.serial });
    assert.equal(ctx.client.of("talkback.error").length, 0);
  });

  test("logout clears credentials, persistent data and inventory", async () => {
    await loginAndConnect(ctx);
    writeFileSync(path.join(ctx.dataDir, "persistent.json"), "{}");
    assert.deepEqual(await call(ctx, "auth.logout"), {});
    assert.equal(existsSync(path.join(ctx.dataDir, "credentials.json")), false);
    assert.equal(existsSync(path.join(ctx.dataDir, "persistent.json")), false);
    assert.equal(ctx.eufy!.closed, true);
    assert.deepEqual(ctx.bridge.authStatus, { state: "logged_out", username: null, pushConnected: false });
    assert.equal(ctx.client.of("device.removed").length, 2);
    assert.deepEqual(await call(ctx, "devices.list"), []);
    await expectError(call(ctx, "device.get", { serial: DOORBELL.serial }), "not_logged_in");
  });

  test("a throwing eufy event handler never escapes", async () => {
    await loginAndConnect(ctx);
    const bad = { getSerial: () => { throw new Error("broken device"); } };
    ctx.eufy!.emit("device added", bad);
    ctx.eufy!.emit("device rings", bad, true);
    assert.ok(ctx.logLines.some((l) => l.includes("broken device")));
    assert.deepEqual(await call(ctx, "bridge.ping"), { pong: true });
  });
});
