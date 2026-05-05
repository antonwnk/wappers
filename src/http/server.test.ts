import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.js";
import { OutboxStore } from "../outbox/store.js";

// A hand-rolled SessionManager stub. We use only `.get()` and `.list()`, so we don't
// need to spin up a real Baileys socket — that would be hostile to a unit test.
function makeStubSession(overrides: Partial<{
  status: string;
  qr: string | null;
  selfJid: string | undefined;
  sendText: (to: string, text: string) => Promise<{ messageId: string; timestamp: string }>;
  requestPairingCode: (phone: string) => Promise<string>;
}> = {}) {
  return {
    id: "main",
    getStatus: () => overrides.status ?? "open",
    getQR: () => overrides.qr ?? null,
    getSelfJid: () => overrides.selfJid,
    sendText: overrides.sendText ?? (async () => ({ messageId: "msg-1", timestamp: "2026-05-04T12:00:00.000Z" })),
    requestPairingCode: overrides.requestPairingCode ?? (async () => "ABCD1234"),
  };
}

function makeStubManager(sessions: Record<string, ReturnType<typeof makeStubSession>>) {
  return {
    get: (id: string) => sessions[id] ?? undefined,
    list: () => Object.values(sessions).map((s) => ({ id: s.id, status: s.getStatus(), selfJid: s.getSelfJid(), startError: undefined })),
  };
}

describe("http server", () => {
  let dir: string;
  let store: OutboxStore;
  const TOKEN = "secret-bearer-token-1234";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wappers-http-"));
    store = new OutboxStore({ filePath: join(dir, "store.db") });
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  function app(opts?: { bearerToken?: string; sessions?: Record<string, ReturnType<typeof makeStubSession>> }) {
    const sessions = opts?.sessions ?? { main: makeStubSession() };
    return createApp({
      manager: makeStubManager(sessions) as never,
      store,
      port: 0,
      ...(opts?.bearerToken !== undefined ? { bearerToken: opts.bearerToken } : {}),
    });
  }

  const auth = { authorization: `Bearer ${TOKEN}` };

  it("GET /healthz is open and reports session + outbox state", async () => {
    const res = await app({ bearerToken: TOKEN }).request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.sessions).toHaveLength(1);
    expect(body.outbox).toEqual({ pending: 0, delivered: 0, dead: 0 });
  });

  it("rejects unauthenticated requests to /sessions/*", async () => {
    const res = await app({ bearerToken: TOKEN }).request("/sessions/main/qr");
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong bearer token", async () => {
    const res = await app({ bearerToken: TOKEN }).request("/sessions/main/qr", {
      headers: { authorization: "Bearer wrong-token-of-same-length-AAAA" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 503 on protected routes when no bearerToken is configured", async () => {
    // Open by accident is the worst outcome — refusing closed is the safe default.
    const res = await app({}).request("/sessions/main/qr");
    expect(res.status).toBe(503);
  });

  it("GET /sessions/:id/qr returns the latest QR string", async () => {
    const res = await app({
      bearerToken: TOKEN,
      sessions: { main: makeStubSession({ status: "connecting", qr: "raw-qr-data" }) },
    }).request("/sessions/main/qr", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "connecting", qr: "raw-qr-data", selfJid: null });
  });

  it("GET /sessions/:id/qr 404s for unknown session", async () => {
    const res = await app({ bearerToken: TOKEN }).request("/sessions/nope/qr", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("POST /sessions/:id/send delivers via Session.sendText", async () => {
    let captured: { to: string; text: string } | undefined;
    const sessions = {
      main: makeStubSession({
        sendText: async (to, text) => {
          captured = { to, text };
          return { messageId: "wamid.X", timestamp: "2026-05-04T12:00:00.000Z" };
        },
      }),
    };
    const res = await app({ bearerToken: TOKEN, sessions }).request("/sessions/main/send", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "12025551234", text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: "wamid.X", timestamp: "2026-05-04T12:00:00.000Z" });
    expect(captured).toEqual({ to: "12025551234", text: "hi" });
  });

  it("POST /sessions/:id/send 400s on invalid body", async () => {
    const res = await app({ bearerToken: TOKEN }).request("/sessions/main/send", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("validation failed");
    expect(body.issues).toBeInstanceOf(Array);
  });

  it("POST /sessions/:id/send 409s when Session throws (e.g. not connected)", async () => {
    const sessions = {
      main: makeStubSession({
        sendText: async () => {
          throw new Error("Session main is not connected (status=closed)");
        },
      }),
    };
    const res = await app({ bearerToken: TOKEN, sessions }).request("/sessions/main/send", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "1202", text: "hi" }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /sessions/:id/pair strips non-digits and returns the code", async () => {
    let captured = "";
    const sessions = {
      main: makeStubSession({
        requestPairingCode: async (phone) => {
          captured = phone;
          return "WXYZ7890";
        },
      }),
    };
    const res = await app({ bearerToken: TOKEN, sessions }).request("/sessions/main/pair", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "+1 (202) 555-1234" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "WXYZ7890" });
    expect(captured).toBe("12025551234");
  });

  it("media route is a 501 placeholder", async () => {
    const res = await app({ bearerToken: TOKEN }).request("/sessions/main/media/abc", { headers: auth });
    expect(res.status).toBe(501);
  });

  it("returns 400 when body is not JSON", async () => {
    const res = await app({ bearerToken: TOKEN }).request("/sessions/main/send", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("body must be JSON");
  });
});
