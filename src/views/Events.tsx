import { Thumbnail } from "../components/Thumbnail";
import { EVENT_GLYPHS, EVENT_LABELS, formatTime } from "../lib/format";
import { useStore } from "../lib/store";

export function EventsView() {
  const { state, navigate } = useStore();
  const events = state.events.filter((e) => e.state);

  return (
    <div className="view">
      <h2 className="view-title">Events</h2>
      {events.length === 0 ? (
        <div className="empty">
          <p>No events yet.</p>
          <p className="muted">Rings, motion and person detections will show up here as they happen.</p>
        </div>
      ) : (
        <ul className="event-list">
          {events.map((e) => {
            const device = state.devices[e.serial];
            const canOpen = device?.capabilities.livestream ?? true;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className="event-row"
                  onClick={() => navigate({ name: "live", serial: e.serial })}
                  disabled={!canOpen}
                  title={canOpen ? "Open live view" : undefined}
                >
                  <span className="event-glyph" aria-hidden="true">
                    {EVENT_GLYPHS[e.kind] ?? "•"}
                  </span>
                  <div className="event-text">
                    <div className="event-title">
                      <strong>{EVENT_LABELS[e.kind] ?? e.kind}</strong>
                      {e.personName && <span className="tag">{e.personName}</span>}
                      <span className="muted">{device?.name ?? e.deviceName}</span>
                    </div>
                    <div className="muted small">
                      {formatTime(e.timestamp)}
                      {e.title && ` · ${e.title}`}
                      {e.content && ` – ${e.content}`}
                    </div>
                  </div>
                  <Thumbnail picture={e.picture} alt="" className="event-thumb" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
