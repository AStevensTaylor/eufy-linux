import { useEffect, useReducer, useState } from "react";
import { StatusPill } from "../components/StatusPill";
import { settingsEqual, settingsReducer } from "../lib/settings";
import { useStore } from "../lib/store";
import { useObservable } from "../lib/useObservable";
import {
  DEFAULT_SETTINGS,
  getSettings,
  isTauri,
  quitApp,
  restartBridge,
  setSettings,
  testNotification,
  type Settings,
} from "../lib/tauri";

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="muted small"> – {hint}</span>}
      </span>
    </label>
  );
}

export function SettingsView() {
  const { state, bridge, bridgeStatus, refreshBridgeInfo } = useStore();
  const [saved, setSaved] = useState<Settings>(DEFAULT_SETTINGS);
  const [draft, dispatch] = useReducer(settingsReducer, DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bridgeVersion = useObservable(bridge.bridgeVersion);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (cancelled) return;
        setSaved(s);
        dispatch({ type: "replace", settings: s });
        setLoaded(true);
      })
      .catch((err: unknown) => setMessage(`Could not load settings: ${String(err)}`));
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = !settingsEqual(draft, saved);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await setSettings(draft);
      setSaved(draft);
      setMessage("Settings saved.");
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (!window.confirm("Sign out of Eufy? Stored credentials will be removed from this computer.")) return;
    setBusy(true);
    try {
      await bridge.call("auth.logout");
    } catch (err) {
      setMessage(`Logout failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const n = draft.notifications;
  const notifOff = !n.enabled;
  const bridgeInfo = state.bridgeInfo;

  return (
    <div className="view settings">
      <h2 className="view-title">Settings</h2>

      <section className="panel">
        <header className="panel-header">
          <h3>Notifications</h3>
        </header>
        <Toggle label="Enable desktop notifications" checked={n.enabled} onChange={(v) => dispatch({ type: "notification", key: "enabled", value: v })} disabled={!loaded} />
        <div className="indent">
          <Toggle label="Doorbell rings" checked={n.ring} disabled={!loaded || notifOff} onChange={(v) => dispatch({ type: "notification", key: "ring", value: v })} />
          <Toggle label="Motion" checked={n.motion} disabled={!loaded || notifOff} onChange={(v) => dispatch({ type: "notification", key: "motion", value: v })} />
          <Toggle label="Person detected" checked={n.person} disabled={!loaded || notifOff} onChange={(v) => dispatch({ type: "notification", key: "person", value: v })} />
          <Toggle label="Other events" checked={n.other} disabled={!loaded || notifOff} hint="packages, pets, sounds…" onChange={(v) => dispatch({ type: "notification", key: "other", value: v })} />
          <Toggle label="Include the event image" checked={n.withImage} disabled={!loaded || notifOff} onChange={(v) => dispatch({ type: "notification", key: "withImage", value: v })} />
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={() => void testNotification()} disabled={!isTauri()}>
            Test notification
          </button>
          {!isTauri() && <span className="muted small">Only available inside the desktop app.</span>}
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>Pop up the window</h3>
        </header>
        <Toggle label="When the doorbell rings" checked={draft.popup.onRing} disabled={!loaded} onChange={(v) => dispatch({ type: "popup", key: "onRing", value: v })} />
        <Toggle label="On motion" checked={draft.popup.onMotion} disabled={!loaded} onChange={(v) => dispatch({ type: "popup", key: "onMotion", value: v })} />
        <Toggle label="When a person is detected" checked={draft.popup.onPerson} disabled={!loaded} onChange={(v) => dispatch({ type: "popup", key: "onPerson", value: v })} />
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>Desktop</h3>
        </header>
        <Toggle label="Start with the desktop session" checked={draft.autostart} disabled={!loaded} onChange={(v) => dispatch({ type: "flag", key: "autostart", value: v })} />
        <Toggle label="Start minimised to the tray" checked={draft.startMinimized} disabled={!loaded} onChange={(v) => dispatch({ type: "flag", key: "startMinimized", value: v })} />
        <Toggle label="Close button hides to the tray" checked={draft.closeToTray} disabled={!loaded} hint="use Quit in the tray menu to exit" onChange={(v) => dispatch({ type: "flag", key: "closeToTray", value: v })} />
      </section>

      <div className="row sticky-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || busy || !loaded}>
          {busy ? "Saving…" : "Save settings"}
        </button>
        <button type="button" className="btn" onClick={() => dispatch({ type: "replace", settings: saved })} disabled={!dirty || busy}>
          Discard
        </button>
        {message && <span className="muted small">{message}</span>}
      </div>

      <section className="panel">
        <header className="panel-header">
          <h3>Bridge</h3>
          <StatusPill
            label={bridgeStatus}
            tone={bridgeStatus === "connected" ? "ok" : bridgeStatus === "connecting" ? "warn" : "bad"}
          />
        </header>
        <dl className="kv">
          <dt>Sidecar</dt>
          <dd>
            {bridgeInfo?.status ?? "unknown"}
            {bridgeInfo?.message && <span className="muted"> – {bridgeInfo.message}</span>}
          </dd>
          <dt>URL</dt>
          <dd className="mono">{bridgeInfo?.url ?? "–"}</dd>
          <dt>Version</dt>
          <dd>{bridgeVersion ?? "–"}</dd>
          <dt>Account</dt>
          <dd>
            {state.auth?.username ?? "–"} <span className="muted">({state.auth?.state ?? "unknown"})</span>
          </dd>
          <dt>Push</dt>
          <dd>{state.auth?.pushConnected ? "connected" : "not connected"}</dd>
        </dl>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void restartBridge().then(() => refreshBridgeInfo());
            }}
            disabled={!isTauri()}
          >
            Restart bridge
          </button>
          <button type="button" className="btn" onClick={() => bridge.reconnectNow()} disabled={!bridge.getEndpoint()}>
            Reconnect websocket
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void logout()} disabled={busy || bridgeStatus !== "connected"}>
            Sign out of Eufy
          </button>
          {isTauri() && (
            <button type="button" className="btn" onClick={() => void quitApp()}>
              Quit app
            </button>
          )}
        </div>
        {state.log.length > 0 && (
          <details className="log">
            <summary>Bridge log ({state.log.length})</summary>
            <pre>
              {state.log.map((l) => `${new Date(l.ts).toLocaleTimeString()} [${l.level}] ${l.message}`).join("\n")}
            </pre>
          </details>
        )}
      </section>
    </div>
  );
}
