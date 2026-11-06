import { useState, type FormEvent } from "react";
import { StatusPill, type PillTone } from "./components/StatusPill";
import { StoreProvider, useStore, type View } from "./lib/store";
import { hideWindow, isTauri } from "./lib/tauri";
import { DevicesView } from "./views/Devices";
import { EventsView } from "./views/Events";
import { LiveView } from "./views/LiveView";
import { LoginView } from "./views/Login";
import { SettingsView } from "./views/Settings";
import "./App.css";

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const { state, bridgeStatus } = useStore();
  const auth = state.auth;
  const loggedIn = bridgeStatus === "connected" && state.synced && auth?.state === "connected";

  let body: React.ReactNode;
  if (bridgeStatus !== "connected" && state.view.name !== "settings") {
    body = <BridgeUnavailable />;
  } else if (!state.synced && state.view.name !== "settings") {
    body = (
      <div className="empty">
        <span className="spinner" aria-hidden="true" /> Syncing with the bridge…
      </div>
    );
  } else if (!loggedIn && state.view.name !== "settings") {
    body = <LoginView />;
  } else {
    body = <MainView view={state.view} />;
  }

  return (
    <div className="app">
      <Header />
      <div className="app-body">
        <Nav />
        <main className="content">{body}</main>
      </div>
    </div>
  );
}

function MainView({ view }: { view: View }) {
  switch (view.name) {
    case "devices":
      return <DevicesView />;
    case "events":
      return <EventsView />;
    case "settings":
      return <SettingsView />;
    case "live":
      return <LiveView key={view.serial} serial={view.serial} />;
  }
}

function Header() {
  const { state, bridgeStatus } = useStore();
  const auth = state.auth;

  const bridgeTone: PillTone =
    bridgeStatus === "connected" ? "ok" : bridgeStatus === "connecting" ? "warn" : "bad";
  const authTone: PillTone = !auth
    ? "muted"
    : auth.state === "connected"
      ? "ok"
      : auth.state === "error"
        ? "bad"
        : auth.state === "logged_out"
          ? "muted"
          : "warn";
  const authLabel = !auth ? "eufy: unknown" : `eufy: ${auth.state.replace("_", " ")}`;
  const pushTone: PillTone = auth?.pushConnected ? "ok" : "muted";

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-dot" aria-hidden="true" />
        Eufy Linux
      </div>
      <div className="pills">
        <StatusPill label={`bridge: ${bridgeStatus}`} tone={bridgeTone} title={state.bridgeInfo?.message} />
        <StatusPill label={authLabel} tone={authTone} title={auth?.error?.message} />
        <StatusPill label={auth?.pushConnected ? "push: on" : "push: off"} tone={pushTone} />
      </div>
      {isTauri() && (
        <button type="button" className="btn btn-small" onClick={() => void hideWindow()} title="Hide to tray">
          Hide to tray
        </button>
      )}
    </header>
  );
}

function Nav() {
  const { state, navigate } = useStore();
  const current = state.view.name === "live" ? "devices" : state.view.name;
  const items: Array<{ name: "devices" | "events" | "settings"; label: string; glyph: string }> = [
    { name: "devices", label: "Devices", glyph: "▣" },
    { name: "events", label: "Events", glyph: "☰" },
    { name: "settings", label: "Settings", glyph: "⚙" },
  ];
  const count = state.events.filter((e) => e.state).length;
  return (
    <nav className="sidebar" aria-label="Main">
      {items.map((it) => (
        <button
          key={it.name}
          type="button"
          className={`nav-item ${current === it.name ? "active" : ""}`}
          onClick={() => navigate({ name: it.name })}
          aria-current={current === it.name ? "page" : undefined}
        >
          <span className="nav-glyph" aria-hidden="true">
            {it.glyph}
          </span>
          <span className="nav-label">{it.label}</span>
          {it.name === "events" && count > 0 && <span className="badge">{count > 99 ? "99+" : count}</span>}
        </button>
      ))}
    </nav>
  );
}

function BridgeUnavailable() {
  const { state, bridge, bridgeStatus, refreshBridgeInfo, connectManually } = useStore();
  const info = state.bridgeInfo;
  const [url, setUrl] = useState(bridge.getEndpoint()?.url ?? "ws://127.0.0.1:8765/");
  const [token, setToken] = useState(bridge.getEndpoint()?.token ?? "");
  const lastError = bridge.lastError.get();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    connectManually(url.trim(), token.trim());
  };

  const headline =
    bridgeStatus === "connecting"
      ? "Connecting to the bridge…"
      : info?.status === "starting"
        ? "Starting the bridge…"
        : "Bridge unavailable";

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1 className="login-title">{headline}</h1>
        {(bridgeStatus === "connecting" || info?.status === "starting") && (
          <div className="progress-row" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>{info?.url ? `Waiting for ${info.url}` : "Waiting for the sidecar to report ready"}</span>
          </div>
        )}
        {info?.message && <div className="alert alert-warn">{info.message}</div>}
        {lastError && bridgeStatus !== "connected" && <div className="alert alert-error">{lastError}</div>}
        {isTauri() ? (
          <div className="row">
            <button type="button" className="btn" onClick={() => void refreshBridgeInfo()}>
              Retry
            </button>
            <button type="button" className="btn" onClick={() => bridge.reconnectNow()} disabled={!bridge.getEndpoint()}>
              Reconnect
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="form">
            <p className="muted">
              Running outside Tauri. Start the sidecar manually (<code>eufy-bridge --port 8765 --token …</code>) and
              enter its endpoint here.
            </p>
            <label>
              Bridge URL
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
            </label>
            <label>
              Token
              <input type="text" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" />
            </label>
            <button type="submit" className="btn btn-primary">
              Connect
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
