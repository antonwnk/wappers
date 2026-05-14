import { createHash, randomUUID } from "node:crypto";
import qrcode from "qrcode-terminal";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  isJidGroup,
  type ConnectionState,
  type WAMessage,
  type proto,
} from "baileys";
import type { Logger } from "pino";
import { loggerFor } from "../logger.js";
import { normalizeMessage } from "../events/normalize.js";
import type { WhatsAppEvent, ConnectionUpdateEvent } from "../events/schema.js";
import { loadAuthStore } from "./auth-store.js";

export interface SessionConfig {
  id: string;
  // Root data dir; auth state is persisted under <dataDir>/sessions/<id>/.
  dataDir: string;
}

export type EventSink = (event: WhatsAppEvent) => void | Promise<void>;

export interface SessionStartOptions {
  onEvent: EventSink;
  // Lets the normalizer attach a lazy media-download URL to media events.
  // Will be wired to the bridge HTTP server in a later step.
  mediaUrlFor?: (messageId: string, chatJid: string) => string | null;
}

export type SessionStatus = "idle" | "connecting" | "open" | "closed" | "logged-out";

type WASocket = ReturnType<typeof makeWASocket>;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class Session {
  readonly id: string;
  private cfg: SessionConfig;
  private log: Logger;
  private sock: WASocket | undefined;
  private opts: SessionStartOptions | undefined;
  private latestQR: string | null = null;
  private status: SessionStatus = "idle";
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(cfg: SessionConfig) {
    this.id = cfg.id;
    this.cfg = cfg;
    this.log = loggerFor(`session:${cfg.id}`);
  }

  async start(opts: SessionStartOptions): Promise<void> {
    if (this.status !== "idle" && this.status !== "closed") {
      throw new Error(`Session ${this.id} already started (status=${this.status})`);
    }
    this.opts = opts;
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.sock?.end(undefined);
    } catch (err) {
      this.log.warn({ err }, "error ending socket on stop");
    }
    this.status = "closed";
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getQR(): string | null {
    return this.latestQR;
  }

  getSelfJid(): string | undefined {
    const raw = this.sock?.user?.id;
    return raw ? jidNormalizedUser(raw) : undefined;
  }

  async sendText(to: string, text: string): Promise<{ messageId: string; timestamp: string }> {
    const sock = this.requireOpen();
    const jid = ensureJid(to);
    const sent = await sock.sendMessage(jid, { text });
    if (!sent?.key?.id) throw new Error("send: no message id returned by Baileys");
    return { messageId: sent.key.id, timestamp: new Date().toISOString() };
  }

  // Headless pairing via 8-char code shown on the phone (no QR scan needed).
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) throw new Error(`Session ${this.id}: call start() before requesting a pairing code`);
    return this.sock.requestPairingCode(phoneNumber);
  }

  // ---- internals --------------------------------------------------------

  private requireOpen(): WASocket {
    if (!this.sock || this.status !== "open") {
      throw new Error(`Session ${this.id} is not connected (status=${this.status})`);
    }
    return this.sock;
  }

  private async connect(): Promise<void> {
    this.status = "connecting";
    const { state, saveCreds } = await loadAuthStore(this.cfg.dataDir, this.id);
    const { version } = await fetchLatestBaileysVersion();
    this.log.info({ waVersion: version.join(".") }, "connecting to WhatsApp");

    const sock = makeWASocket({
      version,
      auth: state,
      // Baileys uses its own pino-compatible logger interface; structurally identical at runtime.
      logger: loggerFor(`baileys:${this.id}`) as never,
      browser: Browsers.appropriate("Chrome"),
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false, // don't broadcast our presence to contacts
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u) => {
      this.onConnectionUpdate(u).catch((err) => this.log.error({ err }, "connection.update handler threw"));
    });
    sock.ev.on("messages.upsert", (u) => {
      this.onMessagesUpsert(u).catch((err) => this.log.error({ err }, "messages.upsert handler threw"));
    });
  }

  private async onConnectionUpdate(u: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      this.latestQR = qr;
      this.log.info("scan QR below to link this session");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      this.status = "open";
      this.reconnectAttempts = 0;
      this.latestQR = null;
      this.log.info({ jid: this.getSelfJid() }, "session connected");
      await this.emitConnection("open");
      return;
    }

    if (connection === "connecting") {
      this.status = "connecting";
      await this.emitConnection("connecting");
      return;
    }

    if (connection === "close") {
      const code = extractStatusCode(lastDisconnect?.error);
      const reason = code !== undefined ? statusCodeName(code) : "unknown";
      const loggedOut = code === DisconnectReason.loggedOut;

      this.status = loggedOut ? "logged-out" : "closed";
      await this.emitConnection("close", reason);

      if (this.stopped) {
        this.log.info("session stopped, not reconnecting");
        return;
      }
      if (loggedOut) {
        this.log.warn("session logged out — re-pairing required, not reconnecting");
        return;
      }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const exp = Math.min(this.reconnectAttempts, 5);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exp);
    this.log.info({ attempt: this.reconnectAttempts, delayMs: delay }, "scheduling reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => this.log.error({ err }, "reconnect failed"));
    }, delay);
  }

  private async onMessagesUpsert(u: { messages: WAMessage[]; type: "append" | "notify" | "prepend" }): Promise<void> {
    // 'notify' = real-time new message. 'append' / 'prepend' = historical sync we asked Baileys to skip.
    if (u.type !== "notify") return;

    // selfJid may be undefined during a startup/reconnect race. Normalize handles that
    // per-message: incoming messages still go through, only outgoing ones that need
    // selfJid for attribution are skipped (returns null). Dropping the whole batch
    // here would lose inbound messages permanently — they can't be replayed.
    const selfJid = this.getSelfJid();

    for (const raw of u.messages) {
      try {
        const ev = normalizeMessage(raw as proto.IWebMessageInfo, {
          sessionId: this.id,
          ...(selfJid ? { selfJid } : {}),
          ...(this.opts?.mediaUrlFor ? { mediaUrlFor: this.opts.mediaUrlFor } : {}),
        });
        if (ev) await this.deliver(ev);
      } catch (err) {
        this.log.error({ err, messageId: raw.key?.id }, "failed to normalize message");
      }
    }
  }

  private async emitConnection(state: "connecting" | "open" | "close", reason?: string): Promise<void> {
    const at = new Date().toISOString();
    const ev: ConnectionUpdateEvent = {
      v: 1,
      type: "connection.update",
      eventId: shortHash(`${this.id}:connection:${state}:${at}:${randomUUID()}`),
      sessionId: this.id,
      at,
      state,
      ...(reason ? { reason } : {}),
    };
    await this.deliver(ev);
  }

  private async deliver(ev: WhatsAppEvent): Promise<void> {
    if (!this.opts) return;
    try {
      await this.opts.onEvent(ev);
    } catch (err) {
      this.log.error({ err, type: ev.type, eventId: ev.eventId }, "event sink threw");
    }
  }
}

// ---- module helpers -------------------------------------------------------

function ensureJid(to: string): string {
  // Already a JID? Use as-is.
  if (to.includes("@")) return to;
  // Bare phone number (digits only) → user JID.
  const digits = to.replace(/[^0-9]/g, "");
  if (!digits) throw new Error(`invalid recipient: ${to}`);
  return `${digits}@s.whatsapp.net`;
}

function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const output = (err as { output?: { statusCode?: unknown } }).output;
  return typeof output?.statusCode === "number" ? output.statusCode : undefined;
}

function statusCodeName(code: number): string {
  const name = (Object.entries(DisconnectReason) as Array<[string, number]>).find(([, v]) => v === code)?.[0];
  return name ?? String(code);
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// re-export so callers don't have to depend on baileys directly
export { isJidGroup };
