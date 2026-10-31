// Facts are Markdown. An open fact shows it rendered, with its single line breaks kept (people write notes that way);
// the one- or two-line previews show the words without Markdown's marks.

export function plainText(md: string): string {
  return md
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, "")
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}*_])[*_](?=\S)([^*_\n]*?\S)[*_](?=[^\p{L}\p{N}*_]|$)/gu, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** A single line break as a line break (Markdown's two trailing spaces), except inside code blocks. */
export function withBreaks(md: string): string {
  let code = false;
  const lines = md.split("\n");
  return lines
    .map((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) code = !code;
      const next = lines[i + 1];
      if (code || next === undefined || !line.trim() || !next.trim() || /^\s*(```|~~~)/.test(next) || / {2}$/.test(line)) return line;
      return `${line}  `;
    })
    .join("\n");
}
