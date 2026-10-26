// Memory paths: relative, "/"-separated, inside the memory root, ".md" files only, no hidden segments.

export class PathError extends Error {}
export class NotFoundError extends Error {}

const BAD_CHARS = /[\u0000-\u001f<>:"|?*]/;

/** Validate and normalize a fact path ("people/anna.md") or, with dir: true, a folder ("people", "" = root). */
export function normalizePath(p: unknown, opts: { dir?: boolean } = {}): string {
  if (typeof p !== "string") throw new PathError("Путь должен быть строкой");
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (opts.dir) s = s.replace(/\/+$/, "");
  if (!s) {
    if (opts.dir) return "";
    throw new PathError("Пустой путь");
  }
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) throw new PathError(`Путь должен быть относительным: ${p}`);
  if (s.length > 200) throw new PathError("Слишком длинный путь");
  for (const seg of s.split("/")) {
    if (!seg || seg === "." || seg === "..") throw new PathError(`Недопустимый путь: ${p}`);
    if (seg.startsWith(".")) throw new PathError(`Скрытые файлы и папки недоступны: ${p}`);
    if (BAD_CHARS.test(seg) || /[. ]$/.test(seg) || seg.length > 100) throw new PathError(`Недопустимое имя: ${seg}`);
  }
  if (!opts.dir && !s.endsWith(".md")) throw new PathError(`Разрешены только файлы .md: ${p}`);
  return s;
}

/** Folder part of a fact path ("" for the root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g",
};

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
