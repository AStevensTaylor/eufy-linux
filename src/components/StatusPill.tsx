export type PillTone = "ok" | "warn" | "bad" | "muted";

export function StatusPill({ label, tone, title }: { label: string; tone: PillTone; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span className="pill-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
