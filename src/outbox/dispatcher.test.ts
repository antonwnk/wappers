import { describe, it, expect, beforeEach, vi } from "vitest";
import { OutboxStore, MAX_ATTEMPTS } from "./store.js";
import { WebhookDispatcher, type SessionWebhookConfig } from "./dispatcher.js";
import { sign, SIGNATURE_HEADER } from "./sign.js";
import type { MessageReceivedEvent } from "../events/schema.js";

const NOW = new Date("2026-05-04T12:00:00.000Z");
const T = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const webhook: SessionWebhookConfig = {
  sessionId: "main",
  webhookUrl: "https://hooks.example.com/main",
  webhookSecret: "shhh",
};

function makeEvent(id = "evt_1"): MessageReceivedEvent {
  return {
    v: 1,
    type: "message.received",
    eventId: id,
    sessionId: "main",
    at: NOW.toISOString(),
    message: {
      id: "MSG_1",
      chatJid: "1@s.whatsapp.net",
      senderJid: "1@s.whatsapp.net",
      fromMe: false,
      timestamp: NOW.toISOString(),
      kind: "text",
      text: "hi",
    },
  };
}

interface FakeCall {
  url: string;
  init: RequestInit;
}

function makeFetch(handler: (call: FakeCall) => Response | Promise<Response>): {
  fn: typeof fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("WebhookDispatcher.enqueue", () => {
  it("enqueues a row with the JSON-stringified envelope as payload", () => {
    const store = new OutboxStore({ filePath: ":memory:" });
    const d = new WebhookDispatcher({ store, webhooks: [webhook], now: () => NOW });
    d.enqueue(makeEvent());
    const row = store.get(1)!;
    expect(JSON.parse(row.payload).eventId).toBe("evt_1");
    expect(row.eventType).toBe("message.received");
  });

  it("drops events for sessions with no configured webhook", () => {
    const store = new OutboxStore({ filePath: ":memory:" });
    const d = new WebhookDispatcher({ store, webhooks: [], now: () => NOW });
    d.enqueue(makeEvent());
    expect(store.countByStatus().pending).toBe(0);
  });

  it("is idempotent on (sessionId, eventId, webhookUrl)", () => {
    const store = new OutboxStore({ filePath: ":memory:" });
    const d = new WebhookDispatcher({ store, webhooks: [webhook], now: () => NOW });
    d.enqueue(makeEvent("dup"));
    d.enqueue(makeEvent("dup"));
    expect(store.countByStatus().pending).toBe(1);
  });
});

describe("WebhookDispatcher.tick", () => {
  let store: OutboxStore;
  beforeEach(() => {
    store = new OutboxStore({ filePath: ":memory:" });
  });

  it("POSTs the payload with a valid HMAC signature and marks delivered on 2xx", async () => {
    const { fn, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const d = new WebhookDispatcher({ store, webhooks: [webhook], fetchImpl: fn, now: () => NOW });
    d.enqueue(makeEvent());

    await d.tick();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(webhook.webhookUrl);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[SIGNATURE_HEADER]).toBe(sign(webhook.webhookSecret, call.init.body as string));
    expect(headers["x-bridge-event-id"]).toBe("evt_1");
    expect(headers["x-bridge-attempt"]).toBe("1");

    expect(store.countByStatus()).toEqual({ pending: 0, delivered: 1, dead: 0 });
  });

  it("marks the row failed and reschedules on a non-2xx response", async () => {
    const { fn } = makeFetch(() => new Response("oops", { status: 500 }));
    const d = new WebhookDispatcher({ store, webhooks: [webhook], fetchImpl: fn, now: () => NOW });
    d.enqueue(makeEvent());

    await d.tick();

    const row = store.get(1)!;
    expect(row.status).toBe("pending");
    expect(row.attempt).toBe(1);
    expect(row.lastError).toContain("HTTP 500");
    expect(row.nextAttemptAt).toBe(NOW.getTime() + 1_000);
  });

  it("eventually marks the row dead after MAX_ATTEMPTS failures", async () => {
    const { fn } = makeFetch(() => new Response("nope", { status: 500 }));
    let clock = NOW.getTime();
    const d = new WebhookDispatcher({
      store,
      webhooks: [webhook],
      fetchImpl: fn,
      now: () => new Date(clock),
    });
    d.enqueue(makeEvent());

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await d.tick();
      // jump past the scheduled retry window so the row becomes due again
      clock += 24 * 60 * 60_000;
    }

    expect(store.countByStatus()).toEqual({ pending: 0, delivered: 0, dead: 1 });
  });

  it("treats a fetch throw (network error) the same as a non-2xx", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const d = new WebhookDispatcher({ store, webhooks: [webhook], fetchImpl: fn, now: () => NOW });
    d.enqueue(makeEvent());
    await d.tick();
    const row = store.get(1)!;
    expect(row.attempt).toBe(1);
    expect(row.lastError).toContain("fetch failed");
  });

  it("aborts the request after requestTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const fn = ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as unknown as typeof fetch;
      const d = new WebhookDispatcher({
        store,
        webhooks: [webhook],
        fetchImpl: fn,
        requestTimeoutMs: 10,
        now: () => NOW,
      });
      d.enqueue(makeEvent());
      const tickPromise = d.tick();
      await vi.advanceTimersByTimeAsync(20);
      await tickPromise;
      const row = store.get(1)!;
      expect(row.attempt).toBe(1);
      expect(row.lastError?.toLowerCase()).toContain("abort");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WebhookDispatcher start/stop", () => {
  it("polls in the background and stops cleanly", async () => {
    const store = new OutboxStore({ filePath: ":memory:" });
    const { fn, calls } = makeFetch(() => new Response(null, { status: 200 }));
    const d = new WebhookDispatcher({
      store,
      webhooks: [webhook],
      fetchImpl: fn,
      pollIntervalMs: 10,
    });
    d.enqueue(makeEvent("a"));
    d.enqueue(makeEvent("b"));
    d.start();
    // give it a few poll cycles
    await new Promise((r) => setTimeout(r, 80));
    await d.stop();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(store.countByStatus()).toEqual({ pending: 0, delivered: 2, dead: 0 });
  });
});
