# wappers

A small, stateless WhatsApp bridge. Maintains 2–10 long-lived [Baileys](https://github.com/WhiskeySockets/Baileys) connections and forwards every event to your webhook(s) as a versioned JSON envelope. Send messages back through a tiny HTTP API.

The bridge contains **no business logic** — downstream consumers (LLM bots, CRM sync, analytics) implement their own behavior. This keeps the bridge small and rarely-redeployed while letting many use cases be built in parallel as independent apps.

## Why a bridge

- **Baileys can't run on serverless.** It's a long-lived WebSocket client decrypting Signal-protocol messages locally. It needs a persistent process — a small VPS or your laptop, not Vercel Functions.
- **You probably want more than one consumer.** Building business logic into the bridge couples every use case to one deploy. Bridging out via webhook lets each consumer (Next.js on Vercel, a Python script, n8n, …) ship on its own cadence.
- **Baileys ships breaking changes regularly.** This bridge owns a versioned event schema (`v: 1`) so upgrading Baileys is our problem, not your consumers'.

## Stack

Node 22, TypeScript strict. `baileys` for WhatsApp, `hono` + `@hono/node-server` for HTTP, `better-sqlite3` for the outbox, `pino` for logs, `zod` for validation. SQLite + the filesystem are the only storage; no Postgres, no Redis.

## Quickstart (local)

```sh
pnpm install
cp config.example.yaml config.yaml          # edit it
export BRIDGE_API_TOKEN=$(openssl rand -hex 16)
export WEBHOOK_SECRET_MAIN=$(openssl rand -hex 16)
pnpm dev
```

A QR code appears in the terminal — scan it from WhatsApp on your phone (Settings → Linked Devices → Link a Device). Once "session connected" is logged you're live.

Prefer a pairing code over QR (e.g. on a headless VPS):

```sh
curl -H "Authorization: Bearer $BRIDGE_API_TOKEN" \
     -H "content-type: application/json" \
     -d '{"phoneNumber":"+1 202 555 1234"}' \
     http://localhost:3000/sessions/main/pair
# → {"code":"ABCD-1234"}   (enter on the phone)
```

## Config

`config.yaml` (validated by zod at boot — invalid config refuses to start):

```yaml
dataDir: ./data                   # auth state + outbox sqlite live here
http:
  port: 3000
  bearerToken: ${BRIDGE_API_TOKEN}  # required for /sessions/* routes
sessions:
  - id: main
    webhookUrl: https://your-consumer.example.com/whatsapp
    webhookSecret: ${WEBHOOK_SECRET_MAIN}
  - id: support
    webhookUrl: https://your-crm.example.com/whatsapp
    webhookSecret: ${WEBHOOK_SECRET_SUPPORT}
```

Env interpolation: `${VAR}` (required) and `${VAR:-default}` (optional). Empty strings count as missing — boot fails loudly rather than silently shipping `webhookUrl: undefined`.

## HTTP API

All `/sessions/*` routes require `Authorization: Bearer <http.bearerToken>`. `/healthz` is open.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/healthz` | — | `{ ok, sessions[], outbox: { pending, delivered, dead } }` |
| `GET` | `/sessions/:id/qr` | — | `{ status, qr, selfJid }` |
| `POST` | `/sessions/:id/pair` | `{ phoneNumber }` | `{ code }` |
| `POST` | `/sessions/:id/send` | `{ to, text }` | `{ messageId, timestamp }` |
| `GET` | `/sessions/:id/media/:msgId` | — | `501` (not implemented in v1) |

`to` accepts a JID (`<digits>@s.whatsapp.net` or `<id>@g.us`) or a bare phone number — non-digits are stripped.

## Webhook contract

Every event POSTs to your `webhookUrl` with these headers:

```
content-type: application/json
x-bridge-signature: sha256=<hex hmac of body using webhookSecret>
x-bridge-event-id: <stable hash; safe for idempotency>
x-bridge-event-type: message.received | message.sent | message.reaction | connection.update
x-bridge-session-id: main
x-bridge-delivery-id: <unique per attempt>
x-bridge-attempt: 1
```

Verify the signature server-side:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", SECRET).update(rawBody).digest("hex");
const sig = req.headers["x-bridge-signature"];
if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(401).end();
```

**Body shape** — see `src/events/schema.ts` for the canonical zod schema. Example:

```json
{
  "v": 1,
  "type": "message.received",
  "eventId": "a1b2c3d4e5f60718",
  "sessionId": "main",
  "at": "2026-05-05T10:23:11.123Z",
  "message": {
    "id": "wamid.HBgNMTIw...",
    "chatJid": "12025551234@s.whatsapp.net",
    "senderJid": "12025551234@s.whatsapp.net",
    "fromMe": false,
    "timestamp": 1730800991,
    "kind": "text",
    "text": "hello"
  }
}
```

**Delivery semantics:** at-least-once. The bridge retries non-2xx responses with exponential backoff (1s, 5s, 30s, 5m, 1h, 6h) up to 7 attempts before marking the row `dead`. Use `eventId` to dedupe — it's a stable hash of `(sessionId, messageId, type)`.

**On shutdown** (`SIGTERM`): the bridge drains in-flight attempts but does not block on rows whose `next_attempt_at` is in the future — those persist to SQLite and resume on next start. So upgrades don't lose events.

## Deploy with Docker

```sh
docker build -t wappers .
docker run -d --name wappers \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config.yaml:/app/config.yaml:ro \
  -e BRIDGE_API_TOKEN=$BRIDGE_API_TOKEN \
  -e WEBHOOK_SECRET_MAIN=$WEBHOOK_SECRET_MAIN \
  wappers
```

`./data` holds Baileys auth state (per-session) and the outbox sqlite — back it up. The container runs as non-root (uid 1000); `chown -R 1000:1000 ./data` if you hit permission errors.

## Scripts

| Command | What |
|---|---|
| `pnpm dev` | Hot-reload (`tsx watch`) |
| `pnpm build` | Compile to `dist/` |
| `pnpm test` | Vitest, including a real-socket HTTP integration test |
| `pnpm typecheck` | `tsc --noEmit` |
| `node scripts/echo-server.mjs [port]` | HMAC-verifying webhook receiver for local dev (set `BRIDGE_WEBHOOK_SECRET`) |
| `./scripts/smoke.sh` | Interactive end-to-end smoke (needs a phone with WhatsApp) |

## v1 scope cuts (explicit non-goals)

- No web UI / dashboard — inspect with `sqlite3 data/store.db`.
- No media download yet (`/sessions/:id/media/:msgId` returns 501). WhatsApp media is end-to-end encrypted: the `WAMessage` proto carries the per-message AES key + a URL to the encrypted blob on WhatsApp's CDN. To serve a download later we need to cache the proto (a few hundred bytes per message — keys + URL, not the blob) so Baileys can fetch from the CDN, decrypt on the fly, and stream the result through. The bridge would be a decryption proxy; the encrypted bytes never land on our disk.
- No `replyTo` on `/send` — Baileys' `quoted` needs the full original message; the bridge is stateless for now.
- No metrics export — structured pino logs only.
- No multi-tenant auth, no scheduled sending, no group-admin operations beyond receiving group messages.

## Inspecting state

```sh
sqlite3 data/store.db 'SELECT status, COUNT(*) FROM outbox GROUP BY status'
sqlite3 data/store.db 'SELECT id, attempt, status, last_error FROM outbox WHERE status != "delivered" ORDER BY id DESC LIMIT 20'
```
