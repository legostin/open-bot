// Messages the CLI brains show to people (probe details, failures). The caller passes the language.

import { DEFAULT_LOCALE, translator, type Catalog, type Locale, type Translate } from "@openbot/shared/i18n";

const en = {
  "claude.label": "Claude Code",
  "claude.notInstalled": "Claude Code is not installed (the claude command was not found)",
  "claude.notInstalledShort": "Claude Code is not installed",
  "claude.notSignedIn": "Claude Code is not signed in: run `claude setup-token` on a computer with your subscription and paste the token into the chat",
  "claude.failed": "Claude Code exited with an error",
  "claude.mcpUnavailable": "open-bot tools are unavailable in Claude Code (MCP: {status})",
  "claude.limit": "Claude: subscription limit ({kind})",
  "claude.vaultToken": "token from the vault",
  "claude.signedIn": "signed in: {method}",
  "claude.noLogin": "not signed in: paste a token from `claude setup-token` into the chat",
  "claude.loginUnknown": "could not check the sign-in: paste a token from `claude setup-token` into the chat",
  "codex.label": "Codex (ChatGPT)",
  "codex.notInstalled": "Codex CLI is not installed",
  "codex.notSignedIn": "Codex is not signed in: run `codex login --device-auth` as the agent user",
  "codex.failed": "Codex exited with an error",
  "codex.apiKey": "API key",
  "codex.noLogin": "not signed in: `codex login --device-auth`",
};

const ru: Record<keyof typeof en, string> = {
  "claude.label": "Claude Code",
  "claude.notInstalled": "Claude Code не установлен (команда claude не найдена)",
  "claude.notInstalledShort": "Claude Code не установлен",
  "claude.notSignedIn": "Claude Code не авторизован: выполните `claude setup-token` на компьютере с подпиской и вставьте токен в чат",
  "claude.failed": "Claude Code завершился с ошибкой",
  "claude.mcpUnavailable": "Инструменты open-bot недоступны в Claude Code (MCP: {status})",
  "claude.limit": "Claude: лимит подписки ({kind})",
  "claude.vaultToken": "токен из хранилища",
  "claude.signedIn": "вход: {method}",
  "claude.noLogin": "нет входа: вставьте в чат токен из `claude setup-token`",
  "claude.loginUnknown": "не удалось проверить вход: вставьте в чат токен из `claude setup-token`",
  "codex.label": "Codex (ChatGPT)",
  "codex.notInstalled": "Codex CLI не установлен",
  "codex.notSignedIn": "Codex не авторизован: выполните `codex login --device-auth` от пользователя agent",
  "codex.failed": "Codex завершился с ошибкой",
  "codex.apiKey": "ключ API",
  "codex.noLogin": "нет входа: `codex login --device-auth`",
};

export const brainsCatalog: Catalog = { en, ru };

const cache = new Map<Locale, Translate>();

/** Translate function for a language (English when none is given). */
export function brainsT(locale: Locale = DEFAULT_LOCALE): Translate {
  let t = cache.get(locale);
  if (!t) cache.set(locale, (t = translator(brainsCatalog, locale)));
  return t;
}
