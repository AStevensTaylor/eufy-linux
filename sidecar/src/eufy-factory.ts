/**
 * The only module that touches eufy-security-client directly.
 */
import type { EufyConfig, EufyFactory, EufyLike } from "./eufy-types.ts";
import type { Logger } from "./log.ts";
import { formatArg } from "./log.ts";

export function realEufyFactory(log: Logger): EufyFactory {
  const eufyLog = log.child("eufy");
  const fmt = (message: unknown, args: unknown[]) =>
    args.length ? `${formatArg(message)} ${args.map(formatArg).join(" ")}` : formatArg(message);
  const adapter = {
    trace: (m: unknown, ...a: unknown[]) => eufyLog.debug(fmt(m, a)),
    debug: (m: unknown, ...a: unknown[]) => eufyLog.debug(fmt(m, a)),
    info: (m: unknown, ...a: unknown[]) => eufyLog.info(fmt(m, a)),
    warn: (m: unknown, ...a: unknown[]) => eufyLog.warn(fmt(m, a)),
    error: (m: unknown, ...a: unknown[]) => eufyLog.error(fmt(m, a)),
    fatal: (m: unknown, ...a: unknown[]) => eufyLog.error(fmt(m, a)),
  };
  return async (config: EufyConfig): Promise<EufyLike> => {
    const { EufySecurity } = await import("eufy-security-client");
    // eufy-security-client's typings are slightly narrower than EufyLike (events are typed);
    // structurally it satisfies everything the bridge needs.
    const instance = await EufySecurity.initialize(config as never, adapter);
    return instance as unknown as EufyLike;
  };
}
