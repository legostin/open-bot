// Formatting helpers; text comes from the i18n dictionaries, dates from Intl in the current locale.

import { getLocale, t, tn } from "../i18n/index.ts";

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDate(iso: string | undefined, withSeconds = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(getLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: false,
  }).format(d);
}

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return t("time.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return tn("time.minutesAgo", m);
  const h = Math.round(m / 60);
  const d = new Date(ts);
  const today = new Date(now);
  if (h < 24 && d.getDate() === today.getDate()) return tn("time.hoursAgo", h);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return t("time.yesterdayAt", { time: formatTime(d) });
  return formatDate(iso);
}

export interface InputRow {
  /** Dotted path, e.g. "to" or "options.cc". */
  key: string;
  kind: "text" | "number" | "boolean" | "empty" | "list" | "json";
  text: string;
  /** For kind "list": one line per element. */
  items?: string[];
}

const scalar = (v: unknown): v is string | number | boolean | null | undefined => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);

function rowFor(key: string, v: unknown): InputRow {
  if (v === null || v === undefined || v === "") return { key, kind: "empty", text: v === "" ? t("input.emptyString") : t("input.none") };
  if (typeof v === "string") return { key, kind: "text", text: v };
  if (typeof v === "number") return { key, kind: "number", text: String(v) };
  if (typeof v === "boolean") return { key, kind: "boolean", text: String(v) };
  return { key, kind: "json", text: JSON.stringify(v, null, 2) };
}

/** Readable key/value rows for an approval's exact input. Nested objects are flattened to dotted keys. */
export function flattenInput(input: unknown, prefix = "", depth = 0): InputRow[] {
  if (input === null || input === undefined || typeof input !== "object") {
    return [rowFor(prefix || t("input.value"), input)];
  }
  if (Array.isArray(input)) {
    const key = prefix || t("input.value");
    if (input.length === 0) return [{ key, kind: "empty", text: t("input.emptyList") }];
    if (input.every(scalar)) return [{ key, kind: "list", text: input.map((x) => String(x)).join("\n"), items: input.map((x) => String(x)) }];
    return [{ key, kind: "json", text: JSON.stringify(input, null, 2) }];
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [{ key: prefix, kind: "empty", text: t("input.emptyObject") }] : [];
  const out: InputRow[] = [];
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && depth < 3) out.push(...flattenInput(v, key, depth + 1));
    else if (v && typeof v === "object") out.push({ key, kind: "json", text: JSON.stringify(v, null, 2) });
    else out.push(rowFor(key, v));
  }
  return out;
}

/** Split a string into URL / non-URL segments so hosts can be emphasised (anti-phishing). */
export function splitUrls(text: string): Array<{ text: string; url?: { before: string; host: string; after: string } }> {
  const re = /\bhttps?:\/\/[^\s"'<>]+/gi;
  const out: Array<{ text: string; url?: { before: string; host: string; after: string } }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i) });
    const full = m[0];
    const hm = /^(https?:\/\/(?:[^@/\s]*@)?)([^/:?#\s]+)(.*)$/i.exec(full);
    out.push(hm ? { text: full, url: { before: hm[1], host: hm[2], after: hm[3] } } : { text: full });
    last = i + full.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function shortHash(h: string | undefined): string {
  return h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "—";
}

export function actorLabel(actor: string): string {
  if (actor === "user") return t("actor.user");
  if (actor === "core") return t("actor.core");
  const [kind, ...rest] = actor.split(":");
  const id = rest.join(":");
  if (kind === "agent") return t("actor.agent", { id });
  if (kind === "plugin") return t("actor.plugin", { id });
  if (kind === "machine") return t("actor.machine", { id });
  return actor;
}
