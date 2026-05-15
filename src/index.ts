import { rootLogger, loggerFor } from "./logger.js";
import { loadConfig, ConfigError } from "./config.js";
import { SessionManager } from "./sessions/manager.js";
import { OutboxStore } from "./outbox/store.js";
import { WebhookDispatcher, type SessionWebhookConfig } from "./outbox/dispatcher.js";
import { startHttpServer } from "./http/server.js";

const log = loggerFor("entry");

const CONFIG_PATH = process.env["BRIDGE_CONFIG"] ?? "./config.yaml";

async function main(): Promise<void> {
  const cfg = await loadConfig(CONFIG_PATH);
  log.info({ sessions: cfg.sessions.map((s) => s.id), dataDir: cfg.dataDir }, "config loaded");

  const store = new OutboxStore({ filePath: `${cfg.dataDir}/store.db` });

  const webhooks: SessionWebhookConfig[] = cfg.sessions.map((s) => ({
    sessionId: s.id,
    webhookUrl: s.webhookUrl,
    webhookSecret: s.webhookSecret,
  }));
  const dispatcher = new WebhookDispatcher({ store, webhooks });
  dispatcher.start();

  // Webhook payloads include this URL so consumers can fetch media lazily through the bridge.
  // The /media route returns 501 until the message cache lands; URL shape stays stable.
  const publicBase = (process.env["BRIDGE_PUBLIC_BASE_URL"] ?? `http://localhost:${cfg.http.port}`).replace(/\/$/, "");
  const manager = new SessionManager({
    sessions: cfg.sessions,
    dataDir: cfg.dataDir,
    sink: dispatcher.sink(),
    mediaUrlFor: (sessionId, messageId, chatJid) =>
      `${publicBase}/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(messageId)}?chat=${encodeURIComponent(chatJid)}`,
  });
  await manager.start();

  const httpOpts: Parameters<typeof startHttpServer>[0] = {
    manager,
    store,
    port: cfg.http.port,
    ...(cfg.http.bearerToken ? { bearerToken: cfg.http.bearerToken } : {}),
  };
  const httpServer = await startHttpServer(httpOpts);
  if (!cfg.http.bearerToken) {
    log.warn("http.bearerToken is unset — /sessions/* routes will refuse all requests until configured");
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal, pending: store.countByStatus().pending, sessions: manager.list() }, "shutting down");
    await httpServer.close().catch((err) => log.warn({ err }, "error closing http server"));
    await manager.stop();
    await dispatcher.drain();
    await dispatcher.stop();
    store.close();
    log.info("clean exit");
    await new Promise((r) => setTimeout(r, 50));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    rootLogger.fatal({ msg: err.message }, "invalid config — refusing to start");
  } else {
    rootLogger.fatal({ err }, "fatal error during startup");
  }
  process.exit(1);
});
