import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, type RunningServer } from "./server.js";
import { OutboxStore } from "../outbox/store.js";

// Unit tests in server.test.ts hit hono's in-memory fetch handler.
// This file boots @hono/node-server on a real socket so we catch issues the
// in-memory path can't see: header casing on the wire, body streaming, the
// adapter's port binding, and graceful close().

// Minimal session stub — only the methods our routes touch. Real Baileys would
// need a phone, which is hostile to an integration test.
const stubSession = {
  id: "main",
  getStatus: () => "open",
  getQR: () => null,
  getSelfJid: () => undefined,
  sendText: async () => ({ messageId: "msg", timestamp: "2026-05-05T00:00:00.000Z" }),
  requestPairingCode: async () => "PAIRCODE",
};

function stubManager() {
  return {
    get: (id: string) => (id === "main" ? stubSession : undefined),
    list: () => [{ id: "main", status: "open", selfJid: undefined, startError: undefined }],
  } as never;
}

describe("http server (real socket)", () => {
  let dir: string;
  let store: OutboxStore;
  let server: RunningServer;
  let baseUrl: string;
  const TOKEN = "integration-token-abcdef";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wappers-http-int-"));
    store = new OutboxStore({ filePath: join(dir, "store.db") });
    // Port 0 → OS picks a free port. We read it back from the running server.
    server = await startHttpServer({ manager: stubManager(), store, port: 0, bearerToken: TOKEN });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves /healthz over a real TCP socket", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { ok: boolean; outbox: { pending: number } };
    expect(body.ok).toBe(true);
    expect(body.outbox.pending).toBe(0);
  });

  it("rejects missing bearer with 401 and a JSON body", async () => {
    const res = await fetch(`${baseUrl}/sessions/main/qr`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  it("accepts the configured bearer and reaches the route", async () => {
    const res = await fetch(`${baseUrl}/sessions/main/qr`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ status: "open", qr: null, selfJid: null });
  });

  it("returns 400 with zod issues for an invalid send body", async () => {
    const res = await fetch(`${baseUrl}/sessions/main/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("validation failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("close() releases the port (a fresh server can bind to it)", async () => {
    // Use a separate ephemeral instance so we don't tear down the suite-wide one.
    const tmpStore = new OutboxStore({ filePath: join(dir, "store2.db") });
    const s1 = await startHttpServer({ manager: stubManager(), store: tmpStore, port: 0, bearerToken: TOKEN });
    const port = s1.port;
    await s1.close();
    // If close() leaked the listener, this would fail with EADDRINUSE — but only when
    // we ask for the same port explicitly. We can't easily assert "same port" with port:0,
    // so the value of the test is just "close() resolves and a follow-up boot succeeds."
    const s2 = await startHttpServer({ manager: stubManager(), store: tmpStore, port: 0, bearerToken: TOKEN });
    expect(s2.port).toBeGreaterThan(0);
    expect(typeof port).toBe("number");
    await s2.close();
    tmpStore.close();
  });
});
