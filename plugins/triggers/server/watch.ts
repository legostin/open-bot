// Watch triggers: fetch a URL and extract a comparable value (whole-page text, CSS selector text, or a JSON path).

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse as parseHtml } from "node-html-parser";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class WatchError extends Error {}

// ---------- JSON path ----------

export type PathToken = string | number;

/** Parse `data.items[0].price`, `$.a["b c"][-1]`. Throws WatchError on bad syntax. */
export function parseJsonPath(path: string): PathToken[] {
  let s = path.trim();
  if (s.startsWith("$")) s = s.slice(1);
  const tokens: PathToken[] = [];
  const re = /\.?([A-Za-z_$][\w$-]*)|\[\s*(-?\d+)\s*\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\]|\.(\d+)/y;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m || m.index !== pos || m[0].length === 0) throw new WatchError(`Неверный JSON-путь "${path}" (позиция ${pos + 1}). Пример: data.items[0].price`);
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else if (m[3] !== undefined) tokens.push(m[3].replace(/\\(.)/g, "$1"));
    else if (m[4] !== undefined) tokens.push(m[4].replace(/\\(.)/g, "$1"));
    else if (m[5] !== undefined) tokens.push(Number(m[5]));
    pos = re.lastIndex;
  }
  if (!tokens.length) throw new WatchError(`Пустой JSON-путь "${path}"`);
  return tokens;
}

export function evalJsonPath(data: unknown, tokens: PathToken[]): unknown {
  let cur: any = data;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof t === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t < 0 ? cur.length + t : t];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = Object.prototype.hasOwnProperty.call(cur, t) ? cur[t] : undefined;
    }
  }
  return cur;
}

// ---------- selectors / text ----------

export function selectorError(selector: string): string | undefined {
  try {
    parseHtml("<div></div>").querySelectorAll(selector);
    return undefined;
  } catch (e: any) {
    return `Неверный CSS-селектор "${selector}": ${e?.message ?? e}`;
  }
}

const norm = (s: string) =>
  s
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

function pageText(html: string): string {
  const root = parseHtml(html, { blockTextElements: { pre: true } });
  for (const el of root.querySelectorAll("script, style, noscript, template, svg")) el.remove();
  const body = root.querySelector("body") ?? root;
  return norm(body.structuredText);
}

const looksHtml = (contentType: string, body: string) => /html|xml/i.test(contentType) || /^\s*<(!doctype|html|head|body|div|p)\b/i.test(body);

/** The value a watch compares: JSON path value, selector text, or the page text. */
export function extractValue(body: string, contentType: string, opts: { selector?: string; jsonPath?: string }): string {
  if (opts.jsonPath) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new WatchError("Ответ не является JSON — JSON-путь применить нельзя");
    }
    const v = evalJsonPath(data, parseJsonPath(opts.jsonPath));
    if (v === undefined) throw new WatchError(`JSON-путь ${opts.jsonPath} ничего не нашёл`);
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  }
  if (opts.selector) {
    const root = parseHtml(body);
    const els = root.querySelectorAll(opts.selector);
    if (!els.length) throw new WatchError(`CSS-селектор ${opts.selector} ничего не нашёл на странице`);
    return els.map((e) => norm(e.structuredText)).join("\n");
  }
  return looksHtml(contentType, body) ? pageText(body) : body.trim();
}

export function hashValue(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// ---------- fetching ----------

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

export function isPrivateAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(a) === 4) return PRIVATE_V4.some((r) => r.test(a));
  if (isIP(a) === 6) {
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(a);
  }
  return false;
}

/** Refuse loopback / private network targets unless explicitly allowed (SSRF from model-created watches). */
export async function assertFetchable(url: string, allowPrivate: boolean): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new WatchError(`Неверный адрес: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new WatchError("Поддерживаются только адреса http и https");
  if (allowPrivate) return u;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const blocked = () => new WatchError(`Адрес ${u.hostname} во внутренней сети: следить за ним запрещено (настройка allowPrivateUrls)`);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw blocked();
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blocked();
    return u;
  }
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) throw blocked();
  } catch (e) {
    if (e instanceof WatchError) throw e;
    // DNS failed here (e.g. only the egress proxy resolves names): let the request decide.
  }
  return u;
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = Buffer.concat(chunks).subarray(0, max);
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export async function fetchPage(url: string, opts: { allowPrivate: boolean; timeoutMs: number }): Promise<{ body: string; contentType: string; url: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertFetchable(current, opts.allowPrivate);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { "user-agent": "open-bot-triggers/0.1 (+watch)", accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      });
    } catch (e: any) {
      const why = e?.name === "TimeoutError" ? "таймаут" : (e?.cause?.code ?? e?.message ?? String(e));
      throw new WatchError(`Не удалось загрузить ${current}: ${why}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new WatchError(`${current} ответил ${res.status}`);
    }
    return { body: await readLimited(res, MAX_BODY_BYTES), contentType: res.headers.get("content-type") ?? "", url: current };
  }
  throw new WatchError(`Слишком много перенаправлений: ${url}`);
}

// ---------- diff ----------

/** Short line diff for the prompt: removed lines with "-", added with "+". */
export function lineDiff(prev: string, next: string, maxLines = 60): string {
  const a = prev.split("\n");
  const b = next.split("\n");
  const inB = new Map<string, number>();
  for (const l of b) inB.set(l, (inB.get(l) ?? 0) + 1);
  const inA = new Map<string, number>();
  for (const l of a) inA.set(l, (inA.get(l) ?? 0) + 1);
  const removed: string[] = [];
  const added: string[] = [];
  const left = new Map(inB);
  for (const l of a) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else removed.push(l);
  }
  const right = new Map(inA);
  for (const l of b) {
    const n = right.get(l) ?? 0;
    if (n > 0) right.set(l, n - 1);
    else added.push(l);
  }
  const out = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)];
  if (out.length > maxLines) return [...out.slice(0, maxLines), `… ещё ${out.length - maxLines} строк`].join("\n");
  return out.join("\n");
}
