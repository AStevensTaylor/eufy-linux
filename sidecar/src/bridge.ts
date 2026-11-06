import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { CredentialStore, type Credentials } from "./credentials.ts";
import type {
  DeviceLike,
  EufyConfig,
  EufyFactory,
  EufyLike,
  EufyPicture,
  EufyStreamMetadata,
  PushMessage,
  StationLike,
} from "./eufy-types.ts";
import { frameEncoder } from "./frames.ts";
import type { Logger } from "./log.ts";
import {
  BridgeError,
  ErrorCode,
  FrameKind,
  PROTOCOL_VERSION,
  errorInfo,
  type AuthStatus,
  type Device,
  type DeviceEvent,
  type DeviceEventKind,
  type ErrorInfo,
  type Picture,
  type Station,
} from "./protocol.ts";
import { RingBuffer } from "./ring-buffer.ts";
import {
  PICTURE_PROPERTY,
  serializeDevice,
  serializeMetadata,
  serializeStation,
  toJsonSafe,
} from "./serialize.ts";
import { TalkbackTranscoder, findFfmpeg } from "./talkback.ts";

/** Transport-agnostic view of an authenticated client connection. */
export interface Client {
  readonly id: number;
  readonly kind: "ui" | "shell";
  sendEvent(event: string, data: unknown): void;
  sendBinary(frame: Buffer): void;
}

export type BridgeOptions = {
  dataDir: string;
  log: Logger;
  createEufy: EufyFactory;
  version: string;
  /** How long to hold a state=true event waiting for its thumbnail (ms). */
  pictureWaitMs?: number;
  /** A thumbnail younger than this is attached to a new event immediately (ms). */
  pictureRecentMs?: number;
  /** Resolves the ffmpeg executable; injected for tests. */
  findFfmpeg?: () => Promise<string | null>;
  /** eufy-security-client's own max livestream duration, 0 = unlimited. */
  maxLivestreamSeconds?: number;
};

type StoredPicture = Picture & { at: number };

type Livestream = {
  subscribers: Set<Client>;
  active: boolean;
  starting: boolean;
  metadata?: EufyStreamMetadata;
  detach?: () => void;
};

type Talkback = {
  owner: Client;
  transcoder: TalkbackTranscoder;
  stream?: Writable;
  started: boolean;
  warnedMissingFfmpeg: boolean;
};

const EVENT_BUFFER_SIZE = 200;
const DEFAULT_COUNTRY = "GB";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_TRUSTED_DEVICE = "eufy-linux";
const PUSH_MATCH_WINDOW_MS = 15_000;
const LATE_PICTURE_WINDOW_MS = 15_000;
const UPDATED_DEBOUNCE_MS = 400;

/** Event kinds for which eufy usually delivers a thumbnail. */
const PICTURE_KINDS = new Set<DeviceEventKind>([
  "ring",
  "motion",
  "person",
  "stranger",
  "pet",
  "vehicle",
  "sound",
  "crying",
  "package_delivered",
  "package_taken",
  "package_stranded",
  "loitering",
  "radar_motion",
  "dog",
]);

/** eufy-security-client event name -> DeviceEvent.kind */
const DETECTION_EVENTS: Array<[string, DeviceEventKind]> = [
  ["device rings", "ring"],
  ["device motion detected", "motion"],
  ["device person detected", "person"],
  ["device stranger person detected", "stranger"],
  ["device pet detected", "pet"],
  ["device vehicle detected", "vehicle"],
  ["device sound detected", "sound"],
  ["device crying detected", "crying"],
  ["device package delivered", "package_delivered"],
  ["device package taken", "package_taken"],
  ["device package stranded", "package_stranded"],
  ["device someone loitering", "loitering"],
  ["device radar motion detected", "radar_motion"],
  ["device dog detected", "dog"],
  ["device dog lick detected", "other"],
  ["device dog poop detected", "other"],
  ["device low battery", "low_battery"],
  ["device locked", "other"],
  ["device open", "other"],
  ["device tampering", "other"],
  ["device low temperature", "other"],
  ["device high temperature", "other"],
  ["device pin incorrect", "other"],
  ["device lid stuck", "other"],
  ["device battery fully charged", "other"],
  ["device jammed", "other"],
  ["device long time not close", "other"],
  ["device wrong try-protect alarm", "other"],
  ["device 911 alarm", "other"],
  ["device shake alarm", "other"],
];

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export class Bridge extends EventEmitter {
  readonly version: string;
  private readonly log: Logger;
  private readonly dataDir: string;
  private readonly credentials: CredentialStore;
  private readonly createEufy: EufyFactory;
  private readonly pictureWaitMs: number;
  private readonly pictureRecentMs: number;
  private readonly findFfmpegFn: () => Promise<string | null>;
  private readonly maxLivestreamSeconds: number;

  private eufy: EufyLike | null = null;
  private eufyDetach: (() => void) | null = null;
  private auth: AuthStatus = { state: "logged_out", username: null, pushConnected: false };
  private storedCredentials: Credentials | null = null;
  private loggingOut = false;

  private readonly clients = new Set<Client>();
  private readonly devices = new Map<string, DeviceLike>();
  private readonly stations = new Map<string, StationLike>();
  private readonly events = new RingBuffer<DeviceEvent>(EVENT_BUFFER_SIZE);
  private readonly pictures = new Map<string, StoredPicture>();
  private readonly lastPush = new Map<string, { title?: string; content?: string; personName?: string; at: number }>();
  private readonly pendingEvents = new Map<string, { event: DeviceEvent; timer: NodeJS.Timeout }>();
  private readonly updatedTimers = new Map<string, NodeJS.Timeout>();
  private readonly livestreams = new Map<string, Livestream>();
  private readonly talkbacks = new Map<string, Talkback>();
  private closed = false;

  constructor(opts: BridgeOptions) {
    super();
    this.version = opts.version;
    this.log = opts.log;
    this.dataDir = opts.dataDir;
    this.credentials = new CredentialStore(opts.dataDir);
    this.createEufy = opts.createEufy;
    this.pictureWaitMs = opts.pictureWaitMs ?? 2500;
    this.pictureRecentMs = opts.pictureRecentMs ?? 5000;
    this.findFfmpegFn = opts.findFfmpeg ?? (() => findFfmpeg());
    this.maxLivestreamSeconds = opts.maxLivestreamSeconds ?? 0;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      this.storedCredentials = await this.credentials.load();
    } catch (err) {
      this.log.warn("could not read stored credentials", err);
    }
    if (this.storedCredentials) {
      this.auth = { ...this.auth, username: this.storedCredentials.username };
      this.log.info(`stored credentials found for ${this.storedCredentials.username}; connecting`);
      this.connectWith(this.storedCredentials).catch((err) => {
        this.log.error("auto-connect failed", err);
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const serial of [...this.talkbacks.keys()]) this.endTalkback(serial, "shutdown");
    for (const [serial, ls] of this.livestreams) {
      ls.subscribers.clear();
      if ((ls.active || ls.starting) && this.eufy) {
        await this.eufy.stopStationLivestream(serial).catch(() => undefined);
      }
      ls.detach?.();
    }
    this.livestreams.clear();
    for (const p of this.pendingEvents.values()) clearTimeout(p.timer);
    this.pendingEvents.clear();
    for (const t of this.updatedTimers.values()) clearTimeout(t);
    this.updatedTimers.clear();
    this.detachEufy();
  }

  // ------------------------------------------------------------------ clients

  addClient(client: Client): void {
    this.clients.add(client);
  }

  removeClient(client: Client): void {
    this.clients.delete(client);
    for (const [serial, ls] of this.livestreams) {
      if (ls.subscribers.delete(client)) this.maybeStopLivestream(serial);
    }
    for (const [serial, tb] of this.talkbacks) {
      if (tb.owner === client) {
        this.log.info(`talkback ${serial}: owner disconnected, stopping`);
        this.stopTalkback(serial).catch((err) => this.log.warn(`talkback ${serial}: stop failed`, err));
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(event: string, data: unknown): void {
    for (const c of this.clients) {
      try {
        c.sendEvent(event, data);
      } catch (err) {
        this.log.debug(`client ${c.id}: send failed`, err);
      }
    }
  }

  // ----------------------------------------------------------------- commands

  /**
   * Executes a command for an authenticated client. Throws BridgeError (or any
   * error, mapped by the caller with errorInfo) on failure.
   */
  async handleCommand(client: Client, command: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    const p = params ?? {};
    switch (command) {
      case "auth.hello":
        return { version: this.version, protocol: PROTOCOL_VERSION };
      case "auth.status":
        return this.auth;
      case "auth.login":
        return this.login(p);
      case "auth.verify_code":
        return this.verifyCode(requireString(p, "code"));
      case "auth.captcha":
        return this.captcha(requireString(p, "id"), requireString(p, "code"));
      case "auth.logout":
        await this.logout();
        return {};
      case "state.get":
        return { auth: this.auth, stations: this.listStations(), devices: this.listDevices() };
      case "devices.list":
        return this.listDevices();
      case "device.get":
        return serializeDevice(this.requireDevice(requireString(p, "serial")));
      case "device.set_property": {
        const serial = requireString(p, "serial");
        const name = requireString(p, "name");
        if (!("value" in p)) throw new BridgeError(ErrorCode.InvalidParams, "missing param: value");
        this.requireDevice(serial);
        await this.requireEufy().setDeviceProperty(serial, name, p.value);
        return {};
      }
      case "device.picture":
        return { picture: await this.getPicture(requireString(p, "serial")) };
      case "device.quick_response": {
        const serial = requireString(p, "serial");
        const voiceId = requireNumber(p, "voiceId");
        const device = this.requireDevice(serial);
        if (!serializeDevice(device).capabilities.quickResponse) {
          throw new BridgeError(ErrorCode.Unsupported, "device does not support quick responses");
        }
        const station = await this.requireStationFor(device);
        station.quickResponse(device, voiceId);
        return {};
      }
      case "device.voices": {
        const device = this.requireDevice(requireString(p, "serial"));
        if (typeof device.getVoices !== "function") {
          throw new BridgeError(ErrorCode.Unsupported, "device has no quick response voices");
        }
        const voices = Object.values(device.getVoices() ?? {})
          .filter((v) => v && typeof v.voice_id === "number")
          .map((v) => ({ id: v.voice_id, name: v.desc ?? `Voice ${v.voice_id}` }));
        return { voices };
      }
      case "station.set_guard_mode": {
        const serial = requireString(p, "serial");
        const mode = requireNumber(p, "mode");
        const station = this.stations.get(serial);
        if (!station) throw new BridgeError(ErrorCode.StationNotFound, `unknown station ${serial}`);
        this.requireEufy();
        station.setGuardMode(mode);
        return {};
      }
      case "livestream.start":
        await this.startLivestream(client, requireString(p, "serial"));
        return {};
      case "livestream.stop":
        await this.unsubscribeLivestream(client, requireString(p, "serial"));
        return {};
      case "talkback.start":
        await this.startTalkback(client, requireString(p, "serial"), optionalString(p, "format"));
        return {};
      case "talkback.stop": {
        const serial = requireString(p, "serial");
        const tb = this.talkbacks.get(serial);
        if (tb && tb.owner !== client) {
          throw new BridgeError(ErrorCode.TalkbackBusy, "talkback is owned by another client");
        }
        if (tb) await this.stopTalkback(serial);
        return {};
      }
      case "events.recent": {
        const limit = p.limit === undefined ? undefined : requireNumber(p, "limit");
        return { events: this.events.recent(limit) };
      }
      case "bridge.ping":
        return { pong: true };
      default:
        throw new BridgeError(ErrorCode.UnknownCommand, `unknown command: ${command}`);
    }
  }

  /** Incoming binary frame (already decoded) from an authenticated client. */
  handleBinary(client: Client, kind: number, serial: string, payload: Uint8Array): void {
    if (kind !== FrameKind.TalkbackPcm && kind !== FrameKind.TalkbackAac) {
      this.log.debug(`client ${client.id}: ignoring binary frame kind 0x${kind.toString(16)}`);
      return;
    }
    const tb = this.talkbacks.get(serial);
    if (!tb || tb.owner !== client) return;
    if (kind === FrameKind.TalkbackAac) {
      tb.transcoder.writeAac(payload);
      return;
    }
    if (!tb.transcoder.ffmpegAvailable) {
      if (!tb.warnedMissingFfmpeg) {
        tb.warnedMissingFfmpeg = true;
        this.broadcast("talkback.error", {
          serial,
          code: ErrorCode.FfmpegMissing,
          message: "ffmpeg is not installed; cannot encode PCM talkback audio",
        });
      }
      return;
    }
    tb.transcoder.writePcm(payload);
  }

  // --------------------------------------------------------------------- auth

  get authStatus(): AuthStatus {
    return this.auth;
  }

  private setAuth(patch: Partial<AuthStatus>): void {
    const next: AuthStatus = { ...this.auth, ...patch };
    if (patch.state && patch.state !== "error" && !("error" in patch)) delete next.error;
    this.auth = next;
    this.broadcast("auth.status", this.auth);
    this.emit("auth", this.auth);
  }

  private async login(p: Record<string, unknown>): Promise<{ started: true }> {
    const creds: Credentials = {
      username: requireString(p, "username"),
      password: requireString(p, "password"),
      country: optionalString(p, "country") ?? DEFAULT_COUNTRY,
      language: optionalString(p, "language") ?? DEFAULT_LANGUAGE,
      trustedDeviceName: optionalString(p, "trustedDeviceName") ?? DEFAULT_TRUSTED_DEVICE,
    };
    await this.credentials.save(creds);
    this.storedCredentials = creds;
    this.connectWith(creds).catch((err) => this.log.error("login failed", err));
    return { started: true };
  }

  private async verifyCode(code: string): Promise<{ started: true }> {
    const eufy = this.requireEufy(false);
    this.setAuth({ state: "connecting" });
    eufy.connect({ verifyCode: code, force: false }).catch((err) => this.onConnectError(err));
    return { started: true };
  }

  private async captcha(id: string, code: string): Promise<{ started: true }> {
    const eufy = this.requireEufy(false);
    this.setAuth({ state: "connecting" });
    eufy.connect({ captcha: { captchaId: id, captchaCode: code }, force: false }).catch((err) =>
      this.onConnectError(err),
    );
    return { started: true };
  }

  private async logout(): Promise<void> {
    this.loggingOut = true;
    try {
      for (const serial of [...this.talkbacks.keys()]) this.endTalkback(serial, "logout");
      for (const [serial, ls] of this.livestreams) {
        if ((ls.active || ls.starting) && this.eufy) await this.eufy.stopStationLivestream(serial).catch(() => undefined);
        ls.detach?.();
        if (ls.active) this.broadcast("livestream.stopped", { serial });
      }
      this.livestreams.clear();
      this.detachEufy();
      await this.credentials.clear();
      this.storedCredentials = null;
      await fs.rm(path.join(this.dataDir, "persistent.json"), { force: true });
      await fs.rm(path.join(this.dataDir, "pictures"), { recursive: true, force: true });
      this.pictures.clear();
      for (const d of this.devices.values()) this.broadcast("device.removed", serializeDevice(d));
      for (const s of this.stations.values()) this.broadcast("station.removed", serializeStation(s));
      this.devices.clear();
      this.stations.clear();
      this.setAuth({ state: "logged_out", username: null, pushConnected: false });
    } finally {
      this.loggingOut = false;
    }
  }

  private requireEufy(mustBeConnected = true): EufyLike {
    if (!this.eufy) throw new BridgeError(ErrorCode.NotLoggedIn, "not logged in");
    if (mustBeConnected && this.auth.state !== "connected") {
      throw new BridgeError(ErrorCode.NotLoggedIn, `not connected (state: ${this.auth.state})`);
    }
    return this.eufy;
  }

  private buildConfig(creds: Credentials): EufyConfig {
    const levelMap = { debug: 1, info: 2, warn: 3, error: 4 } as const;
    return {
      username: creds.username,
      password: creds.password,
      country: creds.country ?? DEFAULT_COUNTRY,
      language: creds.language ?? DEFAULT_LANGUAGE,
      trustedDeviceName: creds.trustedDeviceName ?? DEFAULT_TRUSTED_DEVICE,
      persistentDir: this.dataDir,
      p2pConnectionSetup: 2, // QUICKEST
      pollingIntervalMinutes: 10,
      eventDurationSeconds: 10,
      acceptInvitations: true,
      logging: { level: levelMap[this.log.level] },
    };
  }

  private async connectWith(creds: Credentials): Promise<void> {
    this.detachEufy();
    this.setAuth({ state: "connecting", username: creds.username, pushConnected: false });
    let eufy: EufyLike;
    try {
      eufy = await this.createEufy(this.buildConfig(creds));
    } catch (err) {
      this.onConnectError(err);
      return;
    }
    if (this.closed) {
      eufy.close();
      return;
    }
    this.eufy = eufy;
    this.attachEufy(eufy);
    try {
      eufy.setCameraMaxLivestreamDuration?.(this.maxLivestreamSeconds);
    } catch (err) {
      this.log.debug("setCameraMaxLivestreamDuration failed", err);
    }
    try {
      await eufy.connect({ force: false });
    } catch (err) {
      this.onConnectError(err);
    }
  }

  private onConnectError(err: unknown): void {
    const info = errorInfo(err);
    this.log.error(`eufy connection error: ${info.message}`);
    this.setAuth({ state: "error", error: info });
    this.broadcast("auth.error", info);
  }

  private detachEufy(): void {
    const eufy = this.eufy;
    if (!eufy) return;
    this.eufyDetach?.();
    this.eufyDetach = null;
    this.eufy = null;
    try {
      eufy.close();
    } catch (err) {
      this.log.debug("eufy.close failed", err);
    }
  }

  // ------------------------------------------------------------- eufy events

  private attachEufy(eufy: EufyLike): void {
    const handlers: Array<[string, (...args: any[]) => void]> = [];
    const on = (event: string, fn: (...args: any[]) => void) => {
      const wrapped = (...args: unknown[]) => {
        try {
          const r = fn(...args) as unknown;
          if (r instanceof Promise) r.catch((err) => this.log.error(`handler for "${event}" failed`, err));
        } catch (err) {
          this.log.error(`handler for "${event}" failed`, err);
        }
      };
      handlers.push([event, wrapped]);
      eufy.on(event, wrapped);
    };

    on("connect", () => {
      this.log.info("eufy cloud connected");
      this.setAuth({ state: "connected", pushConnected: safeBool(() => eufy.isPushConnected()) });
      this.refreshInventory(eufy).catch((err) => this.log.warn("inventory refresh failed", err));
    });
    on("close", () => {
      if (this.loggingOut || this.closed || this.eufy !== eufy) return;
      this.log.warn("eufy cloud connection closed");
      this.setAuth({
        state: "error",
        pushConnected: false,
        error: { code: "connection_closed", message: "Connection to the Eufy cloud was closed" },
      });
    });
    on("connection error", (err: unknown) => this.onConnectError(err));
    on("tfa request", () => {
      this.log.info("eufy requests a 2FA code");
      this.setAuth({ state: "tfa_required" });
      this.broadcast("auth.tfa_required", {});
    });
    on("captcha request", (id: string, captcha: string) => {
      this.log.info("eufy requests a captcha");
      this.setAuth({ state: "captcha_required" });
      this.broadcast("auth.captcha_required", { id, image: toDataUrl(captcha) });
    });
    on("push connect", () => this.setAuth({ pushConnected: true }));
    on("push close", () => this.setAuth({ pushConnected: false }));
    on("push message", (msg: PushMessage) => this.onPushMessage(msg));

    on("station added", (s: StationLike) => {
      this.stations.set(s.getSerial(), s);
      this.broadcast("station.added", serializeStation(s));
    });
    on("station removed", (s: StationLike) => {
      this.stations.delete(s.getSerial());
      this.broadcast("station.removed", serializeStation(s));
    });
    on("device added", (d: DeviceLike) => {
      this.devices.set(d.getSerial(), d);
      this.broadcast("device.added", serializeDevice(d));
    });
    on("device removed", (d: DeviceLike) => {
      this.devices.delete(d.getSerial());
      this.broadcast("device.removed", serializeDevice(d));
    });
    on("station connect", (s: StationLike) => this.scheduleUpdated("station", s.getSerial()));
    on("station close", (s: StationLike) => this.scheduleUpdated("station", s.getSerial()));
    on("station property changed", (s: StationLike, name: string, value: unknown) => {
      if (!this.stations.has(s.getSerial())) this.stations.set(s.getSerial(), s);
      this.broadcast("station.property_changed", { serial: s.getSerial(), name, value: toJsonSafe(value) ?? null });
      this.scheduleUpdated("station", s.getSerial());
    });
    on("device property changed", (d: DeviceLike, name: string, value: unknown) => {
      if (!this.devices.has(d.getSerial())) this.devices.set(d.getSerial(), d);
      if (name === PICTURE_PROPERTY) {
        this.onPicture(d.getSerial(), value as EufyPicture);
        return;
      }
      this.broadcast("device.property_changed", { serial: d.getSerial(), name, value: toJsonSafe(value) ?? null });
      this.scheduleUpdated("device", d.getSerial());
    });

    for (const [eventName, kind] of DETECTION_EVENTS) {
      on(eventName, (d: DeviceLike, state: unknown, extra?: unknown) => {
        const personName = eventName === "device person detected" && typeof extra === "string" && extra ? extra : undefined;
        this.onDetection(d, kind, state === true, personName, eventName);
      });
    }

    on("station livestream start", (station: StationLike, device: DeviceLike, metadata: EufyStreamMetadata, video: Readable, audio: Readable) =>
      this.onLivestreamStart(device.getSerial(), metadata, video, audio),
    );
    on("station livestream stop", (_station: StationLike, device: DeviceLike) => this.onLivestreamStop(device.getSerial()));
    on("station talkback start", (_station: StationLike, device: DeviceLike, stream: Writable) =>
      this.onTalkbackStart(device.getSerial(), stream),
    );
    on("station talkback stop", (_station: StationLike, device: DeviceLike) => this.endTalkback(device.getSerial(), "eufy"));

    this.eufyDetach = () => {
      for (const [event, fn] of handlers) eufy.off(event, fn);
    };
  }

  private async refreshInventory(eufy: EufyLike): Promise<void> {
    const [stations, devices] = await Promise.all([eufy.getStations(), eufy.getDevices()]);
    for (const s of stations) {
      if (!this.stations.has(s.getSerial())) {
        this.stations.set(s.getSerial(), s);
        this.broadcast("station.added", serializeStation(s));
      }
    }
    for (const d of devices) {
      if (!this.devices.has(d.getSerial())) {
        this.devices.set(d.getSerial(), d);
        this.broadcast("device.added", serializeDevice(d));
      }
    }
  }

  private scheduleUpdated(kind: "device" | "station", serial: string): void {
    const key = `${kind}:${serial}`;
    const existing = this.updatedTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.updatedTimers.delete(key);
      if (kind === "device") {
        const d = this.devices.get(serial);
        if (d) this.broadcast("device.updated", serializeDevice(d));
      } else {
        const s = this.stations.get(serial);
        if (s) this.broadcast("station.updated", serializeStation(s));
      }
    }, UPDATED_DEBOUNCE_MS);
    timer.unref();
    this.updatedTimers.set(key, timer);
  }

  // --------------------------------------------------------- devices/stations

  listDevices(): Device[] {
    return [...this.devices.values()].map(serializeDevice);
  }

  listStations(): Station[] {
    return [...this.stations.values()].map(serializeStation);
  }

  private requireDevice(serial: string): DeviceLike {
    this.requireEufy();
    const d = this.devices.get(serial);
    if (!d) throw new BridgeError(ErrorCode.DeviceNotFound, `unknown device ${serial}`);
    return d;
  }

  private async requireStationFor(device: DeviceLike): Promise<StationLike> {
    const sn = device.getStationSerial();
    const cached = this.stations.get(sn);
    if (cached) return cached;
    try {
      return await this.requireEufy().getStation(sn);
    } catch (err) {
      throw new BridgeError(ErrorCode.StationNotFound, `station ${sn} not found: ${errorInfo(err).message}`);
    }
  }

  // ------------------------------------------------------------------ events

  private onPushMessage(msg: PushMessage): void {
    this.broadcast("push.message", toJsonSafe(msg) ?? null);
    const serial = typeof msg.device_sn === "string" ? msg.device_sn : undefined;
    if (!serial) return;
    this.lastPush.set(serial, {
      title: typeof msg.title === "string" ? msg.title : undefined,
      content: typeof msg.content === "string" ? msg.content : undefined,
      personName: typeof msg.person_name === "string" && msg.person_name ? msg.person_name : undefined,
      at: Date.now(),
    });
  }

  private onDetection(device: DeviceLike, kind: DeviceEventKind, state: boolean, personName: string | undefined, source: string): void {
    const serial = device.getSerial();
    if (!this.devices.has(serial)) this.devices.set(serial, device);
    const now = Date.now();
    const ev: DeviceEvent = {
      id: randomUUID(),
      serial,
      stationSerial: safeStr(() => device.getStationSerial()),
      deviceName: safeStr(() => device.getName()),
      kind,
      state,
      timestamp: now,
    };
    if (kind === "other") ev.title = source.replace(/^device /, "");
    const push = this.lastPush.get(serial);
    if (push && now - push.at <= PUSH_MATCH_WINDOW_MS) {
      if (push.title) ev.title = push.title;
      if (push.content) ev.content = push.content;
      if (!personName && push.personName) personName = push.personName;
    }
    if (personName) ev.personName = personName;

    if (!state || !PICTURE_KINDS.has(kind)) {
      this.emitDeviceEvent(ev);
      return;
    }
    const pic = this.pictures.get(serial);
    if (pic && now - pic.at <= this.pictureRecentMs) {
      ev.picture = { mime: pic.mime, data: pic.data };
      this.emitDeviceEvent(ev);
      return;
    }
    // Hold briefly: eufy fetches the thumbnail right after the push arrives.
    const pending = this.pendingEvents.get(serial);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingEvents.delete(serial);
      this.emitDeviceEvent(pending.event);
    }
    const timer = setTimeout(() => {
      this.pendingEvents.delete(serial);
      this.emitDeviceEvent(ev);
    }, this.pictureWaitMs);
    timer.unref();
    this.pendingEvents.set(serial, { event: ev, timer });
  }

  private emitDeviceEvent(ev: DeviceEvent): void {
    this.events.push(ev);
    this.log.info(`event ${ev.kind} ${ev.state ? "start" : "end"} on ${ev.deviceName || ev.serial}${ev.picture ? " (with picture)" : ""}`);
    this.broadcast("device.event", ev);
    this.emit("device.event", ev);
  }

  private onPicture(serial: string, value: EufyPicture | undefined): void {
    if (!value || !Buffer.isBuffer(value.data) || value.data.length === 0) return;
    const mime = value.type?.mime || "image/jpeg";
    const ext = value.type?.ext || "jpg";
    const stored: StoredPicture = { mime, data: value.data.toString("base64"), at: Date.now() };
    this.pictures.set(serial, stored);
    this.savePicture(serial, ext, value.data).catch((err) => this.log.debug(`saving picture for ${serial} failed`, err));

    const pending = this.pendingEvents.get(serial);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingEvents.delete(serial);
      pending.event.picture = { mime, data: stored.data };
      this.emitDeviceEvent(pending.event);
      return;
    }
    // Late picture: patch the most recent event for this device so events.recent has it.
    const recent = this.events.find((e) => e.serial === serial && e.state && !e.picture);
    if (recent && stored.at - recent.timestamp <= LATE_PICTURE_WINDOW_MS) {
      recent.picture = { mime, data: stored.data };
    }
  }

  private picturesDir(): string {
    return path.join(this.dataDir, "pictures");
  }

  private async savePicture(serial: string, ext: string, data: Buffer): Promise<void> {
    const dir = this.picturesDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
    // remove stale files with other extensions
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (f.startsWith(`${serial}.`) && f !== `${serial}.${safeExt}`) await fs.rm(path.join(dir, f), { force: true });
    }
    await fs.writeFile(path.join(dir, `${serial}.${safeExt}`), data, { mode: 0o600 });
  }

  async getPicture(serial: string): Promise<Picture | null> {
    this.requireDevice(serial);
    const mem = this.pictures.get(serial);
    if (mem) return { mime: mem.mime, data: mem.data };
    try {
      const files = await fs.readdir(this.picturesDir());
      const f = files.find((n) => n.startsWith(`${serial}.`));
      if (!f) return null;
      const ext = f.slice(serial.length + 1).toLowerCase();
      const data = await fs.readFile(path.join(this.picturesDir(), f));
      const pic: StoredPicture = { mime: MIME_BY_EXT[ext] ?? "application/octet-stream", data: data.toString("base64"), at: 0 };
      this.pictures.set(serial, pic);
      return { mime: pic.mime, data: pic.data };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- livestream

  private async startLivestream(client: Client, serial: string): Promise<void> {
    const device = this.requireDevice(serial);
    if (!serializeDevice(device).capabilities.livestream) {
      throw new BridgeError(ErrorCode.Unsupported, "device does not support livestream");
    }
    let ls = this.livestreams.get(serial);
    if (!ls) {
      ls = { subscribers: new Set(), active: false, starting: false };
      this.livestreams.set(serial, ls);
    }
    ls.subscribers.add(client);
    if (ls.active) {
      // Late joiner: give it the metadata it missed.
      if (ls.metadata) client.sendEvent("livestream.started", { serial, metadata: serializeMetadata(ls.metadata) });
      return;
    }
    if (ls.starting) return;
    ls.starting = true;
    this.log.info(`livestream ${serial}: starting (client ${client.id})`);
    try {
      await this.requireEufy().startStationLivestream(serial);
    } catch (err) {
      ls.starting = false;
      ls.subscribers.delete(client);
      const info = errorInfo(err);
      this.broadcast("livestream.error", { serial, ...info });
      throw new BridgeError(info.code, info.message);
    }
  }

  private async unsubscribeLivestream(client: Client, serial: string): Promise<void> {
    const ls = this.livestreams.get(serial);
    if (!ls) return;
    ls.subscribers.delete(client);
    await this.maybeStopLivestream(serial);
  }

  private async maybeStopLivestream(serial: string): Promise<void> {
    const ls = this.livestreams.get(serial);
    if (!ls || ls.subscribers.size > 0) return;
    if (!ls.active && !ls.starting) return;
    this.log.info(`livestream ${serial}: no subscribers left, stopping`);
    try {
      await this.eufy?.stopStationLivestream(serial);
    } catch (err) {
      this.log.warn(`livestream ${serial}: stop failed`, err);
    }
  }

  private onLivestreamStart(serial: string, metadata: EufyStreamMetadata, video: Readable, audio: Readable): void {
    let ls = this.livestreams.get(serial);
    if (!ls) {
      ls = { subscribers: new Set(), active: false, starting: false };
      this.livestreams.set(serial, ls);
    }
    ls.detach?.();
    ls.active = true;
    ls.starting = false;
    ls.metadata = metadata;
    const encodeVideo = frameEncoder(FrameKind.Video, serial);
    const encodeAudio = frameEncoder(FrameKind.Audio, serial);
    const fanout = (encode: (p: Uint8Array) => Buffer) => (chunk: Buffer) => {
      if (!ls.subscribers.size) return;
      const frame = encode(chunk);
      for (const c of ls.subscribers) {
        try {
          c.sendBinary(frame);
        } catch (err) {
          this.log.debug(`client ${c.id}: media send failed`, err);
        }
      }
    };
    const onVideo = fanout(encodeVideo);
    const onAudio = fanout(encodeAudio);
    const onError = (err: Error) => {
      this.log.warn(`livestream ${serial}: stream error`, err);
      this.broadcast("livestream.error", { serial, code: ErrorCode.EufyError, message: err.message });
    };
    video.on("data", onVideo);
    audio.on("data", onAudio);
    video.on("error", onError);
    audio.on("error", onError);
    ls.detach = () => {
      video.off("data", onVideo);
      audio.off("data", onAudio);
      video.off("error", onError);
      audio.off("error", onError);
      ls.detach = undefined;
    };
    const meta = serializeMetadata(metadata);
    this.log.info(`livestream ${serial}: started ${meta.videoCodec} ${meta.videoWidth}x${meta.videoHeight}@${meta.videoFPS} audio=${meta.audioCodec}`);
    this.broadcast("livestream.started", { serial, metadata: meta });
    if (ls.subscribers.size === 0) this.maybeStopLivestream(serial).catch(() => undefined);
  }

  private onLivestreamStop(serial: string): void {
    const ls = this.livestreams.get(serial);
    if (ls) {
      ls.detach?.();
      const wasActive = ls.active || ls.starting;
      ls.active = false;
      ls.starting = false;
      ls.metadata = undefined;
      if (!wasActive) return;
    }
    this.log.info(`livestream ${serial}: stopped`);
    // Talkback cannot outlive the livestream.
    if (this.talkbacks.has(serial)) this.endTalkback(serial, "livestream stopped");
    this.broadcast("livestream.stopped", { serial });
  }

  isLivestreamActive(serial: string): boolean {
    return this.livestreams.get(serial)?.active === true;
  }

  // ---------------------------------------------------------------- talkback

  private async startTalkback(client: Client, serial: string, format: string | undefined): Promise<void> {
    const device = this.requireDevice(serial);
    if (!serializeDevice(device).capabilities.talkback) {
      throw new BridgeError(ErrorCode.Unsupported, "device does not support talkback");
    }
    if (format !== undefined && format !== "pcm" && format !== "aac") {
      throw new BridgeError(ErrorCode.InvalidParams, "format must be \"pcm\" or \"aac\"");
    }
    const existing = this.talkbacks.get(serial);
    if (existing) {
      if (existing.owner !== client) throw new BridgeError(ErrorCode.TalkbackBusy, "talkback already in progress for this device");
      return;
    }
    const ls = this.livestreams.get(serial);
    if (!ls?.active) throw new BridgeError(ErrorCode.NotStreaming, "livestream must be running before talkback can start");
    const ffmpegPath = await this.findFfmpegFn();
    if (!ffmpegPath && format !== "aac") {
      throw new BridgeError(ErrorCode.FfmpegMissing, "ffmpeg is required to encode talkback audio (install ffmpeg or send AAC frames)");
    }
    const transcoder = new TalkbackTranscoder(serial, ffmpegPath, this.log, (err) => {
      if (!this.talkbacks.has(serial)) return;
      this.broadcast("talkback.error", { serial, code: "ffmpeg_error", message: err.message });
      this.stopTalkback(serial).catch(() => undefined);
    });
    const tb: Talkback = { owner: client, transcoder, started: false, warnedMissingFfmpeg: false };
    this.talkbacks.set(serial, tb);
    this.log.info(`talkback ${serial}: starting (client ${client.id}, format ${format ?? "pcm"})`);
    try {
      await this.requireEufy().startStationTalkback(serial);
    } catch (err) {
      this.talkbacks.delete(serial);
      transcoder.close();
      const info = errorInfo(err);
      this.broadcast("talkback.error", { serial, ...info });
      throw new BridgeError(info.code, info.message);
    }
  }

  private onTalkbackStart(serial: string, stream: Writable): void {
    const tb = this.talkbacks.get(serial);
    if (!tb) {
      this.log.warn(`talkback ${serial}: eufy reports talkback started but nobody owns it; stopping`);
      this.eufy?.stopStationTalkback(serial).catch(() => undefined);
      return;
    }
    tb.stream = stream;
    tb.started = true;
    tb.transcoder.attachSink(stream);
    this.log.info(`talkback ${serial}: started`);
    this.broadcast("talkback.started", { serial });
  }

  private async stopTalkback(serial: string): Promise<void> {
    const tb = this.talkbacks.get(serial);
    if (!tb) return;
    this.endTalkback(serial, "client");
    try {
      await this.eufy?.stopStationTalkback(serial);
    } catch (err) {
      this.log.debug(`talkback ${serial}: eufy stop failed`, err);
    }
  }

  /** Tears down local talkback state and notifies clients. Idempotent. */
  private endTalkback(serial: string, reason: string): void {
    const tb = this.talkbacks.get(serial);
    if (!tb) return;
    this.talkbacks.delete(serial);
    tb.transcoder.close();
    this.log.info(`talkback ${serial}: stopped (${reason})`);
    this.broadcast("talkback.stopped", { serial });
  }

  isTalkbackActive(serial: string): boolean {
    return this.talkbacks.has(serial);
  }
}

// ------------------------------------------------------------------ helpers

function requireString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) throw new BridgeError(ErrorCode.InvalidParams, `missing or invalid param: ${key}`);
  return v;
}

function optionalString(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new BridgeError(ErrorCode.InvalidParams, `invalid param: ${key}`);
  return v;
}

function requireNumber(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BridgeError(ErrorCode.InvalidParams, `missing or invalid param: ${key}`);
  return v;
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn() === true;
  } catch {
    return false;
  }
}

function safeStr(fn: () => string): string {
  try {
    return fn() ?? "";
  } catch {
    return "";
  }
}

/** eufy hands us either a bare base64 image or a complete data URL. */
export function toDataUrl(captcha: string): string {
  if (captcha.startsWith("data:")) return captcha;
  let mime = "image/png";
  try {
    const head = Buffer.from(captcha.slice(0, 16), "base64");
    if (head[0] === 0xff && head[1] === 0xd8) mime = "image/jpeg";
    else if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) mime = "image/gif";
    else if (head[0] === 0x89 && head[1] === 0x50) mime = "image/png";
  } catch {
    /* keep default */
  }
  return `data:${mime};base64,${captcha}`;
}

export type { ErrorInfo };
