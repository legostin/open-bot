// What a Telegram message from the owner carries for the assistant: the user's words (text, a caption, a shared
// place), the one file it holds, and context the model would otherwise miss (a forward's origin, the message it
// replies to). The context is English text for the model, not shown in the chat.

import type { AttachmentKind } from "@owlbot/shared";
import type { TgMessage, TgUser } from "./api.ts";

/** Bots can download files up to 20 MB (getFile). */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const QUOTE_CHARS = 300;
const FILE_WORDS: Record<AttachmentKind, string> = { photo: "a photo", voice: "a voice message", audio: "an audio file", video: "a video", file: "a file" };

export interface FileRef {
  fileId: string;
  /** Bytes, when Telegram says. */
  size?: number;
  name?: string;
  mimeType?: string;
  kind: AttachmentKind;
  durationSec?: number;
}

type Any = Record<string, any>;

const userName = (u?: TgUser | Any) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || (u?.username ? `@${u.username}` : "");

/** The user's own words: text or caption, and a shared place as a pin line. */
export function messageWords(m: TgMessage): string {
  const words = String((typeof m.text === "string" ? m.text : (m.caption as string | undefined)) ?? "").trim();
  const venue = m.venue as Any | undefined;
  const loc = (venue?.location ?? m.location) as { latitude?: number; longitude?: number } | undefined;
  if (typeof loc?.latitude !== "number" || typeof loc.longitude !== "number") return words;
  const where = [venue?.title, venue?.address].filter(Boolean).join(", ");
  const pin = `📍 ${where ? `${where} ` : ""}(${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)})`;
  return [words, pin].filter(Boolean).join("\n");
}

/** Who a forwarded message came from, by the newer forward_origin or the older forward_* fields. */
function forwardedFrom(m: TgMessage): string | undefined {
  const o = m.forward_origin as Any | undefined;
  if (o) {
    if (o.type === "user") return userName(o.sender_user) || "a user";
    if (o.type === "hidden_user") return o.sender_user_name || "a user";
    if (o.type === "chat") return o.sender_chat?.title || "a chat";
    if (o.type === "channel") return o.chat?.title ? `the channel "${o.chat.title}"` : "a channel";
    return "someone";
  }
  if (m.forward_from) return userName(m.forward_from as TgUser) || "a user";
  if (typeof m.forward_sender_name === "string") return m.forward_sender_name;
  if ((m.forward_from_chat as Any | undefined)?.title) return (m.forward_from_chat as Any).title;
  return undefined;
}

const clip = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > QUOTE_CHARS ? `${one.slice(0, QUOTE_CHARS)}…` : one;
};

/** Lines for the model: a forward's origin, the message this one replies to. */
export function messageContext(m: TgMessage, botId?: number): string[] {
  const out: string[] = [];
  const from = forwardedFrom(m);
  if (from) out.push(`[Forwarded from ${from}]`);
  const reply = m.reply_to_message as TgMessage | undefined;
  if (reply) {
    const quoted = clip(String((m.quote as Any | undefined)?.text ?? reply.text ?? reply.caption ?? ""));
    const file = messageFile(reply);
    const what = quoted ? `"${quoted}"` : file ? FILE_WORDS[file.kind] : "a message";
    out.push(`[In reply to ${botId !== undefined && reply.from?.id === botId ? "your message" : "the message"}: ${what}]`);
  }
  return out;
}

/** The file a message holds, if any (a photo in its largest size). */
export function messageFile(m: TgMessage): FileRef | undefined {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const photos = m.photo as Any[] | undefined;
  if (Array.isArray(photos) && photos.length) {
    const area = (p: Any) => (p.width ?? 0) * (p.height ?? 0);
    const best = photos.reduce((a, b) => (area(b) > area(a) || (area(b) === area(a) && (b.file_size ?? 0) > (a.file_size ?? 0)) ? b : a));
    return { fileId: best.file_id, size: num(best.file_size), mimeType: "image/jpeg", kind: "photo" };
  }
  const pick = (f: Any | undefined, kind: AttachmentKind, mimeType?: string): FileRef | undefined =>
    f?.file_id
      ? { fileId: f.file_id, size: num(f.file_size), name: str(f.file_name), mimeType: str(f.mime_type) ?? mimeType, kind, durationSec: num(f.duration) }
      : undefined;
  // An animation also comes with a document copy: the animation wins.
  return (
    pick(m.voice as Any, "voice", "audio/ogg") ??
    pick(m.video_note as Any, "video", "video/mp4") ??
    pick(m.animation as Any, "video", "video/mp4") ??
    pick(m.video as Any, "video", "video/mp4") ??
    pick(m.audio as Any, "audio") ??
    pick(m.document as Any, "file")
  );
}
