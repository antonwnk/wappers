import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-bridge-signature";
const SCHEME = "sha256";

// Returns "sha256=<lowercase-hex>". Stable, simple, and easy for any consumer to verify.
export function sign(secret: string, payload: string | Buffer): string {
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `${SCHEME}=${hex}`;
}

// Constant-time compare so consumers can't fingerprint our verification code with timing attacks.
// (Useful only when consumers also use this helper, but harmless for our own ingest endpoints.)
export function verify(secret: string, payload: string | Buffer, header: string | undefined | null): boolean {
  if (!header) return false;
  const expected = sign(secret, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
