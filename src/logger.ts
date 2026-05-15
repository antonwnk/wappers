import { pino, transport, destination, type Logger } from "pino";

const isDev = process.env["NODE_ENV"] !== "production";

// Shared logger. Baileys also accepts a pino instance via socket option `logger`,
// so we hand it a child with `mod: "baileys"` to keep its noise namespaced.
export const rootLogger: Logger = pino(
  {
    level: process.env["LOG_LEVEL"] ?? (isDev ? "debug" : "info"),
    base: null, // drop pid + hostname; we don't need them locally
  },
  isDev
    ? transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", singleLine: false },
      })
    : destination(1),
);

export function loggerFor(mod: string): Logger {
  return rootLogger.child({ mod });
}
