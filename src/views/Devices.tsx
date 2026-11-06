import { DeviceCard } from "../components/DeviceCard";
import { sortedDevices, useStore } from "../lib/store";

export function DevicesView() {
  const { state, navigate } = useStore();
  const devices = sortedDevices(state.devices);

  if (!state.synced) {
    return (
      <div className="empty">
        <span className="spinner" aria-hidden="true" /> Loading devices…
      </div>
    );
  }
  if (devices.length === 0) {
    return (
      <div className="empty">
        <p>No devices found on this account yet.</p>
        <p className="muted">Devices appear here once the bridge finishes syncing with Eufy.</p>
      </div>
    );
  }

  const stations = Object.values(state.stations);

  return (
    <div className="view">
      <h2 className="view-title">Devices</h2>
      <div className="device-grid">
        {devices.map((d) => (
          <DeviceCard
            key={d.serial}
            device={d}
            picture={state.pictures[d.serial]}
            onOpen={(serial) => navigate({ name: "live", serial })}
          />
        ))}
      </div>
      {stations.length > 0 && (
        <details className="stations">
          <summary>Stations ({stations.length})</summary>
          <ul>
            {stations.map((s) => (
              <li key={s.serial}>
                <strong>{s.name}</strong> <span className="muted">{s.model}</span>{" "}
                <span className="muted mono">{s.serial}</span>{" "}
                <span className={s.connected ? "ok-text" : "muted"}>{s.connected ? "P2P connected" : "P2P idle"}</span>
                {s.lanIp && <span className="muted"> · {s.lanIp}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
