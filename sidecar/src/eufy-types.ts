/**
 * Minimal structural view of eufy-security-client used by the bridge.
 *
 * The bridge never imports the real library directly (see eufy-factory.ts);
 * it programs against these interfaces so tests can inject a fake emitter.
 */
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

export type EufyConfig = {
  username: string;
  password: string;
  country?: string;
  language?: string;
  trustedDeviceName?: string;
  persistentDir: string;
  p2pConnectionSetup: number;
  pollingIntervalMinutes: number;
  eventDurationSeconds: number;
  acceptInvitations?: boolean;
  logging?: { level?: number };
};

export type LoginOptions = {
  verifyCode?: string;
  captcha?: { captchaId: string; captchaCode: string };
  force: boolean;
};

export type EufyPicture = { data: Buffer; type: { mime: string; ext: string } };

export type EufyStreamMetadata = {
  videoCodec: number;
  videoFPS: number;
  videoWidth: number;
  videoHeight: number;
  audioCodec: number;
};

export type EufyVoice = { voice_id: number; desc: string };

export type PushMessage = {
  name?: string;
  type?: number;
  event_time?: number;
  station_sn?: string;
  device_sn?: string;
  title?: string;
  content?: string;
  person_name?: string;
  [key: string]: unknown;
};

export interface DeviceLike {
  getSerial(): string;
  getStationSerial(): string;
  getName(): string;
  getModel(): string;
  getDeviceType(): number;
  getChannel(): number;
  isDoorbell(): boolean;
  isCamera(): boolean;
  isLock(): boolean;
  isEntrySensor(): boolean;
  isMotionSensor(): boolean;
  isKeyPad?(): boolean;
  isSmartSafe?(): boolean;
  hasBattery(): boolean;
  hasCommand(name: string): boolean;
  hasProperty(name: string): boolean;
  getProperties(): Record<string, unknown>;
  getPropertyValue(name: string): unknown;
  /** Only present on doorbell cameras. */
  getVoices?(): Record<number, EufyVoice>;
}

export interface StationLike {
  getSerial(): string;
  getName(): string;
  getModel(): string;
  getGuardMode(): unknown;
  getCurrentMode(): unknown;
  isConnected(): boolean;
  getLANIPAddress(): unknown;
  getProperties(): Record<string, unknown>;
  setGuardMode(mode: number): void;
  quickResponse(device: DeviceLike, voiceId: number): void;
  isLiveStreaming(device: DeviceLike): boolean;
  isTalkbackOngoing(device: DeviceLike): boolean;
}

/** eufy-security-client's TalkbackStream is a Transform; we only write to it. */
export type TalkbackStreamLike = Writable;

export interface EufyLike extends EventEmitter {
  connect(options?: LoginOptions): Promise<void>;
  close(): void;
  isConnected(): boolean;
  isPushConnected(): boolean;
  getVersion(): string;
  getDevices(): Promise<DeviceLike[]>;
  getStations(): Promise<StationLike[]>;
  getDevice(serial: string): Promise<DeviceLike>;
  getStation(serial: string): Promise<StationLike>;
  setDeviceProperty(serial: string, name: string, value: unknown): Promise<void>;
  setStationProperty(serial: string, name: string, value: unknown): Promise<void>;
  startStationLivestream(serial: string): Promise<void>;
  stopStationLivestream(serial: string): Promise<void>;
  startStationTalkback(serial: string): Promise<void>;
  stopStationTalkback(serial: string): Promise<void>;
  setCameraMaxLivestreamDuration?(seconds: number): void;
}

export type EufyFactory = (config: EufyConfig) => Promise<EufyLike>;

// Event payload shapes we rely on (documented in eufy-security-client/build/interfaces.d.ts)
export type LivestreamStartArgs = [
  station: StationLike,
  device: DeviceLike,
  metadata: EufyStreamMetadata,
  videostream: Readable,
  audiostream: Readable,
];
