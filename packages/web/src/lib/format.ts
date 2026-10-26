// Formatting helpers (Russian UI).

import type { NotifyLevel, TaskStatus } from "@openbot/shared";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  queued: { label: "в очереди", tone: "neutral" },
  running: { label: "выполняется", tone: "info" },
  waiting_approval: { label: "ждёт подтверждения", tone: "warning" },
  waiting_input: { label: "ждёт ответа", tone: "warning" },
  interrupted: { label: "прервана", tone: "warning" },
  paused: { label: "на паузе", tone: "neutral" },
  done: { label: "готово", tone: "success" },
  failed: { label: "ошибка", tone: "danger" },
  cancelled: { label: "отменена", tone: "neutral" },
};

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "interrupted", "paused"];

export const NOTIFY_LEVEL: Record<NotifyLevel, { label: string; tone: Tone }> = {
  silent: { label: "тихо", tone: "neutral" },
  digest: { label: "в сводку", tone: "info" },
  notify: { label: "уведомление", tone: "success" },
  ask: { label: "вопрос", tone: "warning" },
};

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("ru", { numeric: "auto" }) : undefined;

/** "только что", "5 минут назад", "через 2 часа", or a date for older values. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff <= 0 ? "только что" : "через минуту";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60_000],
    ["hour", 3_600_000],
    ["day", 86_400_000],
  ];
  if (abs < 3_600_000) return rtf ? rtf.format(Math.round(diff / units[0][1]), "minute") : "";
  if (abs < 86_400_000) return rtf ? rtf.format(Math.round(diff / units[1][1]), "hour") : "";
  if (abs < 7 * 86_400_000) return rtf ? rtf.format(Math.round(diff / units[2][1]), "day") : "";
  return formatDateTime(iso);
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
}

/** Lowercase slug for ids: latin letters, digits, dashes. */
export function slugify(s: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return s
    .toLowerCase()
    .split("")
    .map((c) => map[c] ?? c)
    .join("")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40);
}
