import { describe, it, expect } from "vitest";
import { sign, verify, SIGNATURE_HEADER } from "./sign.js";

describe("sign", () => {
  // Known vector — RFC 4231 test case 1 for HMAC-SHA256.
  // key = 0x0b * 20, data = "Hi There" → b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
  it("matches the canonical RFC 4231 test vector for HMAC-SHA256", () => {
    const key = Buffer.alloc(20, 0x0b).toString("binary");
    const out = sign(key, Buffer.from("Hi There"));
    expect(out).toBe("sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  it("is deterministic", () => {
    expect(sign("s", "payload")).toBe(sign("s", "payload"));
  });

  it("changes when secret changes", () => {
    expect(sign("a", "p")).not.toBe(sign("b", "p"));
  });

  it("changes when payload changes", () => {
    expect(sign("s", "p1")).not.toBe(sign("s", "p2"));
  });

  it("uses the documented header name", () => {
    expect(SIGNATURE_HEADER).toBe("x-bridge-signature");
  });
});

describe("verify", () => {
  const secret = "shhh";
  const payload = '{"hello":"world"}';

  it("accepts a valid signature", () => {
    const sig = sign(secret, payload);
    expect(verify(secret, payload, sig)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const sig = sign(secret, payload);
    expect(verify(secret, '{"hello":"WORLD"}', sig)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = sign("other", payload);
    expect(verify(secret, payload, sig)).toBe(false);
  });

  it("rejects null/undefined/empty header", () => {
    expect(verify(secret, payload, null)).toBe(false);
    expect(verify(secret, payload, undefined)).toBe(false);
    expect(verify(secret, payload, "")).toBe(false);
  });

  it("rejects a header with the wrong length without throwing", () => {
    expect(verify(secret, payload, "sha256=tooshort")).toBe(false);
  });
});
