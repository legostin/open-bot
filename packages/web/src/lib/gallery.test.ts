import { describe, expect, it } from "vitest";
import type { Message } from "@piomio/shared";
import { chatMedia, fileHref, imageDownload, indexOfKey, mediaKind } from "./gallery";

const msg = (id: string, parts: Message["parts"]): Message => ({ id, conversationId: "c", role: "user", parts, status: "complete", createdAt: "2026-10-31T00:00:00Z" }) as Message;

describe("chat media", () => {
  it("knows which files the viewer shows", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("image/JPEG")).toBe("image");
    expect(mediaKind("image/svg+xml")).toBe("image");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("video/quicktime")).toBe("video");
    expect(mediaKind("image/heic")).toBeUndefined();
    expect(mediaKind("application/pdf")).toBeUndefined();
    expect(mediaKind(undefined)).toBeUndefined();
  });

  it("collects the chat's pictures and videos in order, each with a link that saves it", () => {
    const items = chatMedia([
      msg("m1", [
        { type: "text", text: "look" },
        { type: "attachment", path: "a/c/attachments/photo 1.jpg", name: "photo 1.jpg", mimeType: "image/jpeg" },
        { type: "attachment", path: "a/c/attachments/doc.pdf", name: "doc.pdf", mimeType: "application/pdf" },
      ]),
      msg("m2", [
        {
          type: "images",
          items: [
            { src: "https://example.com/x.png", caption: "Tower" },
            { src: "file:a/c/chart.png", alt: "chart" },
            { src: "javascript:alert(1)" },
          ],
        },
        { type: "attachment", path: "a/c/attachments/clip.mp4", name: "clip.mp4", mimeType: "video/mp4" },
        { type: "attachment", path: "a/c/attachments/voice.ogg", name: "voice.ogg", mimeType: "audio/ogg", kind: "voice" },
      ]),
    ]);
    expect(items.map((i) => i.key)).toEqual(["m1/1", "m2/0/0", "m2/0/1", "m2/1"]);
    expect(items[0]).toEqual({
      key: "m1/1",
      kind: "image",
      src: "/api/files?path=a%2Fc%2Fattachments%2Fphoto%201.jpg",
      name: "photo 1.jpg",
      download: "/api/files?path=a%2Fc%2Fattachments%2Fphoto%201.jpg&download=1",
    });
    expect(items[1]).toMatchObject({ caption: "Tower", original: "https://example.com/x.png", download: "/api/media?url=https%3A%2F%2Fexample.com%2Fx.png&download=1" });
    expect(items[2]).toMatchObject({ name: "chart", original: undefined, download: fileHref("a/c/chart.png", true) });
    expect(items[3]).toMatchObject({ kind: "video", name: "clip.mp4" });
    expect(indexOfKey(items, "m2/1")).toBe(3);
    expect(indexOfKey(items, "nope")).toBe(-1);
  });

  it("saves only what the hub can hand over", () => {
    expect(imageDownload("data:image/png;base64,AAAA")).toBeUndefined();
    expect(imageDownload("/local.png")).toBeUndefined();
    expect(imageDownload("file:")).toBeUndefined();
  });
});
