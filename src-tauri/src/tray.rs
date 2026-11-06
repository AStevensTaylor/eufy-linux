//! Tray icon and its menu.
//!
//! Note for Linux: with AppIndicator / StatusNotifier based trays (GNOME with
//! the AppIndicator extension, KDE, etc.) a left click opens the menu instead
//! of reaching `on_tray_icon_event`, so the menu always has a "Show window"
//! entry. On trays that do report clicks, a left click shows the window.

use tauri::{
    AppHandle, Runtime,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::window;

pub const TRAY_ID: &str = "main";

const ITEM_SHOW: &str = "show";
const ITEM_HIDE: &str = "hide";
const ITEM_SETTINGS: &str = "settings";
const ITEM_QUIT: &str = "quit";

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, ITEM_SHOW, "Show window", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, ITEM_HIDE, "Hide window", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, ITEM_SETTINGS, "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Eufy Linux")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ITEM_SHOW | ITEM_SETTINGS => window::show_main(app),
            ITEM_HIDE => window::hide_main(app),
            ITEM_QUIT => window::quit(app),
            other => log::debug!("unhandled tray menu item {other}"),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        log::warn!("no default window icon; tray icon will be blank");
    }
    builder.build(app)?;
    Ok(())
}
