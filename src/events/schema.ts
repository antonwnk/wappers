import { z } from "zod";

// JID = WhatsApp's "Jabber ID", e.g. "1234567890@s.whatsapp.net" or "12345@g.us".
// Treated as an opaque string at this layer; downstream consumers can parse if needed.
export const JidSchema = z.string().min(1);

export const MediaSchema = z.object({
  mimeType: z.string(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  caption: z.string().optional(),
  fileName: z.string().optional(),
  // Lazy download URL exposed by the bridge HTTP server (`GET /sessions/:id/media/:msgId`).
  // Null when the bridge cannot materialize one (e.g. session is offline at normalize time).
  mediaUrl: z.url().nullable(),
});

export const LocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  name: z.string().optional(),
  address: z.string().optional(),
});

export const ContactSchema = z.object({
  displayName: z.string().optional(),
  vcard: z.string(),
});

export const ReactionSchema = z.object({
  targetMessageId: z.string(),
  emoji: z.string(),
});

export const GroupContextSchema = z.object({
  jid: JidSchema,
  subject: z.string().optional(),
});

export const MessageKindSchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contact",
  "reaction",
  "unsupported",
]);

export const NormalizedMessageSchema = z.object({
  id: z.string(),
  chatJid: JidSchema,
  // In groups, this is the participant JID; in 1:1 chats, equals chatJid (or the bridge JID when fromMe).
  senderJid: JidSchema,
  fromMe: z.boolean(),
  timestamp: z.iso.datetime(),
  kind: MessageKindSchema,
  text: z.string().optional(),
  media: MediaSchema.optional(),
  location: LocationSchema.optional(),
  contact: ContactSchema.optional(),
  reaction: ReactionSchema.optional(),
  quotedMessageId: z.string().optional(),
  group: GroupContextSchema.optional(),
});

const EventBase = z.object({
  v: z.literal(1),
  // Stable hash of (sessionId, message id, type) — consumers use it for idempotency.
  eventId: z.string(),
  sessionId: z.string(),
  // ISO-8601 UTC timestamp of when the bridge observed/normalized the event.
  at: z.iso.datetime(),
});

export const MessageReceivedEventSchema = EventBase.extend({
  type: z.literal("message.received"),
  message: NormalizedMessageSchema,
});

export const MessageSentEventSchema = EventBase.extend({
  type: z.literal("message.sent"),
  message: NormalizedMessageSchema,
});

export const ConnectionUpdateEventSchema = EventBase.extend({
  type: z.literal("connection.update"),
  state: z.enum(["connecting", "open", "close"]),
  reason: z.string().optional(),
});

export const PresenceUpdateEventSchema = EventBase.extend({
  type: z.literal("presence.update"),
  jid: JidSchema,
  presence: z.enum(["available", "unavailable", "composing", "recording", "paused"]),
});

export const WhatsAppEventSchema = z.discriminatedUnion("type", [
  MessageReceivedEventSchema,
  MessageSentEventSchema,
  ConnectionUpdateEventSchema,
  PresenceUpdateEventSchema,
]);

export type Jid = z.infer<typeof JidSchema>;
export type Media = z.infer<typeof MediaSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Reaction = z.infer<typeof ReactionSchema>;
export type GroupContext = z.infer<typeof GroupContextSchema>;
export type MessageKind = z.infer<typeof MessageKindSchema>;
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;
export type MessageReceivedEvent = z.infer<typeof MessageReceivedEventSchema>;
export type MessageSentEvent = z.infer<typeof MessageSentEventSchema>;
export type ConnectionUpdateEvent = z.infer<typeof ConnectionUpdateEventSchema>;
export type PresenceUpdateEvent = z.infer<typeof PresenceUpdateEventSchema>;
export type WhatsAppEvent = z.infer<typeof WhatsAppEventSchema>;
