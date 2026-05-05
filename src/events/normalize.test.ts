import { describe, it, expect } from "vitest";
import type { proto } from "baileys";
import { normalizeMessage, type NormalizeContext } from "./normalize.js";
import { WhatsAppEventSchema } from "./schema.js";

// Fixed clock + JIDs make every assertion deterministic.
const SELF_JID = "111111111@s.whatsapp.net";
const PEER_JID = "222222222@s.whatsapp.net";
const GROUP_JID = "999999999@g.us";
const NOW = new Date("2026-05-04T12:00:00.000Z");

const ctx: NormalizeContext = {
  sessionId: "main",
  selfJid: SELF_JID,
  now: () => NOW,
  mediaUrlFor: (msgId, chatJid) =>
    `https://bridge.example.com/sessions/main/media/${encodeURIComponent(chatJid)}/${msgId}`,
};

// ---- Helpers ---------------------------------------------------------------

function makeRaw(opts: {
  id?: string;
  remoteJid?: string;
  fromMe?: boolean;
  participant?: string;
  // unix seconds, like Baileys provides
  messageTimestamp?: number;
  message: proto.IMessage;
}): proto.IWebMessageInfo {
  return {
    key: {
      id: opts.id ?? "MSG_TEST_001",
      remoteJid: opts.remoteJid ?? PEER_JID,
      fromMe: opts.fromMe ?? false,
      participant: opts.participant,
    },
    messageTimestamp: opts.messageTimestamp ?? Math.floor(NOW.getTime() / 1000),
    message: opts.message,
  } as proto.IWebMessageInfo;
}

// All normalized outputs MUST round-trip through the public zod schema.
function expectValidEnvelope(out: unknown): asserts out is NonNullable<ReturnType<typeof normalizeMessage>> {
  expect(out).not.toBeNull();
  const parsed = WhatsAppEventSchema.safeParse(out);
  if (!parsed.success) {
    throw new Error(`Envelope failed schema validation: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
}

// ---- Common envelope behavior ---------------------------------------------

describe("normalizeMessage — envelope", () => {
  it("emits a message.received event for incoming text", () => {
    const raw = makeRaw({ message: { conversation: "hello" } });
    const out = normalizeMessage(raw, ctx);
    expectValidEnvelope(out);
    expect(out.type).toBe("message.received");
    expect(out.v).toBe(1);
    expect(out.sessionId).toBe("main");
    expect(out.at).toBe(NOW.toISOString());
  });

  it("emits a message.sent event when the message is fromMe", () => {
    const raw = makeRaw({ fromMe: true, message: { conversation: "hi back" } });
    const out = normalizeMessage(raw, ctx);
    expectValidEnvelope(out);
    expect(out.type).toBe("message.sent");
    expect(out.message.fromMe).toBe(true);
  });

  it("derives a stable, deterministic eventId from sessionId + message id + type", () => {
    const raw = makeRaw({ id: "ABC123", message: { conversation: "x" } });
    const a = normalizeMessage(raw, ctx);
    const b = normalizeMessage(raw, ctx);
    expectValidEnvelope(a);
    expectValidEnvelope(b);
    expect(a.eventId).toBe(b.eventId);
    expect(a.eventId.length).toBeGreaterThan(8);
  });

  it("converts unix-second messageTimestamp to ISO string", () => {
    const raw = makeRaw({
      messageTimestamp: 1_746_360_000, // 2025-05-04T12:00:00Z
      message: { conversation: "x" },
    });
    const out = normalizeMessage(raw, ctx);
    expectValidEnvelope(out);
    expect(out.message.timestamp).toBe("2025-05-04T12:00:00.000Z");
  });
});

// ---- Per-kind normalization -----------------------------------------------

describe("normalizeMessage — message kinds", () => {
  it("plain text via `conversation`", () => {
    const out = normalizeMessage(makeRaw({ message: { conversation: "hello" } }), ctx);
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("text");
    expect(out.message.text).toBe("hello");
  });

  it("text via `extendedTextMessage` (link previews, replies)", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          extendedTextMessage: {
            text: "check this out",
            contextInfo: { stanzaId: "QUOTED_ID" },
          },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("text");
    expect(out.message.text).toBe("check this out");
    expect(out.message.quotedMessageId).toBe("QUOTED_ID");
  });

  it("imageMessage with caption + dimensions", () => {
    const out = normalizeMessage(
      makeRaw({
        id: "IMG_1",
        message: {
          imageMessage: {
            caption: "look at this",
            mimetype: "image/jpeg",
            fileLength: 12345,
            width: 1080,
            height: 1920,
          },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("image");
    expect(out.message.text).toBe("look at this"); // caption surfaces as text
    expect(out.message.media).toEqual({
      mimeType: "image/jpeg",
      size: 12345,
      width: 1080,
      height: 1920,
      caption: "look at this",
      mediaUrl: `https://bridge.example.com/sessions/main/media/${encodeURIComponent(PEER_JID)}/IMG_1`,
    });
  });

  it("videoMessage with duration", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          videoMessage: {
            mimetype: "video/mp4",
            fileLength: 999_999,
            seconds: 42,
            width: 720,
            height: 1280,
          },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("video");
    expect(out.message.media?.durationSec).toBe(42);
    expect(out.message.media?.mimeType).toBe("video/mp4");
  });

  it("audioMessage (voice note)", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 7, fileLength: 4321, ptt: true },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("audio");
    expect(out.message.media?.durationSec).toBe(7);
  });

  it("documentMessage with filename", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          documentMessage: {
            mimetype: "application/pdf",
            fileName: "invoice.pdf",
            fileLength: 50_000,
          },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("document");
    expect(out.message.media?.fileName).toBe("invoice.pdf");
    expect(out.message.media?.size).toBe(50_000);
  });

  it("stickerMessage", () => {
    const out = normalizeMessage(
      makeRaw({
        message: { stickerMessage: { mimetype: "image/webp", fileLength: 1024 } },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("sticker");
    expect(out.message.media?.mimeType).toBe("image/webp");
  });

  it("locationMessage", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          locationMessage: {
            degreesLatitude: 44.4268,
            degreesLongitude: 26.1025,
            name: "Bucharest",
            address: "RO",
          },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("location");
    expect(out.message.location).toEqual({
      latitude: 44.4268,
      longitude: 26.1025,
      name: "Bucharest",
      address: "RO",
    });
  });

  it("contactMessage", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          contactMessage: {
            displayName: "Jane Doe",
            vcard: "BEGIN:VCARD\nFN:Jane Doe\nEND:VCARD",
          },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("contact");
    expect(out.message.contact?.displayName).toBe("Jane Doe");
    expect(out.message.contact?.vcard).toContain("VCARD");
  });

  it("reactionMessage", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          reactionMessage: {
            key: { id: "TARGET_MSG", remoteJid: PEER_JID, fromMe: false },
            text: "❤️",
          },
        },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.kind).toBe("reaction");
    expect(out.message.reaction).toEqual({ targetMessageId: "TARGET_MSG", emoji: "❤️" });
  });

  it("returns null for unsupported / control messages (e.g. protocolMessage)", () => {
    const out = normalizeMessage(
      makeRaw({
        message: {
          protocolMessage: { type: 0 as unknown as proto.Message.ProtocolMessage.Type },
        },
      }),
      ctx,
    );
    expect(out).toBeNull();
  });
});

// ---- Group context --------------------------------------------------------

describe("normalizeMessage — group chats", () => {
  it("populates group + uses participant as senderJid", () => {
    const out = normalizeMessage(
      makeRaw({
        remoteJid: GROUP_JID,
        participant: "333333333@s.whatsapp.net",
        message: { conversation: "yo group" },
      }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.chatJid).toBe(GROUP_JID);
    expect(out.message.senderJid).toBe("333333333@s.whatsapp.net");
    expect(out.message.group).toEqual({ jid: GROUP_JID });
  });

  it("in 1:1 chats, senderJid equals chatJid (not fromMe)", () => {
    const out = normalizeMessage(makeRaw({ message: { conversation: "hi" } }), ctx);
    expectValidEnvelope(out);
    expect(out.message.senderJid).toBe(PEER_JID);
    expect(out.message.chatJid).toBe(PEER_JID);
    expect(out.message.group).toBeUndefined();
  });

  it("when fromMe in a 1:1 chat, senderJid is the bridge's own JID", () => {
    const out = normalizeMessage(
      makeRaw({ fromMe: true, message: { conversation: "hi back" } }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.senderJid).toBe(SELF_JID);
  });
});

// ---- mediaUrl wiring ------------------------------------------------------

describe("normalizeMessage — media URL", () => {
  it("uses ctx.mediaUrlFor to populate Media.mediaUrl", () => {
    const out = normalizeMessage(
      makeRaw({ id: "MEDIA_1", message: { imageMessage: { mimetype: "image/jpeg" } } }),
      ctx,
    );
    expectValidEnvelope(out);
    expect(out.message.media?.mediaUrl).toContain("/MEDIA_1");
  });

  it("sets mediaUrl to null when ctx.mediaUrlFor is absent", () => {
    const noUrlCtx: NormalizeContext = { sessionId: "main", selfJid: SELF_JID, now: () => NOW };
    const out = normalizeMessage(
      makeRaw({ message: { imageMessage: { mimetype: "image/jpeg" } } }),
      noUrlCtx,
    );
    expectValidEnvelope(out);
    expect(out.message.media?.mediaUrl).toBeNull();
  });
});
