import { describe, expect, it } from "vitest";
import { remarkUserText, splitUserText, type MdNode } from "./user-markdown";

describe("the user's markdown", () => {
  it("keeps line breaks", () => {
    expect(splitUserText("first\nsecond")).toEqual([{ type: "text", value: "first" }, { type: "break" }, { type: "text", value: "second" }]);
  });

  it("turns vault references into chips", () => {
    const nodes = splitUserText("token vault://tg_bot.1 saved");
    expect(nodes.map((n) => n.type)).toEqual(["text", "vaultRef", "text"]);
    expect(nodes[1].data).toMatchObject({ hName: "span", hProperties: { className: ["vault-ref"] }, hChildren: [{ type: "text", value: "tg_bot.1" }] });
  });

  it("walks the tree but leaves code alone", () => {
    const tree: MdNode = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "a\nb" }, { type: "inlineCode", value: "vault://x" }] },
        { type: "code", value: "one\ntwo" },
      ],
    };
    remarkUserText()(tree);
    expect(tree.children![0].children!.map((n) => n.type)).toEqual(["text", "break", "text", "inlineCode"]);
    expect(tree.children![1]).toEqual({ type: "code", value: "one\ntwo" });
  });
});
