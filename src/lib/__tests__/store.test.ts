import { describe, expect, it } from "vitest";
import { initialState, reducer, sortedDevices } from "../store";
import type { Device, DeviceEvent } from "../types";

const dev = (serial: string, extra: Partial<Device> = {}): Device => ({
  serial,
  stationSerial: "ST",
  name: serial,
  model: "T8210",
  type: 7,
  kind: "camera",
  channel: 0,
  isDoorbell: false,
  isCamera: true,
  hasBattery: true,
  capabilities: { livestream: true, talkback: true, quickResponse: false, snapshot: true },
  properties: { battery: 80 },
  ...extra,
});

const evt = (id: string, ts: number, extra: Partial<DeviceEvent> = {}): DeviceEvent => ({
  id,
  serial: "A",
  stationSerial: "ST",
  deviceName: "A",
  kind: "motion",
  state: true,
  timestamp: ts,
  ...extra,
});

describe("app reducer", () => {
  it("applies device property changes", () => {
    let s = reducer(initialState, { type: "device-upsert", device: dev("A") });
    s = reducer(s, { type: "device-property", serial: "A", name: "battery", value: 42 });
    expect(s.devices.A.properties.battery).toBe(42);
    expect(reducer(s, { type: "device-property", serial: "Z", name: "x", value: 1 })).toBe(s);
    s = reducer(s, { type: "device-remove", serial: "A" });
    expect(s.devices.A).toBeUndefined();
  });

  it("merges recent events newest-first, dedupes and tracks the latest picture", () => {
    let s = reducer(initialState, { type: "event", event: evt("e3", 300) });
    s = reducer(s, {
      type: "events-recent",
      events: [evt("e1", 100, { picture: { mime: "image/jpeg", data: "old" } }), evt("e2", 200, { picture: { mime: "image/jpeg", data: "new" } }), evt("e3", 300)],
    });
    expect(s.events.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(s.pictures.A.data).toBe("new");
    s = reducer(s, { type: "event", event: evt("e4", 400, { picture: { mime: "image/png", data: "newest" } }) });
    expect(s.events[0].id).toBe("e4");
    expect(s.pictures.A.data).toBe("newest");
  });

  it("queues open-device until consumed", () => {
    let s = reducer(initialState, { type: "open-device", payload: { serial: "A", reason: "ring" } });
    expect(s.pendingOpenDevice?.serial).toBe("A");
    s = reducer(s, { type: "open-device-consumed" });
    expect(s.pendingOpenDevice).toBeNull();
  });

  it("tracks the auth flow", () => {
    let s = reducer(initialState, { type: "auth-captcha", id: "c1", image: "data:image/png;base64,x" });
    expect(s.captcha?.id).toBe("c1");
    s = reducer(s, { type: "auth-status", auth: { state: "tfa_required", username: "u", pushConnected: false } });
    expect(s.tfaRequired).toBe(true);
    s = reducer(s, { type: "auth-status", auth: { state: "connected", username: "u", pushConnected: true } });
    expect(s.tfaRequired).toBe(false);
    expect(s.captcha).toBeNull();
    s = reducer(s, { type: "auth-status", auth: { state: "error", username: "u", pushConnected: false, error: { code: "x", message: "boom" } } });
    expect(s.authError?.message).toBe("boom");
  });

  it("sorts doorbells first", () => {
    const list = sortedDevices({
      cam: dev("cam", { name: "Cam" }),
      bell: dev("bell", { name: "Bell", isDoorbell: true, kind: "doorbell" }),
      sensor: dev("sensor", { name: "Aaa", isCamera: false, kind: "sensor" }),
    });
    expect(list.map((d) => d.serial)).toEqual(["bell", "cam", "sensor"]);
  });
});
