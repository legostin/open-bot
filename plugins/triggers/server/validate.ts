// Input validation for creating and updating triggers (shared by agent tools and the UI API).

import { randomBytes } from "node:crypto";
import { cronError, parseDateTime, timeError } from "./schedule.ts";
import { TRIGGER_KINDS, type Trigger, type TriggerInput, type TriggerKind } from "./types.ts";
import { parseJsonPath, selectorError, WatchError } from "./watch.ts";

export class ValidationError extends Error {}

export const MIN_WATCH_MINUTES = 5;
export const DEFAULT_WATCH_MINUTES = 60;
export const DEFAULT_MAX_RUNS = 24;
export const DEFAULT_HEARTBEAT_TIMES = ["10:00", "18:00"];
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

export const newTriggerId = () => `t_${randomBytes(5).toString("hex")}`;
export const newSecret = () => randomBytes(24).toString("base64url");

const str = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) fail(`Поле ${field} обязательно`);
  const s = (v as string).trim();
  if (s.length > max) fail(`Поле ${field} слишком длинное (максимум ${max} символов)`);
  return s;
};

const optStr = (v: unknown, field: string, max: number): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") fail(`Поле ${field} должно быть строкой`);
  return str(v, field, max);
};

function checkUrl(v: unknown): string {
  const url = str(v, "url", 2000);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail(`Неверный адрес "${url}": нужен полный URL, например https://example.com/page`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail("Поддерживаются только адреса http и https");
  return u.toString();
}

function checkInterval(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) fail("intervalMinutes должно быть числом минут");
  if (n < MIN_WATCH_MINUTES) fail(`Интервал проверки — не меньше ${MIN_WATCH_MINUTES} минут (указано ${n})`);
  if (n > 7 * 24 * 60) fail("Интервал проверки — не больше недели (10080 минут)");
  return Math.round(n);
}

function checkTimes(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) fail('times — непустой список времени "ЧЧ:ММ", например ["10:00", "18:00"]');
  for (const t of v as unknown[]) {
    const e = timeError(t);
    if (e) fail(e);
  }
  return [...new Set(v as string[])].sort();
}

function checkWeekdays(v: unknown): number[] {
  if (!Array.isArray(v) || !v.length) fail("weekdays — непустой список дней недели 0–6 (0 = воскресенье)");
  for (const d of v as unknown[]) if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) fail(`День недели ${String(d)} вне диапазона 0–6 (0 = воскресенье)`);
  return [...new Set(v as number[])].sort();
}

function checkMaxRuns(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1000) fail("maxRunsPerDay — целое число от 1 до 1000");
  return n;
}

function checkAt(v: unknown, tz: string, now: Date): string {
  const s = str(v, "at", 64);
  const d = parseDateTime(s, tz);
  if (!d) return fail(`Не понимаю время "${s}": нужен ISO-формат, например 2026-10-27T09:00 (время пользователя) или 2026-10-27T06:00:00Z`);
  if (d.getTime() <= now.getTime()) fail(`Время "${s}" уже прошло`);
  return d.toISOString();
}

function checkWatchTarget(selector: unknown, jsonPath: unknown): { selector?: string; jsonPath?: string } {
  const sel = optStr(selector, "selector", 500);
  const jp = optStr(jsonPath, "jsonPath", 500);
  if (sel && jp) fail("Укажите что-то одно: selector (для HTML) или jsonPath (для JSON)");
  if (sel) {
    const e = selectorError(sel);
    if (e) fail(e);
  }
  if (jp) {
    try {
      parseJsonPath(jp);
    } catch (e) {
      if (e instanceof WatchError) fail(e.message);
      throw e;
    }
  }
  return { selector: sel, jsonPath: jp };
}

export interface BuildOptions {
  now: Date;
  tz: string;
  defaultAgent: string;
  createdBy: string;
}

export function buildTrigger(input: TriggerInput, o: BuildOptions): Trigger {
  if (!input || typeof input !== "object") fail("Нет данных триггера");
  const kind = input.kind as TriggerKind;
  if (!TRIGGER_KINDS.includes(kind)) fail(`Неизвестный вид триггера "${String(input.kind)}". Допустимо: ${TRIGGER_KINDS.join(", ")}`);
  const prompt = str(input.prompt, "prompt", 8000);
  const name = input.name === undefined || input.name === "" ? prompt.split("\n")[0].slice(0, 60) : str(input.name, "name", 120);
  const nowIso = o.now.toISOString();
  const t: Trigger = {
    id: newTriggerId(),
    kind,
    name,
    prompt,
    agentId: optStr(input.agent ?? input.agentId, "agent", 64) ?? o.defaultAgent,
    enabled: input.enabled ?? true,
    maxRunsPerDay: input.maxRunsPerDay === undefined ? DEFAULT_MAX_RUNS : checkMaxRuns(input.maxRunsPerDay),
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: o.createdBy,
    state: {},
  };
  switch (kind) {
    case "schedule": {
      const e = cronError(input.cron);
      if (e) fail(e);
      t.cron = (input.cron as string).trim().replace(/\s+/g, " ");
      break;
    }
    case "once":
      t.at = checkAt(input.at, o.tz, o.now);
      break;
    case "watch":
      t.url = checkUrl(input.url);
      t.intervalMinutes = input.intervalMinutes === undefined ? DEFAULT_WATCH_MINUTES : checkInterval(input.intervalMinutes);
      Object.assign(t, checkWatchTarget(input.selector, input.jsonPath));
      break;
    case "event":
      t.secret = newSecret();
      break;
    case "heartbeat":
      t.times = input.times === undefined ? [...DEFAULT_HEARTBEAT_TIMES] : checkTimes(input.times);
      t.weekdays = input.weekdays === undefined ? [...DEFAULT_WEEKDAYS] : checkWeekdays(input.weekdays);
      break;
  }
  return t;
}

/** Apply a partial update; returns a new trigger. Changing what a watch looks at resets its baseline. */
export function applyUpdate(t: Trigger, patch: TriggerInput, o: { now: Date; tz: string }): Trigger {
  if (!patch || typeof patch !== "object") fail("Нет данных для изменения");
  if (patch.kind !== undefined && patch.kind !== t.kind) fail("Вид триггера менять нельзя — создайте новый триггер");
  const next: Trigger = { ...t, state: { ...t.state } };
  if (patch.name !== undefined) next.name = str(patch.name, "name", 120);
  if (patch.prompt !== undefined) next.prompt = str(patch.prompt, "prompt", 8000);
  if (patch.agent !== undefined || patch.agentId !== undefined) next.agentId = str(patch.agent ?? patch.agentId, "agent", 64);
  if (patch.maxRunsPerDay !== undefined) next.maxRunsPerDay = checkMaxRuns(patch.maxRunsPerDay);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") fail("enabled должно быть true или false");
    next.enabled = patch.enabled;
  }
  switch (t.kind) {
    case "schedule":
      if (patch.cron !== undefined) {
        const e = cronError(patch.cron);
        if (e) fail(e);
        next.cron = patch.cron.trim().replace(/\s+/g, " ");
      }
      break;
    case "once":
      if (patch.at !== undefined) {
        next.at = checkAt(patch.at, o.tz, o.now);
        next.state.done = false;
        if (patch.enabled === undefined) next.enabled = true;
      } else if (next.enabled && !t.enabled && t.state.done) fail("Этот одноразовый триггер уже сработал — укажите новое время (at)");
      break;
    case "watch": {
      if (patch.url !== undefined) next.url = checkUrl(patch.url);
      if (patch.intervalMinutes !== undefined) next.intervalMinutes = checkInterval(patch.intervalMinutes);
      if (patch.selector !== undefined || patch.jsonPath !== undefined) {
        const target = checkWatchTarget(patch.selector === undefined ? t.selector : patch.selector, patch.jsonPath === undefined ? t.jsonPath : patch.jsonPath);
        next.selector = target.selector;
        next.jsonPath = target.jsonPath;
      }
      if (next.url !== t.url || next.selector !== t.selector || next.jsonPath !== t.jsonPath) {
        delete next.state.lastHash;
        delete next.state.lastValue;
        delete next.state.lastCheckedAt;
      }
      break;
    }
    case "heartbeat":
      if (patch.times !== undefined) next.times = checkTimes(patch.times);
      if (patch.weekdays !== undefined) next.weekdays = checkWeekdays(patch.weekdays);
      break;
    case "event":
      break;
  }
  next.updatedAt = o.now.toISOString();
  return next;
}
