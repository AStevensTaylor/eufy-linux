//! Notification client: a websocket client of the bridge (docs/PROTOCOL.md)
//! that turns `device.event` messages into desktop notifications and, per the
//! popup settings, shows the main window with an `open-device` event.
//!
//! It runs for the lifetime of the app: it waits for the supervisor to report
//! a ready bridge, connects, authenticates with `auth.hello {client: "shell"}`,
//! seeds itself with `events.recent`, and reconnects with backoff when the
//! socket drops or the bridge is restarted.

use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::watch;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{
    bridge::{Bridge, Endpoint},
    settings::Settings,
    window,
};

/// Key in the notification's `extra` map that carries the device serial, so a
/// click on the notification can open that device.
pub const EXTRA_SERIAL: &str = "serial";
/// Sub directory of the app cache dir holding event pictures.
pub const IMAGE_SUBDIR: &str = "events";
/// Number of event pictures kept on disk.
pub const IMAGES_TO_KEEP: usize = 50;
/// Events from `events.recent` older than this are not notified on connect.
const RECENT_WINDOW: Duration = Duration::from_secs(60);
/// Number of event ids remembered for de-duplication.
const SEEN_CAPACITY: usize = 500;

const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
pub struct Picture {
    pub mime: String,
    /// base64, no `data:` prefix
    pub data: String,
}

/// `DeviceEvent` from PROTOCOL.md (only the fields the shell uses).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEvent {
    pub id: String,
    pub serial: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub state: bool,
    #[serde(default)]
    pub person_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    /// ms since epoch
    #[serde(default)]
    pub timestamp: f64,
    #[serde(default)]
    pub picture: Option<Picture>,
}

/// A JSON frame from the bridge.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Incoming {
    Event {
        event: String,
        #[serde(default)]
        data: Value,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        error: Value,
    },
}

impl Incoming {
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Ring,
    Motion,
    Person,
    Other,
}

impl Category {
    pub fn of(kind: &str) -> Self {
        match kind {
            "ring" => Self::Ring,
            "motion" | "radar_motion" => Self::Motion,
            "person" | "stranger" => Self::Person,
            _ => Self::Other,
        }
    }

    /// `reason` of the `open-device` event for a popup caused by this category.
    pub fn open_reason(self) -> Option<&'static str> {
        match self {
            Self::Ring => Some("ring"),
            Self::Motion => Some("motion"),
            Self::Person => Some("person"),
            Self::Other => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Decision {
    pub notify: bool,
    pub popup: bool,
}

/// What to do for an event under the given settings.
pub fn decide(settings: &Settings, event: &DeviceEvent) -> Decision {
    if !event.state {
        return Decision::default();
    }
    let category = Category::of(&event.kind);
    let n = &settings.notifications;
    let notify = n.enabled
        && match category {
            Category::Ring => n.ring,
            Category::Motion => n.motion,
            Category::Person => n.person,
            Category::Other => n.other,
        };
    let p = &settings.popup;
    let popup = match category {
        Category::Ring => p.on_ring,
        Category::Motion => p.on_motion,
        Category::Person => p.on_person,
        Category::Other => false,
    };
    Decision { notify, popup }
}

/// Human text for an event kind.
pub fn kind_text(kind: &str) -> &'static str {
    match kind {
        "ring" => "Someone is at the door",
        "motion" | "radar_motion" => "Motion detected",
        "person" => "Person detected",
        "stranger" => "Stranger detected",
        "pet" => "Pet detected",
        "vehicle" => "Vehicle detected",
        "sound" => "Sound detected",
        "crying" => "Crying detected",
        "package_delivered" => "Package delivered",
        "package_taken" => "Package taken",
        "package_stranded" => "Package stranded",
        "loitering" => "Loitering detected",
        "dog" => "Dog detected",
        "low_battery" => "Battery low",
        _ => "Activity detected",
    }
}

/// Notification title: `"<device>: <headline>"`.
pub fn notification_title(event: &DeviceEvent) -> String {
    let headline = match event.title.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => match (&event.kind[..], event.person_name.as_deref()) {
            ("person", Some(name)) if !name.trim().is_empty() => format!("{} detected", name.trim()),
            _ => kind_text(&event.kind).to_string(),
        },
    };
    let device = event.device_name.trim();
    if device.is_empty() {
        headline
    } else {
        format!("{device}: {headline}")
    }
}

/// Notification body: the push content when available, else a description.
pub fn notification_body(event: &DeviceEvent) -> String {
    match event.content.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => {
            let mut body = kind_text(&event.kind).to_string();
            if let Some(name) = event.person_name.as_deref().map(str::trim)
                && !name.is_empty()
            {
                body = format!("{body} ({name})");
            }
            body
        }
    }
}

/// File extension for an image MIME type.
pub fn extension_for_mime(mime: &str) -> &'static str {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "img",
    }
}

/// Keeps an event id usable as a file name.
pub fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    if cleaned.is_empty() {
        "event".to_string()
    } else {
        cleaned
    }
}

/// Decodes the event picture into `<dir>/<id>.<ext>` and prunes old images,
/// returning the written path.
pub fn write_event_image(dir: &Path, event: &DeviceEvent) -> Option<PathBuf> {
    let picture = event.picture.as_ref()?;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(picture.data.trim()) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        Ok(_) => return None,
        Err(err) => {
            log::warn!("event {} picture is not valid base64: {err}", event.id);
            return None;
        }
    };
    if let Err(err) = std::fs::create_dir_all(dir) {
        log::warn!("cannot create {}: {err}", dir.display());
        return None;
    }
    let path = dir.join(format!(
        "{}.{}",
        sanitize_id(&event.id),
        extension_for_mime(&picture.mime)
    ));
    if let Err(err) = std::fs::write(&path, bytes) {
        log::warn!("cannot write {}: {err}", path.display());
        return None;
    }
    prune_images(dir, IMAGES_TO_KEEP);
    Some(path)
}

/// Deletes all but the `keep` most recently modified files in `dir`.
pub fn prune_images(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((meta.modified().unwrap_or(UNIX_EPOCH), entry.path()))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, path) in files.into_iter().skip(keep) {
        if let Err(err) = std::fs::remove_file(&path) {
            log::debug!("cannot remove old event image {}: {err}", path.display());
        }
    }
}

/// Bounded set of event ids already handled.
pub struct Seen {
    set: HashSet<String>,
    order: VecDeque<String>,
    capacity: usize,
}

impl Seen {
    pub fn new(capacity: usize) -> Self {
        Self {
            set: HashSet::new(),
            order: VecDeque::new(),
            capacity,
        }
    }

    /// Records the id; returns `true` when it was not seen before.
    pub fn insert(&mut self, id: &str) -> bool {
        if !self.set.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > self.capacity {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Whether an event from `events.recent` is fresh enough to be notified.
pub fn is_recent(event: &DeviceEvent, now_ms: f64) -> bool {
    event.timestamp > 0.0 && now_ms - event.timestamp <= RECENT_WINDOW.as_millis() as f64
}

/// Starts the client loop on the Tauri async runtime.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move { run(app).await });
}

async fn run<R: Runtime>(app: AppHandle<R>) {
    let mut endpoint_rx = app.state::<Bridge>().subscribe();
    let mut seen = Seen::new(SEEN_CAPACITY);
    let mut backoff = MIN_BACKOFF;

    loop {
        if app.state::<Bridge>().is_quitting() {
            return;
        }
        // Wait for a ready bridge.
        let endpoint = loop {
            let current = endpoint_rx.borrow_and_update().clone();
            if let Some(endpoint) = current {
                break endpoint;
            }
            if endpoint_rx.changed().await.is_err() {
                return;
            }
        };

        match session(&app, &endpoint, &mut endpoint_rx, &mut seen).await {
            Ok(()) => {
                log::info!("bridge notification socket closed");
                backoff = MIN_BACKOFF;
            }
            Err(err) => log::warn!("bridge notification socket: {err}"),
        }

        // If the bridge moved (restart), reconnect right away.
        if endpoint_rx.borrow().as_ref() != Some(&endpoint) {
            backoff = MIN_BACKOFF;
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = endpoint_rx.changed() => {}
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

fn command(id: &str, command: &str, params: Value) -> Message {
    Message::text(
        json!({ "type": "command", "id": id, "command": command, "params": params }).to_string(),
    )
}

async fn session<R: Runtime>(
    app: &AppHandle<R>,
    endpoint: &Endpoint,
    endpoint_rx: &mut watch::Receiver<Option<Endpoint>>,
    seen: &mut Seen,
) -> Result<(), String> {
    let (ws, _) = connect_async(endpoint.url.as_str())
        .await
        .map_err(|e| format!("connect {}: {e}", endpoint.url))?;
    let (mut tx, mut rx) = ws.split();
    log::info!("connected to bridge at {}", endpoint.url);

    tx.send(command(
        "hello",
        "auth.hello",
        json!({ "token": endpoint.token, "client": "shell" }),
    ))
    .await
    .map_err(|e| e.to_string())?;

    loop {
        tokio::select! {
            msg = rx.next() => {
                let Some(msg) = msg else { return Ok(()) };
                match msg.map_err(|e| e.to_string())? {
                    Message::Text(text) => {
                        if let Some(reply) = handle_text(app, &text, seen) {
                            tx.send(reply).await.map_err(|e| e.to_string())?;
                        }
                    }
                    Message::Ping(payload) => {
                        tx.send(Message::Pong(payload)).await.map_err(|e| e.to_string())?;
                    }
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
            changed = endpoint_rx.changed() => {
                // bridge restarted or went away: this socket is stale
                let _ = changed;
                let _ = tx.close().await;
                return Ok(());
            }
        }
    }
}

/// Handles one JSON frame; returns a message to send back, if any.
fn handle_text<R: Runtime>(app: &AppHandle<R>, text: &str, seen: &mut Seen) -> Option<Message> {
    match Incoming::parse(text)? {
        Incoming::Result { id, ok, result, error } => match id.as_str() {
            "hello" => {
                if ok {
                    log::info!("authenticated with bridge ({})", result);
                    Some(command("recent", "events.recent", json!({ "limit": 50 })))
                } else {
                    log::error!("bridge rejected auth.hello: {error}");
                    None
                }
            }
            "recent" => {
                if ok {
                    let events: Vec<DeviceEvent> = result
                        .get("events")
                        .cloned()
                        .and_then(|v| serde_json::from_value(v).ok())
                        .unwrap_or_default();
                    let now = now_ms();
                    for event in events {
                        let fresh = seen.insert(&event.id);
                        if fresh && is_recent(&event, now) {
                            handle_event(app, event);
                        }
                    }
                } else {
                    log::warn!("events.recent failed: {error}");
                }
                None
            }
            _ => None,
        },
        Incoming::Event { event, data } => {
            match event.as_str() {
                "device.event" => match serde_json::from_value::<DeviceEvent>(data) {
                    Ok(event) => {
                        if seen.insert(&event.id) {
                            handle_event(app, event);
                        }
                    }
                    Err(err) => log::warn!("malformed device.event: {err}"),
                },
                "auth.status" => {
                    log::info!(
                        "bridge auth status: {} (push {})",
                        data.get("state").and_then(Value::as_str).unwrap_or("?"),
                        if data.get("pushConnected").and_then(Value::as_bool) == Some(true) {
                            "connected"
                        } else {
                            "disconnected"
                        }
                    );
                }
                "bridge.log" => {
                    let message = data.get("message").and_then(Value::as_str).unwrap_or("");
                    match data.get("level").and_then(Value::as_str).unwrap_or("info") {
                        "error" => log::error!(target: "bridge.ws", "{message}"),
                        "warn" => log::warn!(target: "bridge.ws", "{message}"),
                        "debug" => log::debug!(target: "bridge.ws", "{message}"),
                        _ => log::info!(target: "bridge.ws", "{message}"),
                    }
                }
                _ => {}
            }
            None
        }
    }
}

fn handle_event<R: Runtime>(app: &AppHandle<R>, event: DeviceEvent) {
    let settings = app
        .state::<crate::AppState>()
        .settings
        .lock()
        .expect("settings poisoned")
        .clone();
    let decision = decide(&settings, &event);
    log::debug!(
        "device.event {} kind={} state={} -> notify={} popup={}",
        event.id,
        event.kind,
        event.state,
        decision.notify,
        decision.popup
    );
    if decision.notify {
        show_notification(app, &event, settings.notifications.with_image);
    }
    if decision.popup
        && let Some(reason) = Category::of(&event.kind).open_reason()
    {
        window::show_main(app);
        window::emit_open_device(app, &event.serial, reason);
    }
}

fn show_notification<R: Runtime>(app: &AppHandle<R>, event: &DeviceEvent, with_image: bool) {
    let mut builder = app
        .notification()
        .builder()
        .title(notification_title(event))
        .body(notification_body(event))
        .extra(EXTRA_SERIAL, event.serial.clone());
    if with_image && event.picture.is_some() {
        match app.path().app_cache_dir() {
            Ok(cache) => {
                if let Some(path) = write_event_image(&cache.join(IMAGE_SUBDIR), event) {
                    builder = builder.icon(path.to_string_lossy().into_owned());
                }
            }
            Err(err) => log::warn!("cannot resolve cache dir for event image: {err}"),
        }
    }
    if let Err(err) = builder.show() {
        log::warn!("cannot show notification: {err}");
    }
}

/// Registers the handler for clicks on notifications: shows the window and
/// emits `open-device` with reason `notification` for the clicked device.
pub fn register_click_handler<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let result = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        let serial = action
            .notification()
            .and_then(|n| n.extra().get(EXTRA_SERIAL))
            .and_then(Value::as_str)
            .map(str::to_owned);
        window::show_main(&handle);
        if let Some(serial) = serial {
            window::emit_open_device(&handle, &serial, "notification");
        }
    });
    if let Err(err) = result {
        log::warn!("cannot register notification click handler: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, state: bool) -> DeviceEvent {
        DeviceEvent {
            id: format!("evt-{kind}"),
            serial: "T8210ABC".into(),
            device_name: "Front Door".into(),
            kind: kind.into(),
            state,
            person_name: None,
            title: None,
            content: None,
            timestamp: 0.0,
            picture: None,
        }
    }

    #[test]
    fn parses_device_event_frame() {
        let text = r#"{"type":"event","event":"device.event","data":{"id":"e1","serial":"S1","stationSerial":"ST","deviceName":"Front Door","kind":"ring","state":true,"title":"Doorbell","content":"Someone rang","timestamp":1700000000000,"picture":{"mime":"image/jpeg","data":"AAA="}}}"#;
        match Incoming::parse(text).unwrap() {
            Incoming::Event { event, data } => {
                assert_eq!(event, "device.event");
                let ev: DeviceEvent = serde_json::from_value(data).unwrap();
                assert_eq!(ev.id, "e1");
                assert_eq!(ev.device_name, "Front Door");
                assert_eq!(ev.kind, "ring");
                assert!(ev.state);
                assert_eq!(ev.title.as_deref(), Some("Doorbell"));
                assert_eq!(ev.timestamp, 1_700_000_000_000.0);
                assert_eq!(ev.picture.unwrap().mime, "image/jpeg");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_result_frames() {
        let ok = r#"{"type":"result","id":"hello","ok":true,"result":{"version":"1.0.0","protocol":1}}"#;
        match Incoming::parse(ok).unwrap() {
            Incoming::Result { id, ok, result, .. } => {
                assert_eq!(id, "hello");
                assert!(ok);
                assert_eq!(result["protocol"], 1);
            }
            other => panic!("unexpected {other:?}"),
        }
        let err = r#"{"type":"result","id":"x","ok":false,"error":{"code":"unauthorized","message":"bad token"}}"#;
        match Incoming::parse(err).unwrap() {
            Incoming::Result { ok, error, .. } => {
                assert!(!ok);
                assert_eq!(error["code"], "unauthorized");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn ignores_unknown_or_malformed_frames() {
        assert!(Incoming::parse("not json").is_none());
        assert!(Incoming::parse(r#"{"type":"weird"}"#).is_none());
        assert!(Incoming::parse(r#"{"type":"result","id":"a"}"#).is_none());
    }

    #[test]
    fn device_event_tolerates_missing_optional_fields() {
        let ev: DeviceEvent =
            serde_json::from_value(json!({ "id": "1", "serial": "S", "kind": "motion", "state": true }))
                .unwrap();
        assert!(ev.title.is_none());
        assert!(ev.picture.is_none());
        assert_eq!(ev.device_name, "");
    }

    #[test]
    fn categorizes_kinds() {
        assert_eq!(Category::of("ring"), Category::Ring);
        assert_eq!(Category::of("motion"), Category::Motion);
        assert_eq!(Category::of("radar_motion"), Category::Motion);
        assert_eq!(Category::of("person"), Category::Person);
        assert_eq!(Category::of("stranger"), Category::Person);
        assert_eq!(Category::of("pet"), Category::Other);
        assert_eq!(Category::of("low_battery"), Category::Other);
        assert_eq!(Category::Other.open_reason(), None);
        assert_eq!(Category::Ring.open_reason(), Some("ring"));
    }

    #[test]
    fn defaults_notify_everything_and_popup_on_ring_only() {
        let s = Settings::default();
        assert_eq!(decide(&s, &event("ring", true)), Decision { notify: true, popup: true });
        assert_eq!(decide(&s, &event("motion", true)), Decision { notify: true, popup: false });
        assert_eq!(decide(&s, &event("person", true)), Decision { notify: true, popup: false });
        assert_eq!(decide(&s, &event("pet", true)), Decision { notify: true, popup: false });
    }

    #[test]
    fn ended_events_do_nothing() {
        let s = Settings::default();
        assert_eq!(decide(&s, &event("ring", false)), Decision::default());
    }

    #[test]
    fn notifications_disabled_still_allows_popup() {
        let mut s = Settings::default();
        s.notifications.enabled = false;
        s.popup.on_motion = true;
        assert_eq!(decide(&s, &event("ring", true)), Decision { notify: false, popup: true });
        assert_eq!(decide(&s, &event("motion", true)), Decision { notify: false, popup: true });
    }

    #[test]
    fn per_kind_toggles() {
        let mut s = Settings::default();
        s.notifications.motion = false;
        s.notifications.other = false;
        s.popup.on_person = true;
        assert_eq!(decide(&s, &event("radar_motion", true)), Decision { notify: false, popup: false });
        assert_eq!(decide(&s, &event("vehicle", true)), Decision { notify: false, popup: false });
        assert_eq!(decide(&s, &event("stranger", true)), Decision { notify: true, popup: true });
    }

    #[test]
    fn builds_title_and_body() {
        let mut ev = event("ring", true);
        assert_eq!(notification_title(&ev), "Front Door: Someone is at the door");
        assert_eq!(notification_body(&ev), "Someone is at the door");

        ev.title = Some("Doorbell pressed".into());
        ev.content = Some("Someone rang the Front Door".into());
        assert_eq!(notification_title(&ev), "Front Door: Doorbell pressed");
        assert_eq!(notification_body(&ev), "Someone rang the Front Door");

        let mut ev = event("person", true);
        ev.person_name = Some("Alice".into());
        assert_eq!(notification_title(&ev), "Front Door: Alice detected");
        assert_eq!(notification_body(&ev), "Person detected (Alice)");

        let mut ev = event("motion", true);
        ev.device_name = "".into();
        assert_eq!(notification_title(&ev), "Motion detected");
    }

    #[test]
    fn mime_to_extension_and_id_sanitizing() {
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("IMAGE/PNG"), "png");
        assert_eq!(extension_for_mime("application/octet-stream"), "img");
        assert_eq!(sanitize_id("abc-123_X"), "abc-123_X");
        assert_eq!(sanitize_id("../../etc/passwd"), "______etc_passwd");
        assert_eq!(sanitize_id(""), "event");
    }

    #[test]
    fn seen_set_dedups_and_is_bounded() {
        let mut seen = Seen::new(3);
        assert!(seen.insert("a"));
        assert!(!seen.insert("a"));
        assert!(seen.insert("b"));
        assert!(seen.insert("c"));
        assert!(seen.insert("d")); // evicts a
        assert!(seen.insert("a"));
        assert!(!seen.insert("d"));
    }

    #[test]
    fn recent_window() {
        let mut ev = event("ring", true);
        let now = 1_700_000_000_000.0;
        ev.timestamp = now - 10_000.0;
        assert!(is_recent(&ev, now));
        ev.timestamp = now - 120_000.0;
        assert!(!is_recent(&ev, now));
        ev.timestamp = 0.0;
        assert!(!is_recent(&ev, now));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "eufy-linux-test-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_event_image_and_prunes() {
        let dir = temp_dir("images");
        let mut ev = event("ring", true);
        ev.picture = Some(Picture {
            mime: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake"),
        });
        let path = write_event_image(&dir, &ev).unwrap();
        assert_eq!(path, dir.join("evt-ring.png"));
        assert_eq!(std::fs::read(&path).unwrap(), b"\x89PNG fake");

        // invalid base64 -> None, nothing written
        ev.id = "bad".into();
        ev.picture.as_mut().unwrap().data = "***".into();
        assert!(write_event_image(&dir, &ev).is_none());
        assert!(!dir.join("bad.png").exists());

        for i in 0..5 {
            std::fs::write(dir.join(format!("old{i}.jpg")), b"x").unwrap();
        }
        prune_images(&dir, 2);
        let left = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(left, 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
