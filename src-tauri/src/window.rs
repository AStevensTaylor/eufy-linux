//! Main window helpers and the Tauri events about it.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::bridge::Bridge;

/// Label of the main window (see `tauri.conf.json`).
pub const MAIN: &str = "main";
/// Emitted after the main window was shown (or focused).
pub const SHOWN_EVENT: &str = "window-shown";
/// Emitted when the UI should switch to a device's live view.
pub const OPEN_DEVICE_EVENT: &str = "open-device";

#[derive(Debug, Clone, Serialize)]
pub struct OpenDevice<'a> {
    pub serial: &'a str,
    pub reason: &'a str,
}

/// Shows, un-minimizes and focuses the main window, then emits `window-shown`.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN) else {
        log::warn!("main window not found");
        return;
    };
    if let Err(err) = window.show() {
        log::warn!("cannot show window: {err}");
    }
    if window.is_minimized().unwrap_or(false)
        && let Err(err) = window.unminimize()
    {
        log::warn!("cannot unminimize window: {err}");
    }
    if let Err(err) = window.set_focus() {
        log::warn!("cannot focus window: {err}");
    }
    if let Err(err) = app.emit(SHOWN_EVENT, serde_json::json!({})) {
        log::warn!("cannot emit {SHOWN_EVENT}: {err}");
    }
}

/// Hides the main window (to the tray).
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN)
        && let Err(err) = window.hide()
    {
        log::warn!("cannot hide window: {err}");
    }
}

pub fn is_main_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(MAIN)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Emits `open-device { serial, reason }`.
pub fn emit_open_device<R: Runtime>(app: &AppHandle<R>, serial: &str, reason: &str) {
    if let Err(err) = app.emit(OPEN_DEVICE_EVENT, OpenDevice { serial, reason }) {
        log::warn!("cannot emit {OPEN_DEVICE_EVENT}: {err}");
    }
}

/// Stops the bridge and exits the process.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    log::info!("quitting");
    app.state::<Bridge>().shutdown();
    app.exit(0);
}

/// Whether the main window should be visible right after startup.
/// `--show` forces it, `--minimized` (the autostart argument) hides it,
/// otherwise the `startMinimized` setting decides.
pub fn should_start_visible(args: &[String], start_minimized: bool) -> bool {
    if args.iter().any(|a| a == "--show") {
        return true;
    }
    if args.iter().any(|a| a == "--minimized") {
        return false;
    }
    !start_minimized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn startup_visibility() {
        assert!(!should_start_visible(&args(&["app"]), true));
        assert!(should_start_visible(&args(&["app"]), false));
        assert!(!should_start_visible(&args(&["app", "--minimized"]), false));
        assert!(should_start_visible(&args(&["app", "--show"]), true));
        assert!(should_start_visible(&args(&["app", "--minimized", "--show"]), true));
    }

    #[test]
    fn open_device_payload_shape() {
        let v = serde_json::to_value(OpenDevice {
            serial: "S1",
            reason: "ring",
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "serial": "S1", "reason": "ring" }));
    }
}
