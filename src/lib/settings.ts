/** Pure reducer for the Settings form (tested in isolation). */
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "./tauri";

export type SettingsAction =
  | { type: "replace"; settings: Settings | Partial<Settings> | null }
  | { type: "notification"; key: keyof Settings["notifications"]; value: boolean }
  | { type: "popup"; key: keyof Settings["popup"]; value: boolean }
  | { type: "flag"; key: "autostart" | "startMinimized" | "closeToTray"; value: boolean }
  | { type: "reset" };

export function settingsReducer(state: Settings, action: SettingsAction): Settings {
  switch (action.type) {
    case "replace":
      return mergeSettings(DEFAULT_SETTINGS, action.settings);
    case "notification":
      if (state.notifications[action.key] === action.value) return state;
      return { ...state, notifications: { ...state.notifications, [action.key]: action.value } };
    case "popup":
      if (state.popup[action.key] === action.value) return state;
      return { ...state, popup: { ...state.popup, [action.key]: action.value } };
    case "flag":
      if (state[action.key] === action.value) return state;
      return { ...state, [action.key]: action.value };
    case "reset":
      return DEFAULT_SETTINGS;
  }
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
