/**
 * Application state: React context + useReducer, fed by the BridgeClient and
 * the Tauri shell. One BridgeClient instance lives for the whole app.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { BridgeClient, type BridgeStatus } from "./bridge";
import {
  getBridgeInfo,
  isTauri,
  onBridgeStatus,
  onOpenDevice,
  subscribeEvent,
  type BridgeInfo,
  type OpenDevicePayload,
} from "./tauri";
import type {
  AuthStatus,
  BridgeError,
  Device,
  DeviceEvent,
  Picture,
  Station,
} from "./types";
import { useObservable } from "./useObservable";

export type View =
  | { name: "devices" }
  | { name: "events" }
  | { name: "settings" }
  | { name: "live"; serial: string; reason?: OpenDevicePayload["reason"] };

export type LogLine = { ts: number; level: string; message: string };

export type AppState = {
  bridgeInfo: BridgeInfo | null;
  auth: AuthStatus | null;
  captcha: { id: string; image: string } | null;
  tfaRequired: boolean;
  authError: BridgeError | null;
  /** True once state.get completed on the current connection. */
  synced: boolean;
  devices: Record<string, Device>;
  stations: Record<string, Station>;
  pictures: Record<string, Picture>;
  events: DeviceEvent[];
  view: View;
  pendingOpenDevice: OpenDevicePayload | null;
  log: LogLine[];
};

export type Action =
  | { type: "bridge-info"; info: BridgeInfo }
  | { type: "bridge-disconnected" }
  | { type: "snapshot"; auth: AuthStatus; devices: Device[]; stations: Station[] }
  | { type: "auth-status"; auth: AuthStatus }
  | { type: "auth-tfa" }
  | { type: "auth-captcha"; id: string; image: string }
  | { type: "auth-error"; error: BridgeError }
  | { type: "auth-clear-flow" }
  | { type: "device-upsert"; device: Device }
  | { type: "device-remove"; serial: string }
  | { type: "device-property"; serial: string; name: string; value: unknown }
  | { type: "station-upsert"; station: Station }
  | { type: "station-remove"; serial: string }
  | { type: "station-property"; serial: string; name: string; value: unknown }
  | { type: "picture"; serial: string; picture: Picture }
  | { type: "events-recent"; events: DeviceEvent[] }
  | { type: "event"; event: DeviceEvent }
  | { type: "navigate"; view: View }
  | { type: "open-device"; payload: OpenDevicePayload }
  | { type: "open-device-consumed" }
  | { type: "log"; line: LogLine };

const MAX_EVENTS = 200;
const MAX_LOG = 100;

export const initialState: AppState = {
  bridgeInfo: null,
  auth: null,
  captcha: null,
  tfaRequired: false,
  authError: null,
  synced: false,
  devices: {},
  stations: {},
  pictures: {},
  events: [],
  view: { name: "devices" },
  pendingOpenDevice: null,
  log: [],
};

function byKey<T extends { serial: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const it of items) out[it.serial] = it;
  return out;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "bridge-info":
      return { ...state, bridgeInfo: action.info };
    case "bridge-disconnected":
      return { ...state, synced: false };
    case "snapshot":
      return {
        ...state,
        synced: true,
        auth: action.auth,
        devices: byKey(action.devices),
        stations: byKey(action.stations),
        captcha: action.auth.state === "captcha_required" ? state.captcha : null,
        tfaRequired: action.auth.state === "tfa_required",
        authError: action.auth.state === "error" ? (action.auth.error ?? state.authError) : null,
      };
    case "auth-status": {
      const a = action.auth;
      return {
        ...state,
        auth: a,
        tfaRequired: a.state === "tfa_required" ? true : a.state === "captcha_required" ? state.tfaRequired : false,
        captcha: a.state === "captcha_required" || a.state === "tfa_required" ? state.captcha : null,
        authError: a.state === "error" ? (a.error ?? state.authError) : a.state === "connecting" ? state.authError : null,
      };
    }
    case "auth-tfa":
      return { ...state, tfaRequired: true, authError: null };
    case "auth-captcha":
      return { ...state, captcha: { id: action.id, image: action.image }, authError: null };
    case "auth-error":
      return { ...state, authError: action.error };
    case "auth-clear-flow":
      return { ...state, captcha: null, tfaRequired: false, authError: null };
    case "device-upsert":
      return { ...state, devices: { ...state.devices, [action.device.serial]: action.device } };
    case "device-remove": {
      const devices = { ...state.devices };
      delete devices[action.serial];
      return { ...state, devices };
    }
    case "device-property": {
      const d = state.devices[action.serial];
      if (!d) return state;
      return {
        ...state,
        devices: {
          ...state.devices,
          [action.serial]: { ...d, properties: { ...d.properties, [action.name]: action.value } },
        },
      };
    }
    case "station-upsert":
      return { ...state, stations: { ...state.stations, [action.station.serial]: action.station } };
    case "station-remove": {
      const stations = { ...state.stations };
      delete stations[action.serial];
      return { ...state, stations };
    }
    case "station-property": {
      const s = state.stations[action.serial];
      if (!s) return state;
      return {
        ...state,
        stations: {
          ...state.stations,
          [action.serial]: { ...s, properties: { ...s.properties, [action.name]: action.value } },
        },
      };
    }
    case "picture":
      return { ...state, pictures: { ...state.pictures, [action.serial]: action.picture } };
    case "events-recent": {
      const seen = new Set(action.events.map((e) => e.id));
      const merged = [...action.events, ...state.events.filter((e) => !seen.has(e.id))]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_EVENTS);
      const pictures = { ...state.pictures };
      // Newest picture per serial wins; events are sorted newest-first.
      for (const e of [...merged].reverse()) if (e.picture) pictures[e.serial] = e.picture;
      return { ...state, events: merged, pictures };
    }
    case "event": {
      const e = action.event;
      const events = [e, ...state.events.filter((x) => x.id !== e.id)].slice(0, MAX_EVENTS);
      const pictures = e.picture ? { ...state.pictures, [e.serial]: e.picture } : state.pictures;
      return { ...state, events, pictures };
    }
    case "navigate":
      return { ...state, view: action.view };
    case "open-device":
      return { ...state, pendingOpenDevice: action.payload };
    case "open-device-consumed":
      return { ...state, pendingOpenDevice: null };
    case "log":
      return { ...state, log: [...state.log.slice(-(MAX_LOG - 1)), action.line] };
  }
}

// ---------------------------------------------------------------------------

export const bridge = new BridgeClient({
  log: import.meta.env.DEV ? (m) => console.debug("[bridge]", m) : undefined,
});

const DEV_ENDPOINT_KEY = "eufy-linux.dev.endpoint";

export function loadDevEndpoint(): { url: string; token: string } | null {
  try {
    const raw = localStorage.getItem(DEV_ENDPOINT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { url?: string; token?: string };
    if (typeof v.url === "string" && typeof v.token === "string") return { url: v.url, token: v.token };
  } catch {
    /* ignore */
  }
  return null;
}

export function saveDevEndpoint(ep: { url: string; token: string } | null): void {
  try {
    if (ep) localStorage.setItem(DEV_ENDPOINT_KEY, JSON.stringify(ep));
    else localStorage.removeItem(DEV_ENDPOINT_KEY);
  } catch {
    /* ignore */
  }
}

type StoreContextValue = {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  bridge: BridgeClient;
  bridgeStatus: BridgeStatus;
  navigate: (view: View) => void;
  refreshBridgeInfo: () => Promise<void>;
  /** Dev-only: connect to a manually entered bridge endpoint. */
  connectManually: (url: string, token: string) => void;
};

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const bridgeStatus = useObservable(bridge.status);
  const stateRef = useRef(state);
  stateRef.current = state;

  const applyBridgeInfo = useCallback((info: BridgeInfo) => {
    dispatch({ type: "bridge-info", info });
    if (info.status === "ready" && info.url && info.token) {
      bridge.connect({ url: info.url, token: info.token });
    } else if (info.status === "failed") {
      bridge.disconnect();
    }
  }, []);

  const refreshBridgeInfo = useCallback(async () => {
    try {
      applyBridgeInfo(await getBridgeInfo());
    } catch (err) {
      dispatch({
        type: "bridge-info",
        info: { status: "failed", url: null, token: null, message: String(err) },
      });
    }
  }, [applyBridgeInfo]);

  const connectManually = useCallback((url: string, token: string) => {
    saveDevEndpoint({ url, token });
    dispatch({ type: "bridge-info", info: { status: "ready", url, token } });
    bridge.connect({ url, token });
  }, []);

  // Mount: fetch bridge info (or the dev endpoint) and subscribe to shell events.
  useEffect(() => {
    if (isTauri()) {
      void refreshBridgeInfo();
    } else {
      const ep = loadDevEndpoint();
      if (ep) connectManually(ep.url, ep.token);
      else void refreshBridgeInfo();
    }
    const unBridge = subscribeEvent(onBridgeStatus, applyBridgeInfo);
    const unOpen = subscribeEvent(onOpenDevice, (payload) => {
      dispatch({ type: "open-device", payload });
    });
    return () => {
      unBridge();
      unOpen();
    };
  }, [applyBridgeInfo, refreshBridgeInfo, connectManually]);

  // Bridge events → reducer.
  useEffect(() => {
    const subs = [
      bridge.on("auth.status", (auth) => dispatch({ type: "auth-status", auth })),
      bridge.on("auth.tfa_required", () => dispatch({ type: "auth-tfa" })),
      bridge.on("auth.captcha_required", (d) => dispatch({ type: "auth-captcha", id: d.id, image: d.image })),
      bridge.on("auth.error", (error) => dispatch({ type: "auth-error", error })),
      bridge.on("device.added", (device) => dispatch({ type: "device-upsert", device })),
      bridge.on("device.updated", (device) => dispatch({ type: "device-upsert", device })),
      bridge.on("device.removed", (d) => dispatch({ type: "device-remove", serial: d.serial })),
      bridge.on("device.property_changed", (d) =>
        dispatch({ type: "device-property", serial: d.serial, name: d.name, value: d.value }),
      ),
      bridge.on("station.added", (station) => dispatch({ type: "station-upsert", station })),
      bridge.on("station.updated", (station) => dispatch({ type: "station-upsert", station })),
      bridge.on("station.removed", (s) => dispatch({ type: "station-remove", serial: s.serial })),
      bridge.on("station.property_changed", (d) =>
        dispatch({ type: "station-property", serial: d.serial, name: d.name, value: d.value }),
      ),
      bridge.on("device.event", (event) => dispatch({ type: "event", event })),
      bridge.on("bridge.log", (d) =>
        dispatch({ type: "log", line: { ts: Date.now(), level: d.level, message: d.message } }),
      ),
    ];
    return () => subs.forEach((u) => u());
  }, []);

  // On (re)connect: full snapshot + recent events + pictures.
  useEffect(() => {
    if (bridgeStatus !== "connected") {
      dispatch({ type: "bridge-disconnected" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const snap = await bridge.call("state.get");
        if (cancelled) return;
        dispatch({ type: "snapshot", auth: snap.auth, devices: snap.devices, stations: snap.stations });
        const recent = await bridge.call("events.recent", { limit: MAX_EVENTS });
        if (cancelled) return;
        dispatch({ type: "events-recent", events: recent.events });
        for (const d of snap.devices) {
          if (!d.isCamera && !d.isDoorbell) continue;
          bridge
            .call("device.picture", { serial: d.serial })
            .then((r) => {
              if (!cancelled && r.picture) dispatch({ type: "picture", serial: d.serial, picture: r.picture });
            })
            .catch(() => {});
        }
      } catch (err) {
        console.warn("initial sync failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeStatus]);

  // open-device: consume once the device list is known.
  useEffect(() => {
    const p = state.pendingOpenDevice;
    if (!p) return;
    if (!state.synced) return; // wait for the bridge; stays queued
    dispatch({ type: "open-device-consumed" });
    dispatch({ type: "navigate", view: { name: "live", serial: p.serial, reason: p.reason } });
  }, [state.pendingOpenDevice, state.synced]);

  const navigate = useCallback((view: View) => dispatch({ type: "navigate", view }), []);

  const value = useMemo<StoreContextValue>(
    () => ({ state, dispatch, bridge, bridgeStatus, navigate, refreshBridgeInfo, connectManually }),
    [state, bridgeStatus, navigate, refreshBridgeInfo, connectManually],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}

/** Devices sorted: doorbells first, then cameras, then the rest, by name. */
export function sortedDevices(devices: Record<string, Device>): Device[] {
  const rank = (d: Device) => (d.isDoorbell ? 0 : d.isCamera ? 1 : 2);
  return Object.values(devices).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
