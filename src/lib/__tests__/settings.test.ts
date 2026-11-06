import { describe, expect, it } from "vitest";
import { settingsEqual, settingsReducer } from "../settings";
import { DEFAULT_SETTINGS, mergeSettings } from "../tauri";

describe("settings reducer", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      notifications: { enabled: true, ring: true, motion: true, person: true, other: true, withImage: true },
      popup: { onRing: true, onMotion: false, onPerson: false },
      autostart: false,
      startMinimized: true,
      closeToTray: true,
    });
  });

  it("updates nested keys immutably", () => {
    const next = settingsReducer(DEFAULT_SETTINGS, { type: "notification", key: "ring", value: false });
    expect(next).not.toBe(DEFAULT_SETTINGS);
    expect(next.notifications.ring).toBe(false);
    expect(DEFAULT_SETTINGS.notifications.ring).toBe(true);
    const popup = settingsReducer(next, { type: "popup", key: "onMotion", value: true });
    expect(popup.popup.onMotion).toBe(true);
    const flag = settingsReducer(popup, { type: "flag", key: "autostart", value: true });
    expect(flag.autostart).toBe(true);
  });

  it("returns the same object for no-op updates", () => {
    expect(settingsReducer(DEFAULT_SETTINGS, { type: "flag", key: "closeToTray", value: true })).toBe(DEFAULT_SETTINGS);
  });

  it("merges partial/older settings onto defaults", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { notifications: { ring: false } as never, autostart: true });
    expect(merged.notifications).toEqual({ ...DEFAULT_SETTINGS.notifications, ring: false });
    expect(merged.autostart).toBe(true);
    expect(merged.popup).toEqual(DEFAULT_SETTINGS.popup);
    expect(settingsReducer(DEFAULT_SETTINGS, { type: "replace", settings: null })).toEqual(DEFAULT_SETTINGS);
  });

  it("compares structurally", () => {
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, autostart: true })).toBe(false);
  });
});
