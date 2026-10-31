import { describe, expect, it } from "vitest";
import { parseMentions } from "@piomio/shared/group";
import { applyMention, filterMentions, mentionQuery } from "./mentions";
import { chatForPath, groupOrder, groupPath, suggestedTitle } from "./team";

const members = [
  { id: "assistant", name: "Owl" },
  { id: "scout", name: "Scout" },
  { id: "research-lead", name: "Research Lead" },
];

describe("@mention autocomplete", () => {
  it("finds the @word being typed before the caret", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("hi @sc", 6)).toEqual({ start: 3, query: "sc" });
    expect(mentionQuery("hi @sc and more", 6)).toEqual({ start: 3, query: "sc" });
    // Any script (here Cyrillic).
    expect(mentionQuery("(@\u0440\u0435", 4)).toEqual({ start: 1, query: "\u0440\u0435" });
    // Not a mention: an e-mail address, a finished word, or the caret elsewhere.
    expect(mentionQuery("bob@sc", 6)).toBeNull();
    expect(mentionQuery("@scout ", 7)).toBeNull();
    expect(mentionQuery("@scout hi", 9)).toBeNull();
    expect(mentionQuery("@@", 2)).toBeNull();
  });

  it("offers members by id, name or a word of the name, and everyone last", () => {
    expect(filterMentions(members, "").map((o) => o.id)).toEqual(["assistant", "scout", "research-lead", "all"]);
    expect(filterMentions(members, "s").map((o) => o.id)).toEqual(["scout", "assistant", "research-lead"]);
    expect(filterMentions(members, "lead").map((o) => o.id)).toEqual(["research-lead"]);
    expect(filterMentions(members, "OW").map((o) => o.id)).toEqual(["assistant"]);
    expect(filterMentions(members, "ou").map((o) => o.id)).toEqual(["scout"]);
    expect(filterMentions(members, "a")).toEqual([{ id: "assistant", name: "Owl" }, { id: "research-lead", name: "Research Lead" }, { id: "all", name: "all", all: true }]);
    // The start of the Russian "@all" offers everyone too.
    expect(filterMentions(members, "\u0432\u0441")).toEqual([{ id: "\u0432\u0441\u0435", name: "\u0432\u0441\u0435", all: true }]);
    expect(filterMentions(members, "zzz")).toEqual([]);
    expect(filterMentions(members.slice(0, 1), "")).toEqual([{ id: "assistant", name: "Owl" }]);
    // In Russian its own word comes first; "@a…" still offers "@all".
    expect(filterMentions(members, "", 8, "\u0432\u0441\u0435").at(-1)).toEqual({ id: "\u0432\u0441\u0435", name: "\u0432\u0441\u0435", all: true });
    expect(filterMentions(members, "al", 8, "\u0432\u0441\u0435").at(-1)).toEqual({ id: "all", name: "all", all: true });
    expect(filterMentions(members, "a", 8, null)).toEqual([{ id: "assistant", name: "Owl" }, { id: "research-lead", name: "Research Lead" }]);
  });

  it("inserts @id and a space, replacing the word under the caret", () => {
    expect(applyMention("hi @sc", 6, 3, "scout")).toEqual({ text: "hi @scout ", caret: 10 });
    expect(applyMention("hi @scxx there", 5, 3, "scout")).toEqual({ text: "hi @scout there", caret: 10 });
    expect(applyMention("@", 1, 0, "all")).toEqual({ text: "@all ", caret: 5 });
    // What the composer inserts is what the hub routes by.
    expect(parseMentions(applyMention("@re", 3, 0, "research-lead").text + "look", members)).toEqual(["research-lead"]);
  });
});

describe("group chats in the sidebar", () => {
  it("routes /chat/:id", () => {
    expect(groupPath("c_1 x")).toBe("/chat/c_1%20x");
    expect(chatForPath("/chat/c_1%20x")).toBe("c_1 x");
    expect(chatForPath("/agent/scout")).toBeUndefined();
  });

  it("orders groups by activity and titles unnamed ones by their members", () => {
    const g = (title: string, at: string) => ({ title, lastActivityAt: at });
    expect(groupOrder([g("b", "1"), g("a", "3"), g("c", "3")]).map((x) => x.title)).toEqual(["a", "c", "b"]);
    expect(suggestedTitle(["Owl", "Scout"])).toBe("Owl, Scout");
    expect(suggestedTitle(["Owl", "Scout", "Writer", "Coder", "Critic"])).toBe("Owl, Scout, Writer +2");
  });
});
