// What the user typed, as markdown: a line break stays a line break (the composer's Shift+Enter), and secrets the hub
// took out of the message (vault://id) become chips. A remark plugin on the markdown tree, before it turns into HTML.

export type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

const VAULT_REF = /(vault:\/\/[A-Za-z0-9][\w.-]{0,127})/;

/** A `vault://id` reference as an inline node the renderer shows as a chip (`span.vault-ref` with the id). */
function vaultRef(ref: string): MdNode {
  const id = ref.slice("vault://".length);
  return { type: "vaultRef", data: { hName: "span", hProperties: { className: ["vault-ref"] }, hChildren: [{ type: "text", value: id }] } };
}

/** One text node's value as text, line breaks and vault chips. */
export function splitUserText(value: string): MdNode[] {
  const out: MdNode[] = [];
  value.split("\n").forEach((line, i) => {
    if (i > 0) out.push({ type: "break" });
    line.split(VAULT_REF).forEach((s, j) => {
      if (j % 2) out.push(vaultRef(s));
      else if (s) out.push({ type: "text", value: s });
    });
  });
  return out;
}

/** remark plugin for the user's own messages. Code (`inlineCode`, `code`) keeps its text as it is. */
export function remarkUserText() {
  return (tree: MdNode) => {
    const walk = (n: MdNode) => {
      if (!n.children) return;
      n.children = n.children.flatMap((c) => (c.type === "text" && c.value ? splitUserText(c.value) : (walk(c), [c])));
    };
    walk(tree);
  };
}
