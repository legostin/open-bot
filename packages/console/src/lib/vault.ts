// Vault item form logic: ids, field sets per type, quick-create templates, payload building.

import type { VaultItemType, VaultScope, VaultUpsert } from "../types.ts";

export const TYPE_LABELS: Record<VaultItemType, string> = {
  login: "Логин",
  secret: "Секрет",
  identity: "Личные данные",
  note: "Заметка",
};

export const TYPE_HINTS: Record<VaultItemType, string> = {
  login: "Сайт, имя пользователя и пароль — для входа браузером",
  secret: "API-ключ или токен",
  identity: "Персональные данные: поля «ключ — значение»",
  note: "Защищённый текст",
};

/** Ids are what agents and plugins reference as vault://<id>. */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Same transformation as the server uses when no id is given (packages/core/src/vault/service.ts). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export function validateId(id: string): string | undefined {
  if (!id) return undefined;
  if (!ID_RE.test(id)) return "Только строчные латинские буквы, цифры, «_» и «-», до 64 символов, начиная с буквы или цифры";
  return undefined;
}

export interface VaultTemplate {
  id: string;
  name: string;
  hint: string;
  placeholder: string;
}

export const TEMPLATES: VaultTemplate[] = [
  {
    id: "claude_code_token",
    name: "Claude Code (подписка)",
    hint: "Выполните «claude setup-token» на компьютере с Claude Code, войдите в аккаунт и вставьте выданный токен.",
    placeholder: "sk-ant-oat01-…",
  },
  { id: "anthropic_api_key", name: "Anthropic API", hint: "console.anthropic.com → Settings → API Keys → Create Key.", placeholder: "sk-ant-api03-…" },
  { id: "openai_api_key", name: "OpenAI API", hint: "platform.openai.com → API keys → Create new secret key.", placeholder: "sk-…" },
  { id: "openrouter_api_key", name: "OpenRouter API", hint: "openrouter.ai → Settings → Keys → Create Key.", placeholder: "sk-or-v1-…" },
  { id: "telegram_bot_token", name: "Telegram-бот", hint: "Напишите @BotFather в Telegram, создайте бота командой /newbot — он пришлёт токен.", placeholder: "123456789:AA…" },
  { id: "brave_api_key", name: "Brave Search API", hint: "api-dashboard.search.brave.com → API Keys (есть бесплатный план).", placeholder: "BSA…" },
  { id: "tavily_api_key", name: "Tavily API", hint: "app.tavily.com → API Keys (есть бесплатный план).", placeholder: "tvly-…" },
];

export const IDENTITY_SUGGESTIONS: Array<{ key: string; label: string }> = [
  { key: "full_name", label: "ФИО" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Телефон" },
  { key: "birth_date", label: "Дата рождения" },
  { key: "address", label: "Адрес" },
  { key: "passport", label: "Паспорт" },
  { key: "inn", label: "ИНН" },
];

export const DEFAULT_SCOPE: VaultScope = { domains: [], plugins: [], agents: [], tools: [], mode: "auto", revealToModel: false };

export interface VaultDraft {
  type: VaultItemType;
  name: string;
  id: string;
  url: string;
  username: string;
  password: string;
  totp: string;
  value: string;
  text: string;
  identity: Array<{ key: string; value: string }>;
  scope: VaultScope;
}

export function emptyDraft(type: VaultItemType = "secret"): VaultDraft {
  return {
    type,
    name: "",
    id: "",
    url: "",
    username: "",
    password: "",
    totp: "",
    value: "",
    text: "",
    identity: [{ key: "", value: "" }],
    scope: { ...DEFAULT_SCOPE, plugins: type === "login" ? ["browser"] : [] },
  };
}

/** Split a free-form list ("a, b\nc") into unique trimmed entries. */
export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export type BuildResult = { ok: true; payload: VaultUpsert } | { ok: false; error: string };

/**
 * Turn the form into a PUT /console-api/vault/items body.
 * When editing, empty secret fields are sent as "" — the server keeps the stored value for them.
 */
export function buildPayload(d: VaultDraft, opts: { editing: boolean; existingIds: string[] }): BuildResult {
  const name = d.name.trim();
  if (!name) return { ok: false, error: "Укажите название" };
  const id = d.id.trim();
  if (!opts.editing) {
    const bad = validateId(id);
    if (bad) return { ok: false, error: `Id: ${bad}` };
    const effectiveId = id || slugify(name);
    if (effectiveId && opts.existingIds.includes(effectiveId)) {
      return { ok: false, error: `Запись vault://${effectiveId} уже существует — укажите другой id или измените существующую` };
    }
  }

  let fields: Record<string, string>;
  switch (d.type) {
    case "login": {
      const url = d.url.trim();
      if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: "URL должен начинаться с https:// или http://" };
      if (!opts.editing && !url && d.scope.domains.length === 0) {
        return { ok: false, error: "Укажите URL сайта или домены в области доступа — иначе логин можно будет подставить на любом сайте" };
      }
      if (!opts.editing && !d.password) return { ok: false, error: "Укажите пароль" };
      fields = { url, username: d.username.trim(), password: d.password };
      if (d.totp.trim() || opts.editing) fields.totp = d.totp.replace(/\s+/g, "");
      break;
    }
    case "secret":
      if (!opts.editing && !d.value.trim()) return { ok: false, error: "Укажите значение" };
      fields = { value: d.value.trim() };
      break;
    case "note":
      if (!opts.editing && !d.text) return { ok: false, error: "Введите текст заметки" };
      fields = { text: d.text };
      break;
    case "identity": {
      fields = {};
      for (const row of d.identity) {
        const k = row.key.trim();
        if (!k && !row.value) continue;
        if (!k) return { ok: false, error: "У каждого поля должно быть название" };
        if (k in fields) return { ok: false, error: `Поле «${k}» указано дважды` };
        fields[k] = row.value;
      }
      if (Object.keys(fields).length === 0) return { ok: false, error: "Добавьте хотя бы одно поле" };
      break;
    }
  }

  const scope: VaultScope = {
    domains: d.scope.domains,
    plugins: d.scope.plugins,
    agents: d.scope.agents,
    tools: d.scope.tools,
    mode: d.scope.mode,
    revealToModel: d.scope.revealToModel,
  };
  const payload: VaultUpsert = { type: d.type, name, fields, scope };
  if (id) payload.id = id;
  return { ok: true, payload };
}

/** Rough passphrase strength: 0 (weak) … 4 (strong). Length dominates; character variety helps a little. */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!p) return { score: 0, label: "" };
  let classes = 0;
  if (/[a-zа-яё]/.test(p)) classes++;
  if (/[A-ZА-ЯЁ]/.test(p)) classes++;
  if (/\d/.test(p)) classes++;
  if (/[^a-zA-Zа-яА-ЯёЁ\d]/.test(p)) classes++;
  const unique = new Set(p).size;
  let bits = p.length * Math.log2(Math.max(10, classes * 20));
  if (unique < p.length / 2) bits *= 0.6;
  const score: 0 | 1 | 2 | 3 | 4 = p.length < 8 ? 0 : bits < 45 ? 1 : bits < 65 ? 2 : bits < 85 ? 3 : 4;
  const label = ["слишком короткий", "слабый", "средний", "хороший", "сильный"][score];
  return { score, label };
}
