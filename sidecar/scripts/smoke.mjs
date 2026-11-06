// Starts the bridge (dist/index.js by default, or the binary given as argv[2]),
// waits for `READY <port>`, authenticates and sends bridge.ping + auth.status.
// Exits 0 when everything answers as expected.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const target = process.argv[2] ?? path.join(root, "dist/index.js");
const dataDir = process.env.SMOKE_DATA_DIR ?? mkdtempSync(path.join(os.tmpdir(), "eufy-bridge-smoke-"));
const token = "smoke-token";

const isJs = target.endsWith(".js");
const cmd = isJs ? process.execPath : target;
const args = [...(isJs ? [target] : []), "--port", "0", "--token", token, "--data-dir", dataDir, "--log-level", "debug"];
console.log(`$ ${cmd} ${args.join(" ")}`);
const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`  [bridge] ${d}`));

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  child.kill("SIGKILL");
  process.exit(1);
}
const timeout = setTimeout(() => fail("timed out"), 40000);

const port = await new Promise((resolve) => {
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/^READY (\d+)$/m);
    if (m) resolve(Number(m[1]));
  });
  child.on("exit", (code) => fail(`bridge exited early with code ${code}`));
});
console.log(`bridge printed READY ${port}`);

const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
let nextId = 1;
const pending = new Map();
ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.type === "result") pending.get(msg.id)?.(msg);
  else console.log(`event ${msg.event} ${JSON.stringify(msg.data).slice(0, 120)}`);
});
const call = (command, params) =>
  new Promise((resolve) => {
    const id = String(nextId++);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ type: "command", id, command, params }));
  });

const hello = await call("auth.hello", { token, client: "ui" });
console.log("auth.hello ->", JSON.stringify(hello));
if (!hello.ok || hello.result.protocol !== 1) fail("auth.hello did not succeed");
const ping = await call("bridge.ping");
console.log("bridge.ping ->", JSON.stringify(ping));
if (!ping.ok || ping.result.pong !== true) fail("bridge.ping did not answer pong");
const status = await call("auth.status");
console.log("auth.status ->", JSON.stringify(status));
if (!status.ok || status.result.state !== "logged_out") fail("unexpected auth.status");
const state = await call("state.get");
console.log("state.get ->", JSON.stringify(state));
const bad = await call("device.get", { serial: "nope" });
console.log("device.get (logged out) ->", JSON.stringify(bad));
if (bad.ok || bad.error.code !== "not_logged_in") fail("expected not_logged_in");

if (!process.env.SMOKE_NO_LOGIN) {
  // Exercise eufy-security-client's initialize() inside the bundle (protobuf/CA
  // assets, MQTT/push setup). No real account: we expect the connection attempt
  // to fail or still be pending; what matters is that nothing crashes and that
  // logout tears everything down again.
  const stderrLines = [];
  child.stderr.on("data", (d) => stderrLines.push(d.toString()));
  const statuses = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === "event" && msg.event === "auth.status") statuses.push(msg.data.state);
  });
  const login = await call("auth.login", { username: "smoke@example.invalid", password: "not-a-real-password" });
  console.log("auth.login ->", JSON.stringify(login));
  if (!login.ok) fail("auth.login was rejected");
  const until = Date.now() + Number(process.env.SMOKE_LOGIN_WAIT_MS ?? 12000);
  while (Date.now() < until && !statuses.some((s) => s !== "connecting")) await new Promise((r) => setTimeout(r, 200));
  const st = await call("auth.status");
  console.log(`auth.status after login probe -> ${JSON.stringify(st.result)} (seen: ${statuses.join(" > ") || "none"})`);
  if (!statuses.includes("connecting")) fail("expected auth.status connecting after login");
  // eufy-security-client logs "Error loading ... proto" / ENOENT on the .proto/.crt files when
  // the bundled assets are not where the rewritten __dirname points.
  const protoErrors = stderrLines.filter((l) => /(\.proto|\.crt|loading .*proto)/i.test(l) && /error|ENOENT/i.test(l));
  if (protoErrors.length) fail(`asset loading problems in bridge log: ${protoErrors.join("")}`);
  const logout = await call("auth.logout");
  console.log("auth.logout ->", JSON.stringify(logout));
  if (!logout.ok) fail("auth.logout failed");
  const after = await call("auth.status");
  if (after.result.state !== "logged_out") fail("expected logged_out after logout");
  if (existsSync(path.join(dataDir, "credentials.json"))) fail("credentials.json still present after logout");
  console.log("login probe OK (eufy-security-client initialized inside the bundle)");
}

ws.close();
clearTimeout(timeout);
const exitCode = await new Promise((resolve) => {
  child.removeAllListeners("exit");
  child.on("exit", (code) => resolve(code));
  child.kill("SIGTERM");
});
console.log(`bridge exited with code ${exitCode} after SIGTERM`);
if (exitCode !== 0) fail("non-zero exit code");
if (!process.env.SMOKE_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
console.log("SMOKE OK");
