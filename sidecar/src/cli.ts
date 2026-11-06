import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";
import { parseLogLevel } from "./log.ts";
import type { LogLevel } from "./protocol.ts";

export type CliOptions = {
  port: number;
  token: string;
  dataDir: string;
  logLevel: LogLevel;
  help: boolean;
};

export const USAGE = `Usage: eufy-bridge --port <port> --token <token> --data-dir <dir> [--log-level debug|info|warn|error]

  --port       TCP port to bind on 127.0.0.1 (0 = pick a free port)
  --token      shared secret clients must present in auth.hello
  --data-dir   directory for credentials, eufy persistent data and pictures
  --log-level  stderr log level (default: info, or $EUFY_BRIDGE_LOG_LEVEL)
`;

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p" },
      token: { type: "string", short: "t" },
      "data-dir": { type: "string", short: "d" },
      "log-level": { type: "string", short: "l" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const portRaw = values.port ?? process.env.EUFY_BRIDGE_PORT ?? "0";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${portRaw}`);
  const token = values.token ?? process.env.EUFY_BRIDGE_TOKEN ?? "";
  const dataDir = path.resolve(values["data-dir"] ?? process.env.EUFY_BRIDGE_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "eufy-linux"));
  return {
    port,
    token,
    dataDir,
    logLevel: parseLogLevel(values["log-level"] ?? process.env.EUFY_BRIDGE_LOG_LEVEL, "info"),
    help: values.help === true,
  };
}
