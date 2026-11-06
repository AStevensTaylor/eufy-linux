import { batteryOf, isOnline } from "../lib/format";
import type { Device, Picture } from "../lib/types";
import { StatusPill } from "./StatusPill";
import { Thumbnail } from "./Thumbnail";

export function DeviceCard({
  device,
  picture,
  onOpen,
}: {
  device: Device;
  picture: Picture | undefined;
  onOpen: (serial: string) => void;
}) {
  const battery = batteryOf(device.properties);
  const online = isOnline(device.properties);
  const canOpen = device.capabilities.livestream;
  return (
    <button
      type="button"
      className="device-card"
      onClick={() => onOpen(device.serial)}
      disabled={!canOpen}
      title={canOpen ? "Open live view" : "This device has no live stream"}
    >
      <Thumbnail picture={picture} alt={`Last event from ${device.name}`} className="device-thumb" />
      <div className="device-body">
        <div className="device-title-row">
          <span className="device-name">{device.name}</span>
          {device.isDoorbell && <span className="tag">Doorbell</span>}
        </div>
        <div className="device-meta">
          <span className="muted">{device.model}</span>
          <span className="muted mono">{device.serial}</span>
        </div>
        <div className="device-pills">
          {online !== null && (
            <StatusPill label={online ? "Online" : "Offline"} tone={online ? "ok" : "bad"} />
          )}
          {device.hasBattery && battery !== null && (
            <StatusPill
              label={`${battery}%`}
              tone={battery > 40 ? "ok" : battery > 15 ? "warn" : "bad"}
              title="Battery"
            />
          )}
          {!device.hasBattery && battery === null && <StatusPill label="Wired" tone="muted" />}
        </div>
      </div>
    </button>
  );
}
