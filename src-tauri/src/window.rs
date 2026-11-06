//! Main window helpers and the Tauri events about it.

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::{bridge::Bridge, snapshot};

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

/// Creates the (hidden) main window. It is built in code rather than from
/// `tauri.conf.json` so the Linux webview can be configured: microphone
/// permission requests (two-way talk) are granted and downloads are routed
/// to the snapshot directory.
pub fn create_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let download_app = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::default())
        .title("Eufy Linux")
        .inner_size(1100.0, 760.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .visible(false)
        .center()
        .on_download(move |_webview, event| snapshot::handle_download(&download_app, event))
        .build()?;
    configure_platform_webview(&window)?;
    Ok(window)
}

/// WebKitGTK denies `getUserMedia` unless the embedder answers the
/// `permission-request` signal, so allow user-media requests and make sure
/// media streams, WebAudio and MSE are enabled.
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn configure_platform_webview<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.with_webview(|platform_webview| {
        use webkit2gtk::{
            PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt,
            glib::prelude::*,
        };
        let webview = platform_webview.inner();
        if let Some(settings) = webview.settings() {
            settings.set_enable_media_stream(true);
            settings.set_enable_webaudio(true);
            settings.set_enable_mediasource(true);
        }
        webview.connect_permission_request(|_webview, request| {
            if request.is::<UserMediaPermissionRequest>() {
                log::info!("granting user media (microphone/camera) permission request");
                request.allow();
                true
            } else {
                log::debug!("leaving permission request {request:?} to the default handler");
                false
            }
        });
    })
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
fn configure_platform_webview<R: Runtime>(_window: &WebviewWindow<R>) -> tauri::Result<()> {
    Ok(())
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
        assert!(should_start_visible(
            &args(&["app", "--minimized", "--show"]),
            true
        ));
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
