import type { Logger } from "pino";
import { loggerFor } from "../logger.js";
import type { WhatsAppEvent } from "../events/schema.js";
import type { EventSink } from "../sessions/session.js";
import { OutboxStore, type DeliveryRow } from "./store.js";
import { sign, SIGNATURE_HEADER } from "./sign.js";

export interface SessionWebhookConfig {
  sessionId: string;
  webhookUrl: string;
  webhookSecret: string;
}

export interface DispatcherOptions {
  store: OutboxStore;
  webhooks: SessionWebhookConfig[];
  pollIntervalMs?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: Logger;
}

const DEFAULTS = {
  pollIntervalMs: 250,
  batchSize: 16,
  requestTimeoutMs: 10_000,
} as const;

// Wires Session events to the SQLite outbox and runs a polling worker that POSTs
// pending deliveries with HMAC signatures, retrying with exponential backoff.
export class WebhookDispatcher {
  private store: OutboxStore;
  private webhookBySession: Map<string, SessionWebhookConfig>;
  private pollIntervalMs: number;
  private batchSize: number;
  private requestTimeoutMs: number;
  private fetchImpl: typeof fetch;
  private now: () => Date;
  private log: Logger;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private currentTick: Promise<number> | undefined;

  constructor(opts: DispatcherOptions) {
    this.store = opts.store;
    this.webhookBySession = new Map(opts.webhooks.map((w) => [w.sessionId, w]));
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.batchSize = opts.batchSize ?? DEFAULTS.batchSize;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? loggerFor("dispatcher");
  }

  // EventSink to plug into Session.start({ onEvent }).
  sink(): EventSink {
    return (event: WhatsAppEvent) => this.enqueue(event);
  }

  enqueue(event: WhatsAppEvent): void {
    const cfg = this.webhookBySession.get(event.sessionId);
    if (!cfg) {
      this.log.warn({ sessionId: event.sessionId, type: event.type }, "no webhook configured for session — dropping event");
      return;
    }
    const payload = JSON.stringify(event);
    const r = this.store.enqueue(
      {
        sessionId: event.sessionId,
        webhookUrl: cfg.webhookUrl,
        webhookSecret: cfg.webhookSecret,
        eventId: event.eventId,
        eventType: event.type,
        payload,
      },
      this.now(),
    );
    if (!r.inserted) {
      this.log.debug({ eventId: event.eventId, sessionId: event.sessionId }, "duplicate event — skipped");
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.scheduleNext(0);
  }

  // Stops the loop and waits for any in-flight tick to finish. Pending rows stay in the store.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.currentTick) await this.currentTick;
    this.running = false;
  }

  // Drains the queue by running ticks back-to-back until nothing is currently due.
  // If a downstream is offline at shutdown, we leave its rows in the store for the
  // next start — drain doesn't block forever waiting on a broken consumer.
  async drain(maxIterations = 100): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const processed = await this.tick();
      if (processed === 0) return;
    }
    this.log.warn("drain stopped after maxIterations — outbox may still have due rows");
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.currentTick = this.tick().finally(() => {
        this.scheduleNext(this.pollIntervalMs);
      });
    }, delayMs);
  }

  // Exposed for tests: takes one batch, delivers each row sequentially.
  // Returns the number of rows attempted (0 when nothing is currently due).
  async tick(): Promise<number> {
    let rows: DeliveryRow[];
    try {
      rows = this.store.takePending(this.batchSize, this.now());
    } catch (err) {
      this.log.error({ err }, "takePending failed");
      return 0;
    }
    for (const row of rows) {
      await this.deliver(row);
    }
    return rows.length;
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    const signature = sign(row.webhookSecret, row.payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signature,
      "x-bridge-event-id": row.eventId,
      "x-bridge-event-type": row.eventType,
      "x-bridge-session-id": row.sessionId,
      "x-bridge-delivery-id": String(row.id),
      "x-bridge-attempt": String(row.attempt + 1),
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(row.webhookUrl, {
        method: "POST",
        headers,
        body: row.payload,
        signal: ac.signal,
      });
      if (res.ok) {
        this.store.markDelivered(row.id, this.now());
        this.log.debug({ id: row.id, status: res.status, eventId: row.eventId }, "delivered");
        return;
      }
      const bodyPreview = await safeReadBodyPreview(res);
      const reason = `HTTP ${res.status} ${res.statusText}${bodyPreview ? ` — ${bodyPreview}` : ""}`;
      const result = this.store.markFailed(row.id, reason, this.now());
      this.log.warn({ id: row.id, attempt: result.attempt, status: result.status, reason }, "delivery failed");
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const result = this.store.markFailed(row.id, reason, this.now());
      this.log.warn({ id: row.id, attempt: result.attempt, status: result.status, reason }, "delivery threw");
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeReadBodyPreview(res: Response, max = 200): Promise<string> {
  try {
    const text = await res.text();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return "";
  }
}
