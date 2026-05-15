// Tiny webhook echo server for manual smoke testing the bridge.
// Usage: node scripts/echo-server.mjs [port]
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.argv[2] ?? 4000);
const SECRET = process.env.BRIDGE_WEBHOOK_SECRET ?? "test-secret";

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const sig = req.headers["x-bridge-signature"];
    const expected = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    const valid =
      typeof sig === "string" &&
      sig.length === expected.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    const tag = valid ? "[ok]" : "[BAD SIG]";
    const meta = {
      eventId: req.headers["x-bridge-event-id"],
      type: req.headers["x-bridge-event-type"],
      sessionId: req.headers["x-bridge-session-id"],
      attempt: req.headers["x-bridge-attempt"],
    };
    console.log(tag, meta, body.slice(0, 400));
    res.writeHead(204);
    res.end();
  });
}).listen(PORT, () => console.log(`echo server listening on http://127.0.0.1:${PORT}`));
