import { useEffect, useMemo, useRef, useState } from "react";
import { StatusPill } from "../components/StatusPill";
import { TalkbackControls } from "../components/TalkbackControls";
import { formatBytes } from "../lib/format";
import { LivePlayer, mseSupported } from "../lib/player";
import { useStore } from "../lib/store";
import { useObservable } from "../lib/useObservable";

export function LiveView({ serial }: { serial: string }) {
  const { state, bridge, bridgeStatus, navigate } = useStore();
  const device = state.devices[serial];
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const player = useMemo(() => new LivePlayer(bridge, serial), [bridge, serial]);
  const info = useObservable(player.info);
  const [muted, setMuted] = useState(true);
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null);

  // Start on mount / when the bridge (re)connects; stop on unmount.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    player.attach(v);
    if (bridgeStatus === "connected" && device?.capabilities.livestream) void player.start();
    return () => {
      void player.dispose();
    };
  }, [player, bridgeStatus, device?.capabilities.livestream]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  const reconnect = async () => {
    await player.stop();
    await player.start();
  };

  const snapshot = async () => {
    const blob = await player.snapshot();
    if (!blob) {
      setSnapshotMsg("No decoded frame yet.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `${device?.name ?? serial}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setSnapshotMsg("Snapshot saved.");
    setTimeout(() => setSnapshotMsg(null), 3_000);
  };

  if (!device) {
    return (
      <div className="view">
        <button type="button" className="btn btn-link" onClick={() => navigate({ name: "devices" })}>
          ← Devices
        </button>
        <div className="empty">
          <p>Unknown device {serial}.</p>
          <p className="muted">{state.synced ? "It is not on this account." : "Waiting for the bridge…"}</p>
        </div>
      </div>
    );
  }

  const meta = info.metadata;
  const tone =
    info.state === "playing" ? "ok" : info.state === "error" ? "bad" : info.state === "starting" ? "warn" : "muted";
  const stateLabel: Record<typeof info.state, string> = {
    idle: "Idle",
    starting: "Starting stream…",
    playing: "Live",
    stopped: "Stopped",
    error: "Error",
  };

  return (
    <div className="view live">
      <div className="live-header">
        <button type="button" className="btn btn-link" onClick={() => navigate({ name: "devices" })}>
          ← Devices
        </button>
        <h2 className="view-title">{device.name}</h2>
        <StatusPill label={stateLabel[info.state]} tone={tone} />
        {meta && (
          <span className="muted small">
            {meta.videoCodec.toUpperCase()} {meta.videoWidth}×{meta.videoHeight}
            {meta.videoFPS ? ` @ ${meta.videoFPS} fps` : ""} · audio {meta.audioCodec}
            {info.mode && ` · ${info.mode}`}
          </span>
        )}
      </div>

      {!mseSupported() && (
        <div className="alert alert-warn">
          Media Source Extensions with H.264 are not available in this webview. On Linux install the
          GStreamer <code>good</code>, <code>bad</code> and <code>libav</code> plugin sets.
        </div>
      )}
      {info.warning && <div className="alert alert-warn">{info.warning}</div>}
      {info.error && <div className="alert alert-error">{info.error}</div>}

      <div className="video-wrap">
        <video ref={videoRef} className="video" playsInline autoPlay muted={muted} controls={false} />
        {info.state !== "playing" && (
          <div className="video-overlay">
            {info.state === "starting" && <span className="spinner" aria-hidden="true" />}
            <span>{stateLabel[info.state]}</span>
          </div>
        )}
      </div>

      <div className="toolbar">
        <button type="button" className="btn" onClick={() => void reconnect()} disabled={bridgeStatus !== "connected"}>
          Reconnect
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setMuted((m) => !m)}
          disabled={info.mode === "video"}
          title={info.mode === "video" ? "This stream has no audio" : undefined}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" className="btn" onClick={() => void snapshot()} disabled={info.state !== "playing"}>
          Snapshot
        </button>
        {snapshotMsg && <span className="muted small">{snapshotMsg}</span>}
        <span className="spacer" />
        {info.state === "playing" && (
          <span className="muted small mono">
            v {info.videoChunks} / {formatBytes(info.videoBytes)} · a {info.audioChunks} / {formatBytes(info.audioBytes)}
          </span>
        )}
      </div>

      {(device.capabilities.talkback || device.capabilities.quickResponse) && <TalkbackControls device={device} streaming={info.state === "playing"} />}
    </div>
  );
}
