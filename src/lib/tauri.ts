/**
 * Thin wrappers around the Tauri commands/events from docs/ARCHITECTURE.md.
 *
 * Every wrapper degrades gracefully when the page is not running inside Tauri
 * (plain `pnpm dev` in a browser): commands return sensible fallbacks and
 * listeners become no-ops, so the UI can still be developed with a manual
 * bridge URL/token form.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type BridgeInfo = {
  status: "starting" | "ready" | "failed";
  url: string | null;
  token: string | null;
  message?: string;
};

export type OpenDeviceReason = "ring" | "motion" | "person" | "notification" | "tray";
export type OpenDevicePayload = { serial: string; reason: OpenDeviceReason };

export type Settings = {
  notifications: {
    enabled: boolean;
    ring: boolean;
    motion: boolean;
    person: boolean;
    other: boolean;
    withImage: boolean;
  };
  popup: {
    onRing: boolean;
    onMotion: boolean;
    onPerson: boolean;
  };
  autostart: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  notifications: { enabled: true, ring: true, motion: true, person: true, other: true, withImage: true },
  popup: { onRing: true, onMotion: false, onPerson: false },
  autostart: false,
  startMinimized: true,
  closeToTray: true,
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

const FALLBACK_SETTINGS_KEY = "eufy-linux.dev.settings";

function readFallbackSettings(): Settings {
  try {
    const raw = localStorage.getItem(FALLBACK_SETTINGS_KEY);
    if (raw) return mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw) as Partial<Settings>);
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

/** Deep-merge a (possibly partial / older) settings object onto defaults. */
export function mergeSettings(base: Settings, patch: Partial<Settings> | null | undefined): Settings {
  if (!patch || typeof patch !== "object") return base;
  return {
    notifications: { ...base.notifications, ...(patch.notifications ?? {}) },
    popup: { ...base.popup, ...(patch.popup ?? {}) },
    autostart: patch.autostart ?? base.autostart,
    startMinimized: patch.startMinimized ?? base.startMinimized,
    closeToTray: patch.closeToTray ?? base.closeToTray,
  };
}

export async function getBridgeInfo(): Promise<BridgeInfo> {
  if (!isTauri()) {
    return {
      status: "failed",
      url: null,
      token: null,
      message: "Not running inside Tauri; enter the bridge URL and token manually.",
    };
  }
  return invoke<BridgeInfo>("get_bridge_info");
}

export async function restartBridge(): Promise<void> {
  if (!isTauri()) return;
  await invoke("restart_bridge");
}

export async function hideWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke("hide_window");
}

export async function quitApp(): Promise<void> {
  if (!isTauri()) return;
  await invoke("quit_app");
}

export async function getSettings(): Promise<Settings> {
  if (!isTauri()) return readFallbackSettings();
  const s = await invoke<Partial<Settings>>("get_settings");
  return mergeSettings(DEFAULT_SETTINGS, s);
}

export async function setSettings(settings: Settings): Promise<void> {
  if (!isTauri()) {
    try {
      localStorage.setItem(FALLBACK_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    return;
  }
  await invoke("set_settings", { settings });
}

export async function testNotification(): Promise<void> {
  if (!isTauri()) {
    console.info("[dev] test_notification (no-op outside Tauri)");
    return;
  }
  await invoke("test_notification");
}

type Listener<T> = (payload: T) => void;

async function listenSafe<T>(event: string, handler: Listener<T>): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<T>(event, (ev) => handler(ev.payload));
}

export function onBridgeStatus(handler: Listener<BridgeInfo>): Promise<UnlistenFn> {
  return listenSafe<BridgeInfo>("bridge-status", handler);
}

export function onOpenDevice(handler: Listener<OpenDevicePayload>): Promise<UnlistenFn> {
  return listenSafe<OpenDevicePayload>("open-device", handler);
}

export function onWindowShown(handler: Listener<Record<string, never>>): Promise<UnlistenFn> {
  return listenSafe<Record<string, never>>("window-shown", handler);
}

/**
 * Helper for React effects: subscribes asynchronously and returns a cleanup
 * that unsubscribes once the subscription resolves (even if it resolves after
 * cleanup was requested).
 */
export function subscribeEvent<T>(
  subscribe: (handler: Listener<T>) => Promise<UnlistenFn>,
  handler: Listener<T>,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void subscribe(handler)
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch((err: unknown) => console.warn("tauri listen failed", err));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
