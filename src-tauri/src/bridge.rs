//! Sidecar supervisor: picks a free port and a random token, spawns the bridge
//! (`binaries/eufy-bridge` sidecar in release builds, `node sidecar/dist/index.js`
//! in dev), waits for `READY <port>` on stdout, forwards stderr to the log and
//! restarts the process with exponential backoff when it exits.
//!
//! Every status change is emitted to the webview as a `bridge-status` event
//! whose payload has the same shape as the `get_bridge_info` command result.

use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent, TerminatedPayload},
};
use tokio::sync::{Notify, watch};

/// Name of the Tauri event emitted on every bridge status change.
pub const STATUS_EVENT: &str = "bridge-status";
/// Sidecar name as declared in `tauri.conf.json` (`bundle.externalBin`).
pub const SIDECAR: &str = "binaries/eufy-bridge";
/// Sub directory of the app data dir handed to the bridge as `--data-dir`.
pub const DATA_SUBDIR: &str = "bridge";

const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A run longer than this resets the backoff: the bridge was healthy.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// How long we wait for `READY` before giving up on a spawned process.
const READY_TIMEOUT: Duration = Duration::from_secs(45);
/// Grace period between SIGTERM and SIGKILL at shutdown.
const TERM_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeStatus {
    Starting,
    Ready,
    Failed,
}

/// Payload of `get_bridge_info` and of the `bridge-status` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub status: BridgeStatus,
    pub url: Option<String>,
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl BridgeInfo {
    fn starting(message: Option<String>) -> Self {
        Self {
            status: BridgeStatus::Starting,
            url: None,
            token: None,
            message,
        }
    }

    fn ready(endpoint: &Endpoint) -> Self {
        Self {
            status: BridgeStatus::Ready,
            url: Some(endpoint.url.clone()),
            token: Some(endpoint.token.clone()),
            message: None,
        }
    }

    fn failed(message: String) -> Self {
        Self {
            status: BridgeStatus::Failed,
            url: None,
            token: None,
            message: Some(message),
        }
    }
}

/// Where a ready bridge listens, and the token that authenticates to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
}

/// Supervisor state, managed by Tauri (`app.state::<Bridge>()`).
pub struct Bridge {
    info: Mutex<BridgeInfo>,
    child: Mutex<Option<CommandChild>>,
    running: AtomicBool,
    quitting: AtomicBool,
    restart_requested: AtomicBool,
    wake: Notify,
    endpoint_tx: watch::Sender<Option<Endpoint>>,
}

impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}

impl Bridge {
    pub fn new() -> Self {
        let (endpoint_tx, _) = watch::channel(None);
        Self {
            info: Mutex::new(BridgeInfo::starting(None)),
            child: Mutex::new(None),
            running: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            restart_requested: AtomicBool::new(false),
            wake: Notify::new(),
            endpoint_tx,
        }
    }

    /// Current status, as returned by `get_bridge_info`.
    pub fn info(&self) -> BridgeInfo {
        self.info.lock().expect("bridge info poisoned").clone()
    }

    /// A receiver that yields the bridge endpoint whenever it becomes ready
    /// (`Some`) or goes away (`None`).
    pub fn subscribe(&self) -> watch::Receiver<Option<Endpoint>> {
        self.endpoint_tx.subscribe()
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn set_info<R: Runtime>(&self, app: &AppHandle<R>, info: BridgeInfo) {
        log::info!(
            "bridge status: {:?}{}",
            info.status,
            info.message
                .as_deref()
                .map(|m| format!(" ({m})"))
                .unwrap_or_default()
        );
        *self.info.lock().expect("bridge info poisoned") = info.clone();
        if let Err(err) = app.emit(STATUS_EVENT, info) {
            log::warn!("cannot emit {STATUS_EVENT}: {err}");
        }
    }

    /// Kills the current bridge process (if any) so the supervisor spawns a
    /// fresh one immediately, without backoff.
    pub fn restart(&self) {
        if self.is_quitting() {
            return;
        }
        log::info!("bridge restart requested");
        self.restart_requested.store(true, Ordering::SeqCst);
        let child = self.child.lock().expect("bridge child poisoned").take();
        match child {
            // Killing it makes the supervisor loop respawn at once.
            Some(child) => {
                if let Err(err) = child.kill() {
                    log::warn!("cannot kill bridge: {err}");
                }
            }
            // No process: the supervisor is in its backoff sleep, cut it short.
            None => self.wake.notify_one(),
        }
    }

    /// Stops supervising and terminates the bridge. Safe to call more than
    /// once; blocks for at most [`TERM_GRACE`].
    pub fn shutdown(&self) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        self.wake.notify_one();
        let child = self.child.lock().expect("bridge child poisoned").take();
        let Some(child) = child else {
            return;
        };
        let pid = child.pid();
        log::info!("stopping bridge (pid {pid})");
        // Ask nicely first: the bridge closes its eufy connections on SIGTERM.
        let termed = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if termed {
            let deadline = Instant::now() + TERM_GRACE;
            while self.running.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        if self.running.load(Ordering::SeqCst) {
            log::warn!("bridge did not exit after SIGTERM; killing it");
            if let Err(err) = child.kill() {
                log::warn!("cannot kill bridge: {err}");
            }
        }
    }
}

/// Starts the supervisor loop on the Tauri async runtime.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move { supervise(app).await });
}

async fn supervise<R: Runtime>(app: AppHandle<R>) {
    let bridge = app.state::<Bridge>();
    let mut backoff = MIN_BACKOFF;

    while !bridge.is_quitting() {
        bridge.restart_requested.store(false, Ordering::SeqCst);
        bridge.set_info(&app, BridgeInfo::starting(None));

        let outcome = match prepare_launch(&app) {
            Ok(launch) => run_once(&app, &bridge, launch).await,
            Err(err) => RunOutcome {
                was_ready: false,
                message: err,
                duration: Duration::ZERO,
            },
        };

        bridge.endpoint_tx.send_replace(None);
        bridge.child.lock().expect("bridge child poisoned").take();
        if bridge.is_quitting() {
            break;
        }

        if outcome.was_ready && outcome.duration >= HEALTHY_RUN {
            backoff = MIN_BACKOFF;
        }
        if bridge.restart_requested.swap(false, Ordering::SeqCst) {
            backoff = MIN_BACKOFF;
            continue;
        }

        bridge.set_info(
            &app,
            BridgeInfo::failed(format!(
                "{}; restarting in {}s",
                outcome.message,
                backoff.as_secs()
            )),
        );
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = bridge.wake.notified() => {}
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
    bridge.set_info(&app, BridgeInfo::failed("shutting down".into()));
}

struct RunOutcome {
    was_ready: bool,
    message: String,
    duration: Duration,
}

/// Spawns one bridge process and pumps its output until it exits.
async fn run_once<R: Runtime>(app: &AppHandle<R>, bridge: &Bridge, launch: Launch) -> RunOutcome {
    let started = Instant::now();
    let token = launch.token.clone();
    let (mut rx, child) = match spawn(app, &launch) {
        Ok(spawned) => spawned,
        Err(err) => {
            return RunOutcome {
                was_ready: false,
                message: format!("cannot start bridge: {err}"),
                duration: Duration::ZERO,
            };
        }
    };
    let pid = child.pid();
    bridge.running.store(true, Ordering::SeqCst);
    *bridge.child.lock().expect("bridge child poisoned") = Some(child);
    if bridge.is_quitting() {
        // shutdown() raced with us: it saw no child, so terminate here.
        if let Some(child) = bridge.child.lock().expect("bridge child poisoned").take() {
            let _ = child.kill();
        }
    }
    log::info!(
        "bridge spawned (pid {pid}), expecting it on port {}",
        launch.port
    );

    let mut was_ready = false;
    let mut message = String::from("bridge output ended");
    loop {
        let event = if was_ready {
            rx.recv().await
        } else {
            match tokio::time::timeout(READY_TIMEOUT, rx.recv()).await {
                Ok(event) => event,
                Err(_) => {
                    log::warn!("bridge did not report READY within {READY_TIMEOUT:?}");
                    if let Some(child) = bridge.child.lock().expect("bridge child poisoned").take()
                    {
                        let _ = child.kill();
                    }
                    message = "bridge did not become ready in time".into();
                    // drain until Terminated so the process is reaped
                    while let Some(event) = rx.recv().await {
                        if matches!(event, CommandEvent::Terminated(_)) {
                            break;
                        }
                    }
                    break;
                }
            }
        };
        let Some(event) = event else { break };
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim();
                if let Some(port) = parse_ready_line(line) {
                    let endpoint = Endpoint {
                        url: format!("ws://127.0.0.1:{port}/"),
                        token: token.clone(),
                    };
                    if port != launch.port {
                        log::warn!(
                            "bridge listens on {port}, not the requested {}",
                            launch.port
                        );
                    }
                    was_ready = true;
                    bridge.set_info(app, BridgeInfo::ready(&endpoint));
                    bridge.endpoint_tx.send_replace(Some(endpoint));
                } else if !line.is_empty() {
                    log::info!(target: "bridge", "{line}");
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim_end();
                if !line.is_empty() {
                    log::info!(target: "bridge", "{line}");
                }
            }
            CommandEvent::Error(err) => log::warn!("bridge io error: {err}"),
            CommandEvent::Terminated(payload) => {
                message = describe_exit(&payload);
                break;
            }
            _ => {}
        }
    }
    bridge.running.store(false, Ordering::SeqCst);
    log::warn!("{message}");
    RunOutcome {
        was_ready,
        message,
        duration: started.elapsed(),
    }
}

/// Everything needed to spawn one bridge process.
struct Launch {
    port: u16,
    token: String,
    data_dir: PathBuf,
    /// `Some(script)` to run `node <script>` instead of the sidecar binary.
    dev_script: Option<PathBuf>,
}

fn prepare_launch<R: Runtime>(app: &AppHandle<R>) -> Result<Launch, String> {
    let port = pick_free_port().map_err(|e| format!("cannot pick a free port: {e}"))?;
    let token = generate_token();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?
        .join(DATA_SUBDIR);
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("cannot create {}: {e}", data_dir.display()))?;
    Ok(Launch {
        port,
        token,
        data_dir,
        dev_script: dev_script_path(),
    })
}

type Spawned = (tauri::async_runtime::Receiver<CommandEvent>, CommandChild);

fn spawn<R: Runtime>(app: &AppHandle<R>, launch: &Launch) -> Result<Spawned, String> {
    let args = bridge_args(launch.port, &launch.token, &launch.data_dir);
    let command = match &launch.dev_script {
        Some(script) => {
            let node = find_node();
            log::info!(
                "dev mode: running bridge as {} {}",
                node.display(),
                script.display()
            );
            app.shell()
                .command(&node)
                .args([script.as_os_str().to_os_string()])
                .args(args)
        }
        None => app
            .shell()
            .sidecar(SIDECAR)
            .map_err(|e| format!("sidecar {SIDECAR} unavailable: {e}"))?
            .args(args),
    };
    command.spawn().map_err(|e| e.to_string())
}

/// Command line handed to the bridge (see PROTOCOL.md, "Sidecar process contract").
pub fn bridge_args(port: u16, token: &str, data_dir: &Path) -> Vec<String> {
    vec![
        "--port".into(),
        port.to_string(),
        "--token".into(),
        token.to_string(),
        "--data-dir".into(),
        data_dir.to_string_lossy().into_owned(),
    ]
}

/// Parses the bridge's readiness line (`READY <port>`), returning the port.
pub fn parse_ready_line(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "READY" {
        return None;
    }
    let port = parts.next()?.parse::<u16>().ok()?;
    if parts.next().is_some() || port == 0 {
        return None;
    }
    Some(port)
}

fn describe_exit(payload: &TerminatedPayload) -> String {
    match (payload.code, payload.signal) {
        (Some(code), _) => format!("bridge exited with code {code}"),
        (None, Some(signal)) => format!("bridge was killed by signal {signal}"),
        (None, None) => "bridge exited".to_string(),
    }
}

/// Asks the kernel for a free loopback port.
pub fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// 32 random bytes, hex encoded (64 characters).
pub fn generate_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

/// Whether to run the bridge with node from the repo instead of the sidecar:
/// `EUFY_BRIDGE_DEV=1` forces it, `EUFY_BRIDGE_DEV=0` disables it, otherwise
/// it follows the build profile (dev in debug builds).
pub fn dev_mode_enabled() -> bool {
    dev_mode_from(
        std::env::var("EUFY_BRIDGE_DEV").ok().as_deref(),
        cfg!(debug_assertions),
    )
}

fn dev_mode_from(env_value: Option<&str>, debug_build: bool) -> bool {
    match env_value.map(str::trim) {
        Some("") | None => debug_build,
        Some("0") | Some("false") | Some("no") => false,
        Some(_) => true,
    }
}

/// Path of `sidecar/dist/index.js` when dev mode applies and it exists.
/// `EUFY_BRIDGE_SCRIPT` overrides the location.
fn dev_script_path() -> Option<PathBuf> {
    if !dev_mode_enabled() {
        return None;
    }
    let script = std::env::var_os("EUFY_BRIDGE_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("sidecar")
                .join("dist")
                .join("index.js")
        });
    if script.is_file() {
        Some(script)
    } else {
        log::warn!(
            "dev mode but {} does not exist (build the sidecar with `pnpm --filter sidecar build`); using the sidecar binary",
            script.display()
        );
        None
    }
}

/// Node executable for dev mode: `/opt/node24/bin/node` when present, else
/// `node` from PATH. `EUFY_NODE` overrides it.
fn find_node() -> PathBuf {
    if let Some(node) = std::env::var_os("EUFY_NODE") {
        return PathBuf::from(node);
    }
    let preferred = Path::new("/opt/node24/bin/node");
    if preferred.is_file() {
        return preferred.to_path_buf();
    }
    PathBuf::from("node")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_line() {
        assert_eq!(parse_ready_line("READY 43121"), Some(43121));
        assert_eq!(parse_ready_line("  READY 8080 \r\n"), Some(8080));
        assert_eq!(parse_ready_line("READY\t65535"), Some(65535));
    }

    #[test]
    fn rejects_non_ready_lines() {
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("ready 1234"), None);
        assert_eq!(parse_ready_line("READY"), None);
        assert_eq!(parse_ready_line("READY abc"), None);
        assert_eq!(parse_ready_line("READY 0"), None);
        assert_eq!(parse_ready_line("READY 70000"), None);
        assert_eq!(parse_ready_line("READY 1234 extra"), None);
        assert_eq!(parse_ready_line("listening READY 1234"), None);
    }

    #[test]
    fn token_is_64_hex_chars_and_random() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_ne!(a, b);
    }

    #[test]
    fn hex_encodes() {
        assert_eq!(hex(&[0x00, 0x0f, 0xf0, 0xff]), "000ff0ff");
    }

    #[test]
    fn free_port_is_bindable() {
        let port = pick_free_port().unwrap();
        assert!(port > 0);
        TcpListener::bind(("127.0.0.1", port)).expect("port should be free");
    }

    #[test]
    fn builds_bridge_args_in_contract_order() {
        let args = bridge_args(4242, "abc", Path::new("/data/bridge"));
        assert_eq!(
            args,
            vec![
                "--port",
                "4242",
                "--token",
                "abc",
                "--data-dir",
                "/data/bridge"
            ]
        );
    }

    #[test]
    fn dev_mode_env_overrides_profile() {
        assert!(dev_mode_from(None, true));
        assert!(!dev_mode_from(None, false));
        assert!(dev_mode_from(Some("1"), false));
        assert!(dev_mode_from(Some("yes"), false));
        assert!(!dev_mode_from(Some("0"), true));
        assert!(!dev_mode_from(Some("false"), true));
        assert!(dev_mode_from(Some(""), true));
        assert!(!dev_mode_from(Some(" "), false));
    }

    #[test]
    fn describes_exit() {
        assert_eq!(
            describe_exit(&TerminatedPayload {
                code: Some(1),
                signal: None
            }),
            "bridge exited with code 1"
        );
        assert_eq!(
            describe_exit(&TerminatedPayload {
                code: None,
                signal: Some(15)
            }),
            "bridge was killed by signal 15"
        );
    }

    #[test]
    fn bridge_info_serializes_to_contract_shape() {
        let v = serde_json::to_value(BridgeInfo::ready(&Endpoint {
            url: "ws://127.0.0.1:1/".into(),
            token: "t".into(),
        }))
        .unwrap();
        assert_eq!(v["status"], "ready");
        assert_eq!(v["url"], "ws://127.0.0.1:1/");
        assert_eq!(v["token"], "t");
        assert!(v.get("message").is_none());

        let v = serde_json::to_value(BridgeInfo::failed("boom".into())).unwrap();
        assert_eq!(v["status"], "failed");
        assert_eq!(v["url"], serde_json::Value::Null);
        assert_eq!(v["token"], serde_json::Value::Null);
        assert_eq!(v["message"], "boom");

        let v = serde_json::to_value(BridgeInfo::starting(None)).unwrap();
        assert_eq!(v["status"], "starting");
    }
}
