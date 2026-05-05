import { createHash } from "node:crypto";
import type { proto } from "baileys";
import {
  WhatsAppEventSchema,
  type MessageReceivedEvent,
  type MessageSentEvent,
  type NormalizedMessage,
  type Media,
  type Location,
  type Contact,
  type Reaction,
  type MessageKind,
} from "./schema.js";

export interface NormalizeContext {
  sessionId: string;
  // The bridge's own JID (e.g. "1234567890@s.whatsapp.net"). Used to populate
  // senderJid on outgoing 1:1 messages where Baileys leaves participant unset.
  selfJid: string;
  now?: () => Date;
  // Builds the lazy media-download URL exposed by the bridge HTTP server.
  // Returning null (or omitting the function) means the consumer cannot fetch bytes.
  mediaUrlFor?: (messageId: string, chatJid: string) => string | null;
}

export function normalizeMessage(
  raw: proto.IWebMessageInfo,
  ctx: NormalizeContext,
): MessageReceivedEvent | MessageSentEvent | null {
  const message = raw.message;
  const key = raw.key;
  if (!message || !key?.id || !key.remoteJid) return null;

  const messageId = key.id;
  const chatJid = key.remoteJid;
  const fromMe = key.fromMe === true;
  const isGroup = chatJid.endsWith("@g.us");

  const senderJid = isGroup
    ? (key.participant ?? chatJid)
    : fromMe
      ? ctx.selfJid
      : chatJid;

  const tsSec = toUnixSeconds(raw.messageTimestamp);
  const messageTs = new Date(tsSec * 1000).toISOString();

  const content = extractContent(message, messageId, chatJid, ctx);
  if (!content) return null;

  const normalized: NormalizedMessage = {
    id: messageId,
    chatJid,
    senderJid,
    fromMe,
    timestamp: messageTs,
    kind: content.kind,
    ...(content.text !== undefined && { text: content.text }),
    ...(content.media !== undefined && { media: content.media }),
    ...(content.location !== undefined && { location: content.location }),
    ...(content.contact !== undefined && { contact: content.contact }),
    ...(content.reaction !== undefined && { reaction: content.reaction }),
    ...(content.quotedMessageId !== undefined && { quotedMessageId: content.quotedMessageId }),
    ...(isGroup && { group: { jid: chatJid } }),
  };

  const type = fromMe ? "message.sent" : "message.received";
  const at = (ctx.now ?? (() => new Date()))().toISOString();

  const envelope = {
    v: 1 as const,
    type,
    eventId: makeEventId(ctx.sessionId, messageId, type),
    sessionId: ctx.sessionId,
    at,
    message: normalized,
  };

  // Self-validate so contract drift fails loudly at the source rather than at the consumer.
  return WhatsAppEventSchema.parse(envelope) as MessageReceivedEvent | MessageSentEvent;
}

interface ExtractedContent {
  kind: MessageKind;
  text?: string;
  media?: Media;
  location?: Location;
  contact?: Contact;
  reaction?: Reaction;
  quotedMessageId?: string;
}

function extractContent(
  m: proto.IMessage,
  messageId: string,
  chatJid: string,
  ctx: NormalizeContext,
): ExtractedContent | null {
  const mediaUrl = ctx.mediaUrlFor ? ctx.mediaUrlFor(messageId, chatJid) : null;

  if (m.conversation) {
    return { kind: "text", text: m.conversation };
  }

  if (m.extendedTextMessage) {
    const e = m.extendedTextMessage;
    const stanzaId = e.contextInfo?.stanzaId;
    return {
      kind: "text",
      text: e.text ?? "",
      ...(stanzaId ? { quotedMessageId: stanzaId } : {}),
    };
  }

  if (m.imageMessage) {
    const i = m.imageMessage;
    return {
      kind: "image",
      ...(i.caption ? { text: i.caption } : {}),
      media: cleanMedia({
        mimeType: i.mimetype ?? "application/octet-stream",
        size: numberOrUndef(i.fileLength),
        width: i.width ?? undefined,
        height: i.height ?? undefined,
        caption: i.caption ?? undefined,
        mediaUrl,
      }),
    };
  }

  if (m.videoMessage) {
    const v = m.videoMessage;
    return {
      kind: "video",
      ...(v.caption ? { text: v.caption } : {}),
      media: cleanMedia({
        mimeType: v.mimetype ?? "application/octet-stream",
        size: numberOrUndef(v.fileLength),
        width: v.width ?? undefined,
        height: v.height ?? undefined,
        durationSec: v.seconds ?? undefined,
        caption: v.caption ?? undefined,
        mediaUrl,
      }),
    };
  }

  if (m.audioMessage) {
    const a = m.audioMessage;
    return {
      kind: "audio",
      media: cleanMedia({
        mimeType: a.mimetype ?? "audio/ogg",
        size: numberOrUndef(a.fileLength),
        durationSec: a.seconds ?? undefined,
        mediaUrl,
      }),
    };
  }

  if (m.documentMessage) {
    const d = m.documentMessage;
    return {
      kind: "document",
      media: cleanMedia({
        mimeType: d.mimetype ?? "application/octet-stream",
        size: numberOrUndef(d.fileLength),
        fileName: d.fileName ?? undefined,
        mediaUrl,
      }),
    };
  }

  if (m.stickerMessage) {
    const s = m.stickerMessage;
    return {
      kind: "sticker",
      media: cleanMedia({
        mimeType: s.mimetype ?? "image/webp",
        size: numberOrUndef(s.fileLength),
        mediaUrl,
      }),
    };
  }

  if (m.locationMessage) {
    const l = m.locationMessage;
    return {
      kind: "location",
      location: {
        latitude: l.degreesLatitude ?? 0,
        longitude: l.degreesLongitude ?? 0,
        ...(l.name ? { name: l.name } : {}),
        ...(l.address ? { address: l.address } : {}),
      },
    };
  }

  if (m.contactMessage) {
    const c = m.contactMessage;
    return {
      kind: "contact",
      contact: {
        ...(c.displayName ? { displayName: c.displayName } : {}),
        vcard: c.vcard ?? "",
      },
    };
  }

  if (m.reactionMessage) {
    const r = m.reactionMessage;
    return {
      kind: "reaction",
      reaction: {
        targetMessageId: r.key?.id ?? "",
        emoji: r.text ?? "",
      },
    };
  }

  // protocolMessage, ephemeralMessage, viewOnce*, senderKeyDistribution, etc.
  // Intentionally not surfaced in v1.
  return null;
}

// ---- helpers --------------------------------------------------------------

// Baileys uses `number | Long | null | undefined` for protobuf 64-bit fields.
// We accept both shapes structurally to avoid pulling in the `long` package.
type LongLike = { toNumber: () => number };

function isLongLike(v: unknown): v is LongLike {
  return typeof v === "object" && v !== null && typeof (v as LongLike).toNumber === "function";
}

function toUnixSeconds(ts: proto.IWebMessageInfo["messageTimestamp"]): number {
  if (typeof ts === "number") return ts;
  if (isLongLike(ts)) return ts.toNumber();
  return 0;
}

function numberOrUndef(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (isLongLike(v)) return v.toNumber();
  return undefined;
}

// Strip undefined fields so JSON envelopes stay tidy for downstream consumers.
function cleanMedia(m: {
  mimeType: string;
  mediaUrl: string | null;
  size?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  durationSec?: number | undefined;
  caption?: string | undefined;
  fileName?: string | undefined;
}): Media {
  const out: Media = { mimeType: m.mimeType, mediaUrl: m.mediaUrl };
  if (m.size !== undefined) out.size = m.size;
  if (m.width !== undefined) out.width = m.width;
  if (m.height !== undefined) out.height = m.height;
  if (m.durationSec !== undefined) out.durationSec = m.durationSec;
  if (m.caption !== undefined) out.caption = m.caption;
  if (m.fileName !== undefined) out.fileName = m.fileName;
  return out;
}

function makeEventId(sessionId: string, messageId: string, type: string): string {
  return createHash("sha256")
    .update(`${sessionId}:${messageId}:${type}`)
    .digest("hex")
    .slice(0, 16);
}
