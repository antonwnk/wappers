import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { z } from "zod";
import type { Logger } from "pino";
import { loggerFor } from "../logger.js";
import type { SessionManager } from "../sessions/manager.js";
import type { OutboxStore } from "../outbox/store.js";

export interface HttpServerOptions {
  manager: SessionManager;
  store: OutboxStore;
  port: number;
  // When set, all routes except /healthz require `Authorization: Bearer <token>`.
  bearerToken?: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const SendBodySchema = z.object({
  to: z.string().min(1),
  text: z.string().min(1).max(65536),
});

const PairBodySchema = z.object({
  // Baileys wants digits only; we strip the rest before passing it on.
  phoneNumber: z.string().min(6).max(20),
});

export function createApp(opts: HttpServerOptions): Hono {
  const log = loggerFor("http");
  const app = new Hono();

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    log.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }, "request");
  });

  // Bearer auth — applied to everything except /healthz. If no token is configured we
  // refuse to expose mutating routes (better than silently being open by accident).
  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") return next();
    if (!opts.bearerToken) {
      return c.json({ error: "server has no bearerToken configured — refusing request" }, 503);
    }
    const header = c.req.header("authorization");
    const expected = `Bearer ${opts.bearerToken}`;
    if (!header || !timingSafeStringEqual(header, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      sessions: opts.manager.list(),
      outbox: opts.store.countByStatus(),
    });
  });

  app.get("/sessions/:id/qr", (c) => {
    const session = opts.manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return c.json({ status: session.getStatus(), qr: session.getQR(), selfJid: session.getSelfJid() ?? null });
  });

  app.post("/sessions/:id/pair", async (c) => {
    const session = opts.manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown session" }, 404);

    const parsed = await parseJson(c, PairBodySchema, log);
    if (!parsed.ok) return parsed.response;

    const digits = parsed.data.phoneNumber.replace(/[^0-9]/g, "");
    if (digits.length < 6) return c.json({ error: "phoneNumber must contain at least 6 digits" }, 400);

    try {
      const code = await session.requestPairingCode(digits);
      return c.json({ code });
    } catch (err) {
      log.warn({ err, sessionId: session.id }, "pairing code request failed");
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.post("/sessions/:id/send", async (c) => {
    const session = opts.manager.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown session" }, 404);

    const parsed = await parseJson(c, SendBodySchema, log);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await session.sendText(parsed.data.to, parsed.data.text);
      return c.json(result);
    } catch (err) {
      log.warn({ err, sessionId: session.id }, "send failed");
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  // Media download not yet implemented — needs a message cache to recover
  // Baileys' decryption keys for the encrypted media URL.
  app.get("/sessions/:id/media/:msgId", (c) => {
    return c.json({ error: "media download not implemented in v1" }, 501);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    log.error({ err, path: c.req.path }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<RunningServer> {
  const log = loggerFor("http");
  const app = createApp(opts);

  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port }, (info) => {
      log.info({ port: info.port }, "http server listening");
      // info.port reflects the actual bound port (matters when opts.port is 0).
      resolve({ server: s, port: info.port });
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ---- helpers --------------------------------------------------------------

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

async function parseJson<T>(c: Context, schema: z.ZodType<T>, log: Logger): Promise<ParseResult<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "body must be JSON" }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    log.debug({ issues: parsed.error.issues }, "request body failed validation");
    return {
      ok: false,
      response: c.json(
        {
          error: "validation failed",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

// Constant-time comparison for the bearer header so we don't leak token length / prefix
// via early-return timing.
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
