import { describe, expect, it } from "vitest";
import { admit, canSend, isImage, MAX_FILE_BYTES, MAX_FILES, readyPaths, sizeParts, type PendingFile } from "./attachments";

const file = (name: string, size = 10, type = "") => ({ name, size, type });
const pending = (status: PendingFile["status"], path?: string): PendingFile => ({ id: `${status}-${path}`, name: "x", size: 1, type: "", status, path });

describe("composer attachments", () => {
  it("admits files up to the size and count limits", () => {
    const r = admit([pending("ready", "a")], [file("ok.png"), file("big.mov", MAX_FILE_BYTES + 1), file("empty.txt", 0)]);
    expect(r.accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(r.rejected).toEqual([
      { name: "big.mov", reason: "tooLarge" },
      { name: "empty.txt", reason: "empty" },
    ]);
    const full = Array.from({ length: MAX_FILES - 1 }, (_, i) => pending("ready", `p${i}`));
    const more = admit(full, [file("1.png"), file("2.png")]);
    expect(more.accepted.map((f) => f.name)).toEqual(["1.png"]);
    expect(more.rejected).toEqual([{ name: "2.png", reason: "tooMany" }]);
  });

  it("sends when there are words or uploaded files, never while one still uploads", () => {
    expect(canSend("", [])).toBe(false);
    expect(canSend("  hi ", [])).toBe(true);
    expect(canSend("", [pending("ready", "a")])).toBe(true);
    expect(canSend("hi", [pending("ready", "a"), pending("uploading")])).toBe(false);
    expect(canSend("", [pending("error")])).toBe(false);
    expect(canSend("hi", [pending("error")])).toBe(true);
    expect(readyPaths([pending("ready", "a"), pending("error"), pending("ready", "b")])).toEqual(["a", "b"]);
  });

  it("knows pictures and splits sizes into a number and a unit", () => {
    expect(isImage("image/png")).toBe(true);
    expect(isImage("image/svg+xml")).toBe(false);
    expect(isImage("application/pdf")).toBe(false);
    expect(sizeParts(512)).toEqual({ n: 512, unit: "b" });
    expect(sizeParts(48_000)).toEqual({ n: 47, unit: "kb" });
    expect(sizeParts(1_250_000)).toEqual({ n: 1.2, unit: "mb" });
    expect(sizeParts(25 * 1024 * 1024)).toEqual({ n: 25, unit: "mb" });
  });
});
