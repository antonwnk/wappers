import type { Logger } from "pino";
import { loggerFor } from "../logger.js";
import { Session, type EventSink, type SessionStatus } from "./session.js";
import type { SessionConfigEntry } from "../config.js";

export interface SessionManagerOptions {
  sessions: SessionConfigEntry[];
  dataDir: string;
  // Sink applied to every session's events. Typically WebhookDispatcher.sink().
  sink: EventSink;
  // Optional media-URL builder, applied to every session. Receives the sessionId so
  // the same callback can serve all sessions and emit per-session URLs.
  mediaUrlFor?: (sessionId: string, messageId: string, chatJid: string) => string | null;
}

export interface SessionInfo {
  id: string;
  status: SessionStatus | "failed-to-start";
  selfJid: string | undefined;
  startError: string | undefined;
}

// Supervises a fixed set of WhatsApp sessions defined in config.
// Failures during start() in one session do not prevent the others from starting.
export class SessionManager {
  private sessions = new Map<string, Session>();
  private startErrors = new Map<string, Error>();
  private opts: SessionManagerOptions;
  private log: Logger;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    this.log = loggerFor("manager");
  }

  // Starts all configured sessions in parallel. Resolves once every session has either
  // entered its connect loop or recorded a start error. Never throws.
  async start(): Promise<void> {
    this.log.info({ count: this.opts.sessions.length }, "starting sessions");
    await Promise.all(this.opts.sessions.map((cfg) => this.startOne(cfg)));
    const failed = this.startErrors.size;
    const ok = this.sessions.size - failed;
    this.log.info({ ok, failed }, "session manager ready");
  }

  private async startOne(cfg: SessionConfigEntry): Promise<void> {
    const session = new Session({ id: cfg.id, dataDir: this.opts.dataDir });
    this.sessions.set(cfg.id, session);
    try {
      const mediaUrlFor = this.opts.mediaUrlFor;
      await session.start({
        onEvent: this.opts.sink,
        ...(mediaUrlFor ? { mediaUrlFor: (msgId, chat) => mediaUrlFor(cfg.id, msgId, chat) } : {}),
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.startErrors.set(cfg.id, e);
      this.log.error({ err: e, sessionId: cfg.id }, "session failed to start — others continue");
    }
  }

  // Stops all sessions in parallel; never throws.
  async stop(): Promise<void> {
    this.log.info("stopping all sessions");
    await Promise.all(
      [...this.sessions.values()].map((s) =>
        s.stop().catch((err) => this.log.warn({ err, sessionId: s.id }, "error stopping session")),
      ),
    );
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => {
      const startErr = this.startErrors.get(s.id);
      return {
        id: s.id,
        status: startErr ? "failed-to-start" : s.getStatus(),
        selfJid: s.getSelfJid(),
        startError: startErr?.message,
      };
    });
  }
}
