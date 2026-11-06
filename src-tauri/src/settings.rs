//! User settings: the `Settings` type from docs/ARCHITECTURE.md, its defaults,
//! and persistence through `tauri-plugin-store` (`settings.json` in the app
//! config dir).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::StoreExt;

/// File name of the settings store, resolved inside the app config dir.
pub const STORE_FILE: &str = "settings.json";
/// Key under which the settings object is stored.
const STORE_KEY: &str = "settings";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub ring: bool,
    pub motion: bool,
    pub person: bool,
    pub other: bool,
    pub with_image: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ring: true,
            motion: true,
            person: true,
            other: true,
            with_image: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PopupSettings {
    /// Show + focus the main window when the doorbell rings.
    pub on_ring: bool,
    pub on_motion: bool,
    pub on_person: bool,
}

impl Default for PopupSettings {
    fn default() -> Self {
        Self {
            on_ring: true,
            on_motion: false,
            on_person: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub notifications: NotificationSettings,
    pub popup: PopupSettings,
    pub autostart: bool,
    /// Start hidden in the tray.
    pub start_minimized: bool,
    /// Window close button hides instead of quitting.
    pub close_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            notifications: NotificationSettings::default(),
            popup: PopupSettings::default(),
            autostart: false,
            start_minimized: true,
            close_to_tray: true,
        }
    }
}

impl Settings {
    /// Builds settings from a (possibly partial or malformed) JSON value.
    /// Missing fields take their defaults; a value that is not an object is
    /// treated as "no settings stored".
    pub fn from_json(value: &serde_json::Value) -> Self {
        if !value.is_object() {
            return Self::default();
        }
        serde_json::from_value(value.clone()).unwrap_or_else(|err| {
            log::warn!("stored settings are malformed ({err}); falling back to defaults");
            Self::default()
        })
    }
}

/// Absolute path of the settings store file.
fn store_path<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<std::path::PathBuf> {
    Ok(app.path().app_config_dir()?.join(STORE_FILE))
}

/// Loads the persisted settings, or the defaults when nothing was stored yet.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let path = match store_path(app) {
        Ok(path) => path,
        Err(err) => {
            log::warn!("cannot resolve settings path: {err}");
            return Settings::default();
        }
    };
    match app.store(&path) {
        Ok(store) => match store.get(STORE_KEY) {
            Some(value) => Settings::from_json(&value),
            None => Settings::default(),
        },
        Err(err) => {
            log::warn!("cannot open settings store {}: {err}", path.display());
            Settings::default()
        }
    }
}

/// Persists the settings to the store file.
pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let path = store_path(app).map_err(|e| e.to_string())?;
    let store = app.store(&path).map_err(|e| e.to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(settings).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_contract() {
        let s = Settings::default();
        assert!(s.notifications.enabled);
        assert!(s.notifications.ring);
        assert!(s.notifications.motion);
        assert!(s.notifications.person);
        assert!(s.notifications.other);
        assert!(s.notifications.with_image);
        assert!(s.popup.on_ring);
        assert!(!s.popup.on_motion);
        assert!(!s.popup.on_person);
        assert!(!s.autostart);
        assert!(s.start_minimized);
        assert!(s.close_to_tray);
    }

    #[test]
    fn serializes_with_camel_case_keys() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["startMinimized"], json!(true));
        assert_eq!(v["closeToTray"], json!(true));
        assert_eq!(v["notifications"]["withImage"], json!(true));
        assert_eq!(v["popup"]["onRing"], json!(true));
        assert!(v.get("start_minimized").is_none());
    }

    #[test]
    fn partial_json_merges_with_defaults() {
        let v = json!({
            "notifications": { "motion": false },
            "closeToTray": false
        });
        let s = Settings::from_json(&v);
        assert!(!s.notifications.motion);
        assert!(s.notifications.ring, "untouched nested field keeps default");
        assert!(s.notifications.with_image);
        assert!(!s.close_to_tray);
        assert!(s.start_minimized, "untouched top-level field keeps default");
        assert_eq!(s.popup, PopupSettings::default());
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let v = json!({ "autostart": true, "someFutureKey": 42 });
        let s = Settings::from_json(&v);
        assert!(s.autostart);
    }

    #[test]
    fn malformed_json_falls_back_to_defaults() {
        assert_eq!(Settings::from_json(&json!("nope")), Settings::default());
        assert_eq!(Settings::from_json(&json!(null)), Settings::default());
        // wrong type inside: whole object rejected -> defaults
        let v = json!({ "autostart": "yes" });
        assert_eq!(Settings::from_json(&v), Settings::default());
    }

    #[test]
    fn round_trips() {
        let s = Settings {
            autostart: true,
            popup: PopupSettings {
                on_person: true,
                ..PopupSettings::default()
            },
            notifications: NotificationSettings {
                other: false,
                ..NotificationSettings::default()
            },
            ..Settings::default()
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(Settings::from_json(&v), s);
    }
}
