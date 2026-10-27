import { describe, expect, it } from "vitest";
import { messageContext, messageFile, messageWords } from "../server/inbound.ts";

const msg = (extra: Record<string, unknown>) => ({ message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, ...extra });

describe("telegram inbound", () => {
  it("takes the text or the caption, and a shared place as a pin", () => {
    expect(messageWords(msg({ text: " привет " }))).toBe("привет");
    expect(messageWords(msg({ caption: "чек за обед", photo: [] }))).toBe("чек за обед");
    expect(messageWords(msg({ location: { latitude: 43.238949, longitude: 76.889709 } }))).toBe("📍 (43.23895, 76.88971)");
    expect(messageWords(msg({ venue: { title: "Кофейня", address: "Абая 1", location: { latitude: 43.2, longitude: 76.9 } }, location: { latitude: 43.2, longitude: 76.9 } }))).toBe(
      "📍 Кофейня, Абая 1 (43.20000, 76.90000)",
    );
    expect(messageWords(msg({ sticker: { file_id: "s" } }))).toBe("");
  });

  it("finds the file: the largest photo, voice with its length, documents with their names", () => {
    const photo = [
      { file_id: "small", width: 90, height: 60, file_size: 1000 },
      { file_id: "big", width: 1280, height: 853, file_size: 90_000 },
      { file_id: "mid", width: 320, height: 213, file_size: 12_000 },
    ];
    expect(messageFile(msg({ photo }))).toEqual({ fileId: "big", size: 90_000, mimeType: "image/jpeg", kind: "photo" });
    expect(messageFile(msg({ voice: { file_id: "v", duration: 12, mime_type: "audio/ogg", file_size: 4000 } }))).toEqual({ fileId: "v", size: 4000, mimeType: "audio/ogg", kind: "voice", durationSec: 12, name: undefined });
    expect(messageFile(msg({ document: { file_id: "d", file_name: "договор.pdf", mime_type: "application/pdf", file_size: 5 } }))).toMatchObject({ fileId: "d", name: "договор.pdf", kind: "file" });
    expect(messageFile(msg({ animation: { file_id: "a", file_name: "cat.mp4" }, document: { file_id: "a", file_name: "cat.mp4" } }))).toMatchObject({ fileId: "a", kind: "video", mimeType: "video/mp4" });
    expect(messageFile(msg({ video_note: { file_id: "n", duration: 7 } }))).toMatchObject({ kind: "video", durationSec: 7 });
    expect(messageFile(msg({ text: "hi" }))).toBeUndefined();
  });

  it("tells the model where a forward came from and what a message replies to", () => {
    expect(messageContext(msg({ forward_origin: { type: "user", sender_user: { id: 5, first_name: "Оля", last_name: "К" } } }))).toEqual(["[Forwarded from Оля К]"]);
    expect(messageContext(msg({ forward_origin: { type: "channel", chat: { title: "Новости" } } }))).toEqual(['[Forwarded from the channel "Новости"]']);
    expect(messageContext(msg({ forward_origin: { type: "hidden_user", sender_user_name: "Аноним" } }))).toEqual(["[Forwarded from Аноним]"]);
    expect(messageContext(msg({ forward_sender_name: "Старый клиент" }))).toEqual(["[Forwarded from Старый клиент]"]);
    const reply = msg({ reply_to_message: msg({ from: { id: 4242, first_name: "Owlbot" }, text: "Созвон в 10:00, напомнить?" }) });
    expect(messageContext(reply, 4242)).toEqual(['[In reply to your message: "Созвон в 10:00, напомнить?"]']);
    expect(messageContext(msg({ reply_to_message: msg({ from: { id: 1 }, text: "x".repeat(400) }) }), 4242)).toEqual([`[In reply to the message: "${"x".repeat(300)}…"]`]);
    expect(messageContext(msg({ reply_to_message: msg({ voice: { file_id: "v" } }) }))).toEqual(["[In reply to the message: a voice message]"]);
    expect(messageContext(msg({ text: "plain" }))).toEqual([]);
  });
});
