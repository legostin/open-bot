// Memory paths: relative, "/"-separated, inside the memory root, ".md" files only, no hidden segments.

/**
 * An error of the memory service. The message is English (it reaches the model through tool results);
 * `code` and `params` let the memory UI show it in the reader's language (catalog key "ui.error.<code>").
 */
export class MemoryError extends Error {
  code: string;
  params: Record<string, string | number>;
  constructor(code: string, message: string, params: Record<string, string | number> = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}
/** Bad input (HTTP 400). */
export class PathError extends MemoryError {}
/** No such fact (HTTP 404). */
export class NotFoundError extends MemoryError {}

const BAD_CHARS = /[\u0000-\u001f<>:"|?*]/;

/** Validate and normalize a fact path ("people/anna.md") or, with dir: true, a folder ("people", "" = root). */
export function normalizePath(p: unknown, opts: { dir?: boolean } = {}): string {
  if (typeof p !== "string") throw new PathError("pathNotString", "Path must be a string");
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (opts.dir) s = s.replace(/\/+$/, "");
  if (!s) {
    if (opts.dir) return "";
    throw new PathError("pathEmpty", "Empty path");
  }
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) throw new PathError("pathAbsolute", `Path must be relative: ${p}`, { path: p });
  if (s.length > 200) throw new PathError("pathTooLong", "Path is too long");
  for (const seg of s.split("/")) {
    if (!seg || seg === "." || seg === "..") throw new PathError("pathInvalid", `Invalid path: ${p}`, { path: p });
    if (seg.startsWith(".")) throw new PathError("pathHidden", `Hidden files and folders are not accessible: ${p}`, { path: p });
    if (BAD_CHARS.test(seg) || /[. ]$/.test(seg) || seg.length > 100) throw new PathError("nameInvalid", `Invalid name: ${seg}`, { name: seg });
  }
  if (!opts.dir && !s.endsWith(".md")) throw new PathError("onlyMarkdown", `Only .md files are allowed: ${p}`, { path: p });
  return s;
}

/** Folder part of a fact path ("" for the root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// Transliteration of Cyrillic titles into file names (code points, so the source stays ASCII).
// Russian letters U+0430..U+044F in alphabetical order: a, b, v, g, d, e, zh, z, i, y, k, ... yu, ya
// (the hard and soft signs are dropped).
const RUSSIAN_LATIN = ["a", "b", "v", "g", "d", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"];
const OTHER_LATIN: Array<[number, string]> = [
  [0x451, "e"], // yo
  [0x456, "i"], // Ukrainian i
  [0x457, "yi"], // Ukrainian yi
  [0x454, "ye"], // Ukrainian ye
  [0x491, "g"], // Ukrainian ghe with upturn
];
const TRANSLIT: Record<string, string> = Object.fromEntries([
  ...RUSSIAN_LATIN.map((latin, i): [string, string] => [String.fromCharCode(0x430 + i), latin]),
  ...OTHER_LATIN.map(([code, latin]): [string, string] => [String.fromCharCode(code), latin]),
]);

/** File-name slug for a title: transliterated, lowercase, dashes. */
export function slugify(title: string): string {
  const s = [...title.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "note";
}
