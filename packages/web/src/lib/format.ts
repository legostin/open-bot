// Formatting helpers: status labels, relative times and dates in the interface language.

import type { NotifyLevel, TaskStatus } from "@openbot/shared";
import { formatDate, formatRelative, t, type MessageKey } from "../i18n";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TASK_STATUS: Record<TaskStatus, { key: MessageKey; tone: Tone }> = {
  queued: { key: "taskStatus.queued", tone: "neutral" },
  running: { key: "taskStatus.running", tone: "info" },
  waiting_approval: { key: "taskStatus.waitingApproval", tone: "warning" },
  waiting_input: { key: "taskStatus.waitingInput", tone: "warning" },
  interrupted: { key: "taskStatus.interrupted", tone: "warning" },
  paused: { key: "taskStatus.paused", tone: "neutral" },
  done: { key: "taskStatus.done", tone: "success" },
  failed: { key: "taskStatus.failed", tone: "danger" },
  cancelled: { key: "taskStatus.cancelled", tone: "neutral" },
};

/** Label and badge tone of a task status (unknown statuses are shown as they are). */
export function taskStatus(s: string): { label: string; tone: Tone } {
  const st = TASK_STATUS[s as TaskStatus];
  return st ? { label: t(st.key), tone: st.tone } : { label: s, tone: "neutral" };
}

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "interrupted", "paused"];

const NOTIFY_LEVEL: Record<NotifyLevel, { key: MessageKey; tone: Tone }> = {
  silent: { key: "notifyLevel.silent", tone: "neutral" },
  digest: { key: "notifyLevel.digest", tone: "info" },
  notify: { key: "notifyLevel.notify", tone: "success" },
  ask: { key: "notifyLevel.ask", tone: "warning" },
};

export function notifyLevel(level: string): { label: string; tone: Tone } {
  const l = NOTIFY_LEVEL[level as NotifyLevel];
  return l ? { label: t(l.key), tone: l.tone } : { label: level, tone: "neutral" };
}

/** "just now", "5 minutes ago", "in 2 hours", or a date for older values. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff <= 0 ? t("time.justNow") : t("time.inAMinute");
  if (abs < 3_600_000) return formatRelative(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return formatRelative(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * 86_400_000) return formatRelative(Math.round(diff / 86_400_000), "day");
  return formatDateTime(iso);
}

export function formatDateTime(iso: string | undefined): string {
  return iso ? formatDate(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

export function formatTime(iso: string | undefined): string {
  return iso ? formatDate(iso, { hour: "2-digit", minute: "2-digit" }) : "";
}

// Transliteration for ids made from Cyrillic names: U+0430..U+044F in alphabet order, then U+0451 (yo).
// Built from code points so the source stays ASCII (Cyrillic lives only in i18n/ru.ts).
const CYRILLIC_LATIN = ["a", "b", "v", "g", "d", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "h", "c", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"];
const TRANSLIT: Record<string, string> = Object.fromEntries([...CYRILLIC_LATIN.map((l, i) => [String.fromCharCode(0x430 + i), l]), [String.fromCharCode(0x451), "e"]]);

/** Lowercase slug for ids: latin letters, digits, dashes. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40);
}
