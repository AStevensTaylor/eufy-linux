import { Bridge } from "./bridge.ts";
import { parseCli, USAGE } from "./cli.ts";
import { materializeAssets } from "./eufy-assets.ts";
import { realEufyFactory } from "./eufy-factory.ts";
import { Logger } from "./log.ts";
import { BridgeServer } from "./server.ts";

declare const __BRIDGE_VERSION__: string | undefined;

const VERSION = typeof __BRIDGE_VERSION__ === "string" ? __BRIDGE_VERSION__ : "0.0.0-dev";

async function main(): Promise<void> {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!opts.token) {
    process.stderr.write("error: --token is required\n\n" + USAGE);
    process.exit(2);
  }

  const log = new Logger(opts.logLevel);
  log.info(`eufy-bridge ${VERSION} starting (node ${process.versions.node}${process.versions.bun ? `, bun ${process.versions.bun}` : ""})`);

  process.on("uncaughtException", (err) => log.error("uncaught exception", err));
  process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));

  const assetDir = await materializeAssets(opts.dataDir);
  if (assetDir) log.debug(`eufy assets at ${assetDir}`);

  const bridge = new Bridge({ dataDir: opts.dataDir, log, createEufy: realEufyFactory(log), version: VERSION });
  log.addSink((level, message) => {
    if (level === "warn" || level === "error") bridge.broadcast("bridge.log", { level, message });
  });
  const server = new BridgeServer({ bridge, token: opts.token, log });
  const port = await server.listen(opts.port);
  process.stdout.write(`READY ${port}\n`);
  log.info(`listening on ws://127.0.0.1:${port}/ (data dir ${opts.dataDir})`);

  await bridge.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => {
      log.warn("shutdown timed out, exiting");
      process.exit(0);
    }, 4000);
    force.unref();
    Promise.resolve()
      .then(() => bridge.shutdown())
      .then(() => server.close())
      .catch((err) => log.error("error during shutdown", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  // If the parent (Tauri) dies and our stdout goes away, exit as well.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") shutdown("EPIPE");
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
