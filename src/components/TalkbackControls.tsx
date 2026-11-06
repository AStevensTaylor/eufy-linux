import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { TalkbackSession, talkbackSupported } from "../lib/talkback";
import type { Device, Voice } from "../lib/types";
import { useObservable } from "../lib/useObservable";
import { formatBytes } from "../lib/format";

export function TalkbackControls({ device, streaming }: { device: Device; streaming: boolean }) {
  const { bridge, bridgeStatus } = useStore();
  const session = useMemo(() => new TalkbackSession(bridge, device.serial), [bridge, device.serial]);
  const info = useObservable(session.info);
  const [pushToTalk, setPushToTalk] = useState(false);
  const holdRef = useRef(false);

  useEffect(() => {
    return () => {
      void session.dispose();
    };
  }, [session]);

  const supported = talkbackSupported();
  const active = info.state === "active" || info.state === "starting";

  const toggle = () => {
    if (active) void session.stop();
    else void session.start();
  };

  const onHoldStart = () => {
    holdRef.current = true;
    void session.start();
  };
  const onHoldEnd = () => {
    if (!holdRef.current) return;
    holdRef.current = false;
    void session.stop();
  };

  const stateLabel: Record<typeof info.state, string> = {
    idle: "Idle",
    starting: "Starting…",
    active: "Live – you are being heard",
    stopping: "Stopping…",
    error: "Error",
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <h3>Two-way talk</h3>
        <label className="checkbox small">
          <input
            type="checkbox"
            checked={pushToTalk}
            onChange={(e) => setPushToTalk(e.target.checked)}
            disabled={active}
          />
          Push to talk
        </label>
      </header>
      {!device.capabilities.talkback && <p className="muted">This device does not support talkback.</p>}
      {!supported && <p className="warn-text">Microphone capture is not available in this webview.</p>}
      {supported && device.capabilities.talkback && !streaming && (
        <p className="muted">Start the live view to enable two-way talk.</p>
      )}
      <div className="talk-row">
        {pushToTalk ? (
          <button
            type="button"
            className={`btn btn-talk ${active ? "active" : ""}`}
            disabled={!supported || !device.capabilities.talkback || bridgeStatus !== "connected" || !streaming}
            onPointerDown={onHoldStart}
            onPointerUp={onHoldEnd}
            onPointerLeave={onHoldEnd}
            onPointerCancel={onHoldEnd}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !holdRef.current) onHoldStart();
            }}
            onKeyUp={(e) => {
              if (e.key === " " || e.key === "Enter") onHoldEnd();
            }}
          >
            {active ? "Release to stop" : "Hold to talk"}
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn-talk ${active ? "active" : ""}`}
            disabled={!supported || !device.capabilities.talkback || bridgeStatus !== "connected" || !streaming}
            onClick={toggle}
          >
            {active ? "Stop talking" : "Start talking"}
          </button>
        )}
        <div className="talk-status">
          <span className={info.state === "error" ? "warn-text" : ""}>{stateLabel[info.state]}</span>
          {info.state === "active" && (
            <span className="muted small">
              {info.capture === "worklet" ? "AudioWorklet" : "ScriptProcessor"} @ {info.contextRate} Hz →
              16 kHz · {formatBytes(info.bytesSent)} sent
            </span>
          )}
          {info.error && <span className="warn-text small">{info.error}</span>}
        </div>
      </div>
      {device.capabilities.quickResponse && <QuickResponse device={device} />}
    </section>
  );
}

function QuickResponse({ device }: { device: Device }) {
  const { bridge, bridgeStatus } = useStore();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [selected, setSelected] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (bridgeStatus !== "connected") return;
    let cancelled = false;
    bridge
      .call("device.voices", { serial: device.serial })
      .then((r) => {
        if (cancelled) return;
        setVoices(r.voices);
        if (r.voices.length > 0) setSelected(r.voices[0].id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, bridgeStatus, device.serial]);

  const send = async () => {
    if (selected === "") return;
    setBusy(true);
    setError(null);
    try {
      await bridge.call("device.quick_response", { serial: device.serial, voiceId: selected });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-response">
      <label htmlFor="quick-voice">Quick response</label>
      <select
        id="quick-voice"
        value={selected}
        onChange={(e) => setSelected(e.target.value === "" ? "" : Number(e.target.value))}
        disabled={!voices || voices.length === 0}
      >
        {!voices && <option value="">Loading…</option>}
        {voices && voices.length === 0 && <option value="">No voices available</option>}
        {voices?.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <button type="button" className="btn" onClick={() => void send()} disabled={busy || selected === ""}>
        {busy ? "Playing…" : "Play"}
      </button>
      {error && <span className="warn-text small">{error}</span>}
    </div>
  );
}
