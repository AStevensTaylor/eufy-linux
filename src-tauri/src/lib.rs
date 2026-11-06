//! Eufy Linux desktop shell: tray icon, main window, settings, the bridge
//! sidecar supervisor and the desktop notification client.
//!
//! The commands and events exposed to the webview are documented in
//! docs/ARCHITECTURE.md ("Rust <-> webview contract").

pub mod bridge;
pub mod notifier;
pub mod settings;
pub mod snapshot;
pub mod tray;
pub mod window;

use std::sync::Mutex;

use log::LevelFilter;
use tauri::{AppHandle, Manager, RunEvent, Runtime, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_notification::NotificationExt;

use bridge::{Bridge, BridgeInfo};
use settings::Settings;

/// Argument the autostart entry launches the app with.
pub const MINIMIZED_ARG: &str = "--minimized";

/// Live application state shared between commands and the notifier.
pub struct AppState {
    pub settings: Mutex<Settings>,
}

impl AppState {
    pub fn settings(&self) -> Settings {
        self.settings.lock().expect("settings poisoned").clone()
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_bridge_info(bridge: State<'_, Bridge>) -> BridgeInfo {
    bridge.info()
}

#[tauri::command]
fn restart_bridge(bridge: State<'_, Bridge>) {
    bridge.restart();
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    window::hide_main(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    window::quit(&app);
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    settings::save(&app, &settings)?;
    let previous = std::mem::replace(
        &mut *state.settings.lock().expect("settings poisoned"),
        settings.clone(),
    );
    if previous.autostart != settings.autostart {
        apply_autostart(&app, settings.autostart);
    }
    log::info!("settings updated");
    Ok(())
}

#[tauri::command]
fn test_notification(app: AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title("Front Door: Someone is at the door")
        .body("This is a test notification from Eufy Linux.")
        .show()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/// Enables or disables the autostart entry so it matches `enabled`.
fn apply_autostart<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let launcher = app.autolaunch();
    match launcher.is_enabled() {
        Ok(current) if current == enabled => return,
        Ok(_) => {}
        Err(err) => log::debug!("cannot query autostart state: {err}"),
    }
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    match result {
        Ok(()) => log::info!("autostart {}", if enabled { "enabled" } else { "disabled" }),
        Err(err) => log::warn!("cannot update autostart: {err}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch just shows the window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            log::info!("second instance launched with {args:?}; showing window");
            window::show_main(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(LevelFilter::Info)
                .level_for("eufy_linux_lib", LevelFilter::Debug)
                .level_for("bridge", LevelFilter::Debug)
                .level_for("bridge.ws", LevelFilter::Debug)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_ARG]),
        ))
        .manage(Bridge::new())
        .manage(snapshot::Downloads::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = settings::load(&handle);
            log::debug!("loaded settings: {settings:?}");
            apply_autostart(&handle, settings.autostart);
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
            });

            window::create_main(&handle)?;
            tray::setup(&handle)?;
            notifier::register_click_handler(&handle);
            bridge::start(handle.clone());
            notifier::start(handle.clone());

            let args: Vec<String> = std::env::args().collect();
            if window::should_start_visible(&args, settings.start_minimized) {
                window::show_main(&handle);
            } else {
                log::info!("starting minimized to the tray");
            }
            Ok(())
        })
        .on_window_event(|win, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && win.label() == window::MAIN
            {
                let app = win.app_handle();
                let close_to_tray = app.state::<AppState>().settings().close_to_tray;
                api.prevent_close();
                if close_to_tray {
                    log::info!("close requested; hiding to tray");
                    window::hide_main(app);
                } else {
                    window::quit(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_bridge_info,
            restart_bridge,
            hide_window,
            quit_app,
            get_settings,
            set_settings,
            test_notification,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Tray-resident: closing the last window must not end the process.
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            RunEvent::Exit => app.state::<Bridge>().shutdown(),
            _ => {}
        });
}
