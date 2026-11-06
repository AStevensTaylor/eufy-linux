/**
 * A scripted stand-in for eufy-security-client used by the bridge tests.
 */
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Transform } from "node:stream";
import type { DeviceLike, EufyConfig, EufyLike, EufyStreamMetadata, LoginOptions, StationLike } from "../src/eufy-types.ts";

export type FakeDeviceSpec = {
  serial: string;
  stationSerial: string;
  name?: string;
  model?: string;
  type?: number;
  doorbell?: boolean;
  camera?: boolean;
  lock?: boolean;
  sensor?: boolean;
  battery?: boolean;
  commands?: string[];
  properties?: Record<string, unknown>;
  voices?: Record<number, { voice_id: number; desc: string }>;
};

export class FakeDevice implements DeviceLike {
  readonly spec: FakeDeviceSpec;
  getVoices: (() => Record<number, { voice_id: number; desc: string }>) | undefined;
  constructor(spec: FakeDeviceSpec) {
    this.spec = spec;
    this.getVoices = spec.voices ? () => spec.voices! : undefined;
  }
  getSerial() {
    return this.spec.serial;
  }
  getStationSerial() {
    return this.spec.stationSerial;
  }
  getName() {
    return this.spec.name ?? "Device";
  }
  getModel() {
    return this.spec.model ?? "T8210";
  }
  getDeviceType() {
    return this.spec.type ?? 7;
  }
  getChannel() {
    return 0;
  }
  isDoorbell() {
    return this.spec.doorbell === true;
  }
  isCamera() {
    return this.spec.camera === true || this.spec.doorbell === true;
  }
  isLock() {
    return this.spec.lock === true;
  }
  isEntrySensor() {
    return this.spec.sensor === true;
  }
  isMotionSensor() {
    return false;
  }
  hasBattery() {
    return this.spec.battery === true;
  }
  hasCommand(name: string) {
    return (this.spec.commands ?? []).includes(name);
  }
  hasProperty(name: string) {
    return name in (this.spec.properties ?? {});
  }
  getProperties() {
    return this.spec.properties ?? {};
  }
  getPropertyValue(name: string) {
    return (this.spec.properties ?? {})[name];
  }
}

export class FakeStation implements StationLike {
  guardMode = 1;
  connected = true;
  readonly calls: Array<[string, unknown[]]> = [];
  readonly serial: string;
  readonly name: string;
  constructor(serial: string, name = "HomeBase") {
    this.serial = serial;
    this.name = name;
  }
  getSerial() {
    return this.serial;
  }
  getName() {
    return this.name;
  }
  getModel() {
    return "T8010";
  }
  getGuardMode() {
    return this.guardMode;
  }
  getCurrentMode() {
    return this.guardMode;
  }
  isConnected() {
    return this.connected;
  }
  getLANIPAddress() {
    return "192.168.1.10";
  }
  getProperties() {
    return { guardMode: this.guardMode, lanIpAddress: "192.168.1.10" };
  }
  setGuardMode(mode: number) {
    this.calls.push(["setGuardMode", [mode]]);
    this.guardMode = mode;
  }
  quickResponse(device: DeviceLike, voiceId: number) {
    this.calls.push(["quickResponse", [device.getSerial(), voiceId]]);
  }
  isLiveStreaming() {
    return false;
  }
  isTalkbackOngoing() {
    return false;
  }
}

export class FakeTalkbackStream extends Transform {
  readonly received: Buffer[] = [];
  override _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
    this.received.push(Buffer.from(chunk));
    cb();
  }
}

export const H264_META: EufyStreamMetadata = { videoCodec: 0, videoFPS: 15, videoWidth: 1600, videoHeight: 1200, audioCodec: 1 };

export class FakeEufy extends EventEmitter implements EufyLike {
  readonly config: EufyConfig;
  readonly devices = new Map<string, FakeDevice>();
  readonly stations = new Map<string, FakeStation>();
  readonly calls: Array<[string, unknown[]]> = [];
  connected = false;
  closed = false;
  /** Scripted behaviour of connect(). */
  connectBehaviour: "connect" | "tfa" | "captcha" | "error" | "hang" = "connect";
  failStartLivestream: Error | null = null;
  failStartTalkback: Error | null = null;
  readonly liveVideo = new Map<string, PassThrough>();
  readonly liveAudio = new Map<string, PassThrough>();
  readonly talkbackStreams = new Map<string, FakeTalkbackStream>();
  maxLivestreamSeconds: number | null = null;

  constructor(config: EufyConfig) {
    super();
    this.config = config;
  }

  addDevice(spec: FakeDeviceSpec): FakeDevice {
    const d = new FakeDevice(spec);
    this.devices.set(spec.serial, d);
    if (this.connected) this.emit("device added", d);
    return d;
  }

  addStation(serial: string): FakeStation {
    const s = new FakeStation(serial);
    this.stations.set(serial, s);
    if (this.connected) this.emit("station added", s);
    return s;
  }

  async connect(options?: LoginOptions): Promise<void> {
    this.calls.push(["connect", [options]]);
    await tick();
    switch (this.connectBehaviour) {
      case "tfa":
        if (options?.verifyCode) return this.finishConnect();
        this.emit("tfa request");
        return;
      case "captcha":
        if (options?.captcha) return this.finishConnect();
        this.emit("captcha request", "cap-1", "iVBORw0KGgo=");
        return;
      case "error":
        throw new Error("boom");
      case "hang":
        return;
      default:
        return this.finishConnect();
    }
  }

  private finishConnect(): void {
    this.connected = true;
    for (const s of this.stations.values()) this.emit("station added", s);
    for (const d of this.devices.values()) this.emit("device added", d);
    this.emit("connect");
    this.emit("push connect");
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.calls.push(["close", []]);
  }
  isConnected() {
    return this.connected;
  }
  isPushConnected() {
    return this.connected;
  }
  getVersion() {
    return "fake";
  }
  async getDevices() {
    return [...this.devices.values()];
  }
  async getStations() {
    return [...this.stations.values()];
  }
  async getDevice(serial: string) {
    const d = this.devices.get(serial);
    if (!d) throw Object.assign(new Error("Device doesn't exists"), { name: "DeviceNotFoundError" });
    return d;
  }
  async getStation(serial: string) {
    const s = this.stations.get(serial);
    if (!s) throw Object.assign(new Error("Station doesn't exists"), { name: "StationNotFoundError" });
    return s;
  }
  async setDeviceProperty(serial: string, name: string, value: unknown) {
    this.calls.push(["setDeviceProperty", [serial, name, value]]);
    const d = await this.getDevice(serial);
    (d.spec.properties ??= {})[name] = value;
    this.emit("device property changed", d, name, value);
  }
  async setStationProperty(serial: string, name: string, value: unknown) {
    this.calls.push(["setStationProperty", [serial, name, value]]);
  }
  async startStationLivestream(serial: string) {
    this.calls.push(["startStationLivestream", [serial]]);
    if (this.failStartLivestream) throw this.failStartLivestream;
    const device = await this.getDevice(serial);
    const station = await this.getStation(device.getStationSerial());
    const video = new PassThrough();
    const audio = new PassThrough();
    this.liveVideo.set(serial, video);
    this.liveAudio.set(serial, audio);
    setImmediate(() => this.emit("station livestream start", station, device, H264_META, video as Readable, audio as Readable));
  }
  async stopStationLivestream(serial: string) {
    this.calls.push(["stopStationLivestream", [serial]]);
    const device = await this.getDevice(serial);
    const station = await this.getStation(device.getStationSerial());
    this.liveVideo.delete(serial);
    this.liveAudio.delete(serial);
    setImmediate(() => this.emit("station livestream stop", station, device));
  }
  async startStationTalkback(serial: string) {
    this.calls.push(["startStationTalkback", [serial]]);
    if (this.failStartTalkback) throw this.failStartTalkback;
    const device = await this.getDevice(serial);
    const station = await this.getStation(device.getStationSerial());
    const stream = new FakeTalkbackStream();
    this.talkbackStreams.set(serial, stream);
    setImmediate(() => this.emit("station talkback start", station, device, stream));
  }
  async stopStationTalkback(serial: string) {
    this.calls.push(["stopStationTalkback", [serial]]);
    const device = await this.getDevice(serial);
    const station = await this.getStation(device.getStationSerial());
    this.talkbackStreams.delete(serial);
    setImmediate(() => this.emit("station talkback stop", station, device));
  }
  setCameraMaxLivestreamDuration(seconds: number) {
    this.maxLivestreamSeconds = seconds;
  }
}

export function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits until pred() is true (polling), or fails after timeout. */
export async function waitFor(pred: () => boolean, timeoutMs = 2000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}
