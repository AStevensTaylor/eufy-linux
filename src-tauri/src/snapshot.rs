//! Where webview downloads (snapshots saved by the UI through `<a download>`)
//! land, and the `snapshot-saved` event.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, webview::DownloadEvent};

/// Emitted after a download finished successfully.
pub const SAVED_EVENT: &str = "snapshot-saved";
/// Sub directory (inside the pictures dir or the app data dir) for snapshots.
pub const SUBDIR: &str = "eufy-linux";

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotSaved {
    pub path: String,
}

/// Remembers the destination chosen for the download in flight, since
/// `DownloadEvent::Finished` may not carry the path.
#[derive(Default)]
pub struct Downloads {
    last_destination: Mutex<Option<PathBuf>>,
}

/// Directory snapshots are written to: `<pictures>/eufy-linux`, or
/// `<app data>/eufy-linux` when there is no pictures dir.
pub fn snapshot_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let base = app
        .path()
        .picture_dir()
        .ok()
        .filter(|p| p.is_dir() || std::fs::create_dir_all(p).is_ok())
        .or_else(|| app.path().app_data_dir().ok())?;
    let dir = base.join(SUBDIR);
    match std::fs::create_dir_all(&dir) {
        Ok(()) => Some(dir),
        Err(err) => {
            log::warn!("cannot create snapshot dir {}: {err}", dir.display());
            None
        }
    }
}

/// `snapshot-<YYYYMMDD-HHMMSS>.<ext>`; `ext` comes from the suggested file
/// name when it has one, `png` otherwise.
pub fn snapshot_file_name(suggested: Option<&Path>, unix_secs: u64) -> String {
    let ext = suggested
        .and_then(|p| p.extension())
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "png".to_string());
    format!("snapshot-{}.{ext}", format_timestamp(unix_secs))
}

/// `YYYYMMDD-HHMMSS` in UTC (Howard Hinnant's civil-from-days).
pub fn format_timestamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let secs = unix_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Download handler for the main window builder: routes every download to
/// the snapshot dir and emits `snapshot-saved { path }` once it finished.
pub fn handle_download<R: Runtime>(app: &AppHandle<R>, event: DownloadEvent<'_>) -> bool {
    let downloads = app.state::<Downloads>();
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Some(dir) = snapshot_dir(app) else {
                log::warn!("no directory for downloads; refusing {url}");
                return false;
            };
            let suggested = if destination.as_os_str().is_empty() {
                None
            } else {
                Some(destination.clone())
            };
            let path = dir.join(snapshot_file_name(suggested.as_deref(), now_secs()));
            log::info!("download {url} -> {}", path.display());
            *downloads
                .last_destination
                .lock()
                .expect("downloads poisoned") = Some(path.clone());
            *destination = path;
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let remembered = downloads
                .last_destination
                .lock()
                .expect("downloads poisoned")
                .take();
            let path = path.or(remembered);
            if !success {
                log::warn!("download {url} failed");
                return true;
            }
            let Some(path) = path else {
                log::warn!("download {url} finished but its path is unknown");
                return true;
            };
            log::info!("download saved to {}", path.display());
            if let Err(err) = app.emit(
                SAVED_EVENT,
                SnapshotSaved {
                    path: path.to_string_lossy().into_owned(),
                },
            ) {
                log::warn!("cannot emit {SAVED_EVENT}: {err}");
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_timestamps_in_utc() {
        assert_eq!(format_timestamp(0), "19700101-000000");
        // 2026-11-06 08:44:28 UTC
        assert_eq!(format_timestamp(1_793_954_668), "20261106-084428");
        // leap day: 2024-02-29 23:59:59 UTC
        assert_eq!(format_timestamp(1_709_251_199), "20240229-235959");
        // 2000-03-01 00:00:00 UTC
        assert_eq!(format_timestamp(951_868_800), "20000301-000000");
    }

    #[test]
    fn builds_snapshot_file_name() {
        assert_eq!(snapshot_file_name(None, 0), "snapshot-19700101-000000.png");
        assert_eq!(
            snapshot_file_name(Some(Path::new("/tmp/front door.JPG")), 0),
            "snapshot-19700101-000000.jpg"
        );
        assert_eq!(
            snapshot_file_name(Some(Path::new("blob-without-extension")), 0),
            "snapshot-19700101-000000.png"
        );
        assert_eq!(
            snapshot_file_name(Some(Path::new("weird.p/ng")), 0),
            "snapshot-19700101-000000.png"
        );
    }

    #[test]
    fn saved_payload_shape() {
        let v = serde_json::to_value(SnapshotSaved {
            path: "/x/y.png".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "path": "/x/y.png" }));
    }
}
