import type { DeviceEventKind, Picture } from "./types";

export function pictureToDataUrl(p: Picture | null | undefined): string | null {
  if (!p || !p.data) return null;
  return `data:${p.mime || "image/jpeg"};base64,${p.data}`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export const EVENT_LABELS: Record<DeviceEventKind, string> = {
  ring: "Ring",
  motion: "Motion",
  person: "Person",
  stranger: "Stranger",
  pet: "Pet",
  vehicle: "Vehicle",
  sound: "Sound",
  crying: "Crying",
  package_delivered: "Package delivered",
  package_taken: "Package taken",
  package_stranded: "Package stranded",
  loitering: "Loitering",
  radar_motion: "Radar motion",
  dog: "Dog",
  low_battery: "Low battery",
  other: "Event",
};

/** Simple text glyphs so we do not ship an icon font. */
export const EVENT_GLYPHS: Record<DeviceEventKind, string> = {
  ring: "🔔",
  motion: "〜",
  person: "👤",
  stranger: "❓",
  pet: "🐾",
  vehicle: "🚗",
  sound: "🔊",
  crying: "😢",
  package_delivered: "📦",
  package_taken: "📤",
  package_stranded: "📦",
  loitering: "⏱",
  radar_motion: "📡",
  dog: "🐕",
  low_battery: "🔋",
  other: "•",
};

export function batteryOf(props: Record<string, unknown>): number | null {
  const v = props.battery;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function isOnline(props: Record<string, unknown>): boolean | null {
  const v = props.enabled;
  if (typeof props.online === "boolean") return props.online;
  if (typeof v === "boolean") return v;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
