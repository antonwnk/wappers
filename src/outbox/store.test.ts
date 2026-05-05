import { describe, it, expect, beforeEach } from "vitest";
import {
  OutboxStore,
  RETRY_DELAYS_MS,
  MAX_ATTEMPTS,
  nextDelayMs,
  type EnqueueInput,
} from "./store.js";

const FIXED_NOW = new Date("2026-05-04T12:00:00.000Z");
const T = (offsetMs: number): Date => new Date(FIXED_NOW.getTime() + offsetMs);

const sample: EnqueueInput = {
  sessionId: "main",
  webhookUrl: "https://example.com/hook",
  webhookSecret: "shhh",
  eventId: "evt_001",
  eventType: "message.received",
  payload: '{"hello":"world"}',
};

describe("nextDelayMs", () => {
  it("returns the documented schedule", () => {
    expect(nextDelayMs(1)).toBe(1_000);
    expect(nextDelayMs(2)).toBe(5_000);
    expect(nextDelayMs(3)).toBe(30_000);
    expect(nextDelayMs(4)).toBe(5 * 60_000);
    expect(nextDelayMs(5)).toBe(60 * 60_000);
    expect(nextDelayMs(6)).toBe(6 * 60 * 60_000);
  });

  it("returns null after the schedule is exhausted (attempt = MAX_ATTEMPTS)", () => {
    expect(nextDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(nextDelayMs(MAX_ATTEMPTS + 5)).toBeNull();
  });

  it("rejects attempt < 1", () => {
    expect(() => nextDelayMs(0)).toThrow();
    expect(() => nextDelayMs(-1)).toThrow();
  });

  it("schedule length matches MAX_ATTEMPTS - 1", () => {
    expect(RETRY_DELAYS_MS.length).toBe(MAX_ATTEMPTS - 1);
  });
});

describe("OutboxStore", () => {
  let store: OutboxStore;

  beforeEach(() => {
    store = new OutboxStore({ filePath: ":memory:" });
  });

  describe("enqueue", () => {
    it("inserts a new row and returns inserted=true", () => {
      const r = store.enqueue(sample, FIXED_NOW);
      expect(r.inserted).toBe(true);
      expect(r.id).toBeGreaterThan(0);

      const row = store.get(r.id)!;
      expect(row.status).toBe("pending");
      expect(row.attempt).toBe(0);
      expect(row.payload).toBe(sample.payload);
      expect(row.nextAttemptAt).toBe(FIXED_NOW.getTime());
      expect(row.createdAt).toBe(FIXED_NOW.getTime());
      expect(row.deliveredAt).toBeNull();
      expect(row.lastError).toBeNull();
    });

    it("is idempotent on (sessionId, eventId, webhookUrl)", () => {
      const a = store.enqueue(sample, FIXED_NOW);
      const b = store.enqueue(sample, T(60_000));
      expect(a.id).toBe(b.id);
      expect(a.inserted).toBe(true);
      expect(b.inserted).toBe(false);
      expect(store.countByStatus().pending).toBe(1);
    });

    it("treats different webhook URLs for the same event as separate deliveries", () => {
      const a = store.enqueue(sample, FIXED_NOW);
      const b = store.enqueue({ ...sample, webhookUrl: "https://other.example.com/hook" }, FIXED_NOW);
      expect(b.inserted).toBe(true);
      expect(b.id).not.toBe(a.id);
      expect(store.countByStatus().pending).toBe(2);
    });
  });

  describe("takePending", () => {
    it("returns due rows and pushes them out by the in-flight lease", () => {
      const r = store.enqueue(sample, FIXED_NOW);
      const taken = store.takePending(10, FIXED_NOW);
      expect(taken).toHaveLength(1);
      expect(taken[0]!.id).toBe(r.id);

      // Same row should NOT come back immediately — it's been leased.
      const again = store.takePending(10, FIXED_NOW);
      expect(again).toHaveLength(0);

      // Past the lease window, it reappears.
      const later = store.takePending(10, T(120_000));
      expect(later).toHaveLength(1);
    });

    it("does not pick rows whose next_attempt_at is in the future", () => {
      const r = store.enqueue(sample, T(60_000));
      const now = store.takePending(10, FIXED_NOW);
      expect(now).toHaveLength(0);
      const later = store.takePending(10, T(60_000));
      expect(later).toHaveLength(1);
      expect(later[0]!.id).toBe(r.id);
    });

    it("respects the limit and orders by next_attempt_at ASC", () => {
      store.enqueue({ ...sample, eventId: "a" }, T(0));
      store.enqueue({ ...sample, eventId: "b" }, T(-1));
      store.enqueue({ ...sample, eventId: "c" }, T(-2));
      const taken = store.takePending(2, FIXED_NOW);
      expect(taken.map((r) => r.eventId)).toEqual(["c", "b"]);
    });

    it("ignores delivered and dead rows", () => {
      const a = store.enqueue({ ...sample, eventId: "a" }, FIXED_NOW);
      const b = store.enqueue({ ...sample, eventId: "b" }, FIXED_NOW);
      store.markDelivered(a.id, FIXED_NOW);
      // Force b to dead by failing it MAX_ATTEMPTS times.
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        store.markFailed(b.id, "boom", FIXED_NOW);
      }
      expect(store.takePending(10, T(10 * 60 * 60_000))).toHaveLength(0);
    });
  });

  describe("markDelivered", () => {
    it("transitions to delivered and stamps delivered_at, clears last_error", () => {
      const r = store.enqueue(sample, FIXED_NOW);
      store.markFailed(r.id, "transient", FIXED_NOW);
      store.markDelivered(r.id, T(2_000));
      const row = store.get(r.id)!;
      expect(row.status).toBe("delivered");
      expect(row.deliveredAt).toBe(T(2_000).getTime());
      expect(row.lastError).toBeNull();
    });
  });

  describe("markFailed", () => {
    it("schedules the next attempt per the backoff schedule", () => {
      const r = store.enqueue(sample, FIXED_NOW);
      const result = store.markFailed(r.id, "500 internal", FIXED_NOW);
      expect(result.attempt).toBe(1);
      expect(result.status).toBe("pending");
      expect(result.nextAttemptAt).toBe(FIXED_NOW.getTime() + 1_000);

      const row = store.get(r.id)!;
      expect(row.attempt).toBe(1);
      expect(row.status).toBe("pending");
      expect(row.lastError).toBe("500 internal");
    });

    it("marks the row dead after MAX_ATTEMPTS failures", () => {
      const r = store.enqueue(sample, FIXED_NOW);
      let last;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        last = store.markFailed(r.id, "boom", FIXED_NOW);
      }
      expect(last!.status).toBe("dead");
      expect(last!.attempt).toBe(MAX_ATTEMPTS);
      const row = store.get(r.id)!;
      expect(row.status).toBe("dead");
    });

    it("throws on unknown id", () => {
      expect(() => store.markFailed(9999, "x", FIXED_NOW)).toThrow();
    });
  });

  describe("countByStatus", () => {
    it("returns zero for missing buckets", () => {
      expect(store.countByStatus()).toEqual({ pending: 0, delivered: 0, dead: 0 });
    });

    it("counts each status correctly", () => {
      const a = store.enqueue({ ...sample, eventId: "a" }, FIXED_NOW);
      const b = store.enqueue({ ...sample, eventId: "b" }, FIXED_NOW);
      store.enqueue({ ...sample, eventId: "c" }, FIXED_NOW);
      store.markDelivered(a.id, FIXED_NOW);
      for (let i = 0; i < MAX_ATTEMPTS; i++) store.markFailed(b.id, "x", FIXED_NOW);
      expect(store.countByStatus()).toEqual({ pending: 1, delivered: 1, dead: 1 });
    });
  });
});
