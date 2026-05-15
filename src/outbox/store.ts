import Database, { type Database as DB } from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type DeliveryStatus = "pending" | "delivered" | "dead";

export interface EnqueueInput {
  sessionId: string;
  webhookUrl: string;
  webhookSecret: string;
  eventId: string;
  eventType: string;
  payload: string;
}

export interface DeliveryRow {
  id: number;
  sessionId: string;
  webhookUrl: string;
  webhookSecret: string;
  eventId: string;
  eventType: string;
  payload: string;
  attempt: number;
  status: DeliveryStatus;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

// Plan-specified backoff: 1s, 5s, 30s, 5m, 1h, 6h, then dead (7th failure).
export const RETRY_DELAYS_MS: readonly number[] = [
  1_000,
  5_000,
  30_000,
  5 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

// While a row is in flight, hide it from takePending for this long so a stuck/crashed
// dispatcher's row eventually becomes visible again (at-least-once semantics).
const IN_FLIGHT_LEASE_MS = 60_000;

export interface OutboxStoreOptions {
  filePath: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    webhook_url     TEXT    NOT NULL,
    webhook_secret  TEXT    NOT NULL,
    event_id        TEXT    NOT NULL,
    event_type      TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    attempt         INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'pending',
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    delivered_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS outbox_status_next
    ON outbox(status, next_attempt_at);
  CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedup
    ON outbox(session_id, event_id, webhook_url);
`;

export class OutboxStore {
  private db: DB;

  constructor(opts: OutboxStoreOptions) {
    if (opts.filePath !== ":memory:") {
      mkdirSync(dirname(opts.filePath), { recursive: true });
    }
    this.db = new Database(opts.filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  enqueue(input: EnqueueInput, now: Date = new Date()): { inserted: boolean; id: number } {
    const ts = now.getTime();
    const stmt = this.db.prepare(`
      INSERT INTO outbox (session_id, webhook_url, webhook_secret, event_id, event_type, payload, next_attempt_at, created_at)
      VALUES (@sessionId, @webhookUrl, @webhookSecret, @eventId, @eventType, @payload, @ts, @ts)
      ON CONFLICT(session_id, event_id, webhook_url) DO NOTHING
      RETURNING id
    `);
    const row = stmt.get({ ...input, ts }) as { id: number } | undefined;
    if (row) return { inserted: true, id: row.id };

    const existing = this.db
      .prepare(`SELECT id FROM outbox WHERE session_id=? AND event_id=? AND webhook_url=?`)
      .get(input.sessionId, input.eventId, input.webhookUrl) as { id: number };
    return { inserted: false, id: existing.id };
  }

  takePending(limit: number, now: Date = new Date()): DeliveryRow[] {
    const ts = now.getTime();
    const lease = ts + IN_FLIGHT_LEASE_MS;
    const select = this.db.prepare<[number, number]>(`
      SELECT id FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, id ASC
      LIMIT ?
    `);
    const update = this.db.prepare<[number, number]>(`UPDATE outbox SET next_attempt_at = ? WHERE id = ?`);
    const fetch = this.db.prepare<[number]>(`SELECT * FROM outbox WHERE id = ?`);

    const claim = this.db.transaction((nowTs: number, leaseTs: number, lim: number): DeliveryRow[] => {
      const ids = (select.all(nowTs, lim) as Array<{ id: number }>).map((r) => r.id);
      const out: DeliveryRow[] = [];
      for (const id of ids) {
        update.run(leaseTs, id);
        const r = fetch.get(id) as RawRow;
        out.push(toDeliveryRow(r));
      }
      return out;
    });

    return claim(ts, lease, limit);
  }

  markDelivered(id: number, now: Date = new Date()): void {
    this.db
      .prepare(`UPDATE outbox SET status='delivered', delivered_at=?, last_error=NULL WHERE id=?`)
      .run(now.getTime(), id);
  }

  markFailed(id: number, error: string, now: Date = new Date()): { attempt: number; status: DeliveryStatus; nextAttemptAt: number } {
    const row = this.db.prepare<[number]>(`SELECT attempt FROM outbox WHERE id=?`).get(id) as { attempt: number } | undefined;
    if (!row) throw new Error(`outbox row ${id} not found`);
    const newAttempt = row.attempt + 1;
    const delay = nextDelayMs(newAttempt);
    if (delay === null) {
      this.db
        .prepare(`UPDATE outbox SET status='dead', attempt=?, last_error=? WHERE id=?`)
        .run(newAttempt, error, id);
      return { attempt: newAttempt, status: "dead", nextAttemptAt: 0 };
    }
    const nextAttemptAt = now.getTime() + delay;
    this.db
      .prepare(`UPDATE outbox SET attempt=?, last_error=?, next_attempt_at=?, status='pending' WHERE id=?`)
      .run(newAttempt, error, nextAttemptAt, id);
    return { attempt: newAttempt, status: "pending", nextAttemptAt };
  }

  countByStatus(): Record<DeliveryStatus, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) as n FROM outbox GROUP BY status`).all() as Array<{
      status: DeliveryStatus;
      n: number;
    }>;
    const out: Record<DeliveryStatus, number> = { pending: 0, delivered: 0, dead: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  get(id: number): DeliveryRow | null {
    const row = this.db.prepare<[number]>(`SELECT * FROM outbox WHERE id=?`).get(id) as RawRow | undefined;
    return row ? toDeliveryRow(row) : null;
  }

  close(): void {
    this.db.close();
  }
}

// Delay in ms for the next retry after a given failure count (1-indexed).
// Returns null when retries are exhausted (caller should mark the row dead).
export function nextDelayMs(attempt: number): number | null {
  if (attempt < 1) throw new Error("attempt must be >= 1");
  const idx = attempt - 1;
  return idx < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[idx]! : null;
}

interface RawRow {
  id: number;
  session_id: string;
  webhook_url: string;
  webhook_secret: string;
  event_id: string;
  event_type: string;
  payload: string;
  attempt: number;
  status: DeliveryStatus;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
}

function toDeliveryRow(r: RawRow): DeliveryRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    webhookUrl: r.webhook_url,
    webhookSecret: r.webhook_secret,
    eventId: r.event_id,
    eventType: r.event_type,
    payload: r.payload,
    attempt: r.attempt,
    status: r.status,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}
