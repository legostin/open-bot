// Telegram channel: long polling, pairing with exactly one chat, inbound chat, outbound messages,
// approval and feedback buttons.

import { randomInt } from "node:crypto";
import type { PluginContext, PluginHttpRequest, PluginHttpResponse } from "@openbot/plugin-sdk";
import type { OutboundMessage, Task, TaskStatus } from "@openbot/shared";
import { TelegramApi, TelegramError, type InlineButton, type TgCallbackQuery, type TgChat, type TgMessage, type TgUpdate, type TgUser } from "./api.ts";
import { TELEGRAM_LIMIT, entitiesToHtml, escapeHtml, htmlToPlain, isPublicHttpUrl, markdownToHtml, splitMarkdown } from "./format.ts";

export interface TelegramSettings {
  botTokenRef: string;
  apiBaseUrl: string;
  pollTimeoutSec: number;
  tokenRetrySec: number;
}

export function readSettings(s: Record<string, any> = {}): TelegramSettings {
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.min(max, n) : def;
  };
  return {
    botTokenRef: typeof s.botTokenRef === "string" && s.botTokenRef.trim() ? s.botTokenRef.trim() : "vault://telegram_bot_token",
    apiBaseUrl: typeof s.apiBaseUrl === "string" && /^https?:\/\//.test(s.apiBaseUrl) ? s.apiBaseUrl : "https://api.telegram.org",
    pollTimeoutSec: num(s.pollTimeoutSec, 30, 0, 50),
    tokenRetrySec: num(s.tokenRetrySec, 60, 0.05, 3600),
  };
}

export interface BoundChat {
  id: number;
  type: string;
  name: string;
  boundAt: string;
}

type State = "starting" | "no-token" | "unauthorized" | "polling" | "error" | "stopped";

const TYPING_MAX_MS = 120_000;
const TYPING_EVERY_MS = 4_500;
const MAX_FAILS_PER_CHAT = 5;
const MAX_FAILS_TOTAL = 20;

const HELP = [
  "<b>open-bot в Telegram</b>",
  "",
  "Пишите сюда как в чат с ассистентом — я передам сообщение и пришлю ответ.",
  "Сюда же приходят уведомления и запросы на подтверждение действий.",
  "",
  "/tasks — задачи в работе и недавние",
  "/stop — остановить текущую работу ассистента",
  "/help — эта справка",
].join("\n");

const STATUS_RU: Record<TaskStatus, string> = {
  queued: "в очереди",
  running: "выполняется",
  waiting_approval: "ждёт подтверждения",
  waiting_input: "ждёт ответа",
  interrupted: "прервана",
  paused: "на паузе",
  done: "готово",
  failed: "ошибка",
  cancelled: "отменена",
};
const FINAL: TaskStatus[] = ["done", "failed", "cancelled"];

const fitsCallback = (data: string) => Buffer.byteLength(data, "utf8") <= 64;

function chatName(chat: TgChat, from?: TgUser): string {
  const person = [chat.first_name ?? from?.first_name, chat.last_name ?? from?.last_name].filter(Boolean).join(" ");
  const user = chat.username ?? from?.username;
  return chat.title ?? (person ? (user ? `${person} (@${user})` : person) : user ? `@${user}` : String(chat.id));
}

export class TelegramBot {
  ctx: PluginContext;
  settings: TelegramSettings;
  api?: TelegramApi;
  botUser?: TgUser;
  chat?: BoundChat;
  pairingCode?: string;
  offset = 0;
  state: State = "starting";
  lastError?: string;
  lastSendError?: string;

  private stopped = false;
  private ctrl = new AbortController();
  private wake?: () => void;
  private loopDone?: Promise<void>;
  private typing?: { timer: NodeJS.Timeout; until: number };
  private foreignReplied = new Set<number>();
  private pairingFails = new Map<number, number>();
  private pairingFailsTotal = 0;
  private lastEmitted = "";

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.settings = readSettings(ctx.settings);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const st = this.ctx.storage;
    this.chat = (await st.get<BoundChat>("chat")) ?? undefined;
    this.pairingCode = (await st.get<string>("pairingCode")) ?? undefined;
    for (const { key } of await st.list("foreign:")) this.foreignReplied.add(Number(key.slice("foreign:".length)));
    if (!this.chat && !this.pairingCode) await this.newPairingCode();
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.state = "stopped";
    this.ctrl.abort();
    this.wake?.();
    this.stopTyping();
    if (this.loopDone) await Promise.race([this.loopDone, new Promise((r) => setTimeout(r, 3000))]);
  }

  updateSettings(raw: Record<string, any>): void {
    const prev = this.settings;
    this.settings = readSettings(raw);
    if (prev.botTokenRef !== this.settings.botTokenRef || prev.apiBaseUrl !== this.settings.apiBaseUrl) this.reconnect();
  }

  /** Vault unlocked: retry right away instead of waiting for the next token check. */
  onVaultState(p: { state?: string } | undefined): void {
    if (p?.state === "unlocked" && !this.api) this.wake?.();
  }

  private reconnect(): void {
    this.api = undefined;
    this.botUser = undefined;
    this.setState("starting");
    const old = this.ctrl;
    this.ctrl = new AbortController();
    old.abort();
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  // ---------- polling ----------

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const signal = this.ctrl.signal;
      try {
        if (!this.api && !(await this.connect(signal))) {
          if (!this.stopped && !signal.aborted) await this.sleep(this.settings.tokenRetrySec * 1000);
          continue;
        }
        const timeout = this.settings.pollTimeoutSec;
        const updates = await this.api!.call<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset || undefined, timeout, allowed_updates: ["message", "callback_query"] },
          { signal, timeoutMs: (timeout + 15) * 1000 },
        );
        failures = 0;
        this.setState("polling");
        for (const u of updates) {
          if (this.stopped || signal.aborted) break;
          this.offset = u.update_id + 1;
          try {
            await this.handleUpdate(u);
          } catch (e: any) {
            this.ctx.log.error(`update ${u.update_id} failed: ${e?.message ?? e}`);
          }
          await this.ctx.storage.set(this.offsetKey(), this.offset);
        }
      } catch (e: any) {
        if (this.stopped) break;
        if (signal.aborted) continue; // settings changed: reconnect
        if (e instanceof TelegramError && e.unauthorized) {
          this.api = undefined;
          this.setState("unauthorized", "Telegram не принял токен бота — проверьте запись в vault");
          await this.sleep(this.settings.tokenRetrySec * 1000);
          continue;
        }
        if (e instanceof TelegramError && e.code === 409 && /webhook/i.test(e.message)) {
          // A webhook left over from another setup blocks long polling.
          await this.api?.call("deleteWebhook", {}).catch(() => {});
        }
        failures++;
        this.setState("error", e?.message ?? String(e));
        const retryAfter = e instanceof TelegramError && e.retryAfter ? e.retryAfter * 1000 : 0;
        await this.sleep(Math.max(retryAfter, Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6))));
      }
    }
  }

  private async connect(signal: AbortSignal): Promise<boolean> {
    let token: string | undefined;
    try {
      const fields = await this.ctx.vault.get(this.settings.botTokenRef, { reason: "Telegram bot" });
      token = (fields.value ?? fields.token ?? fields.password ?? "").trim();
    } catch (e: any) {
      this.setState("no-token", `Нет токена бота (${this.settings.botTokenRef}): ${e?.message ?? e}`);
      return false;
    }
    if (!token) {
      this.setState("no-token", `В записи ${this.settings.botTokenRef} нет поля value с токеном бота`);
      return false;
    }
    const api = new TelegramApi(this.settings.apiBaseUrl, token);
    try {
      this.botUser = await api.call<TgUser>("getMe", {}, { signal });
    } catch (e) {
      if (e instanceof TelegramError && e.unauthorized) {
        this.setState("unauthorized", "Telegram не принял токен бота — проверьте запись в vault");
        return false;
      }
      throw e;
    }
    // Update ids are per bot: a new token starts from its own offset.
    this.offset = Number(await this.ctx.storage.get<number>(this.offsetKey())) || 0;
    this.api = api;
    this.ctx.log.info(`connected as @${this.botUser.username ?? this.botUser.id}`);
    return true;
  }

  private offsetKey(): string {
    return `offset:${this.botUser?.id ?? "unknown"}`;
  }

  private setState(state: State, error?: string): void {
    this.state = state;
    this.lastError = state === "polling" || state === "starting" ? undefined : error;
    this.emitStatus();
  }

  // ---------- updates ----------

  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m?.chat) return;
    if (!this.chat) return this.onUnbound(m);
    if (m.chat.id !== this.chat.id) return this.onForeign(m);
    return this.onOwner(m);
  }

  private async onUnbound(m: TgMessage): Promise<void> {
    const text = (m.text ?? "").trim();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text);
    if (!start) {
      await this.replyOnce(m.chat, "Это личный бот open-bot. Чтобы привязать его, отправьте <code>/start КОД</code> — код показан в настройках open-bot (раздел Telegram).");
      return;
    }
    if (m.chat.type !== "private") {
      await this.replyOnce(m.chat, "Привязать можно только личный чат с ботом.");
      return;
    }
    const fails = this.pairingFails.get(m.chat.id) ?? 0;
    if (fails >= MAX_FAILS_PER_CHAT) return;
    const code = start[1];
    if (!code) {
      await this.sendHtml(m.chat.id, "Отправьте <code>/start КОД</code> — шестизначный код из настроек open-bot (раздел Telegram).");
      return;
    }
    if (!this.pairingCode || code !== this.pairingCode) {
      this.pairingFails.set(m.chat.id, fails + 1);
      if (++this.pairingFailsTotal >= MAX_FAILS_TOTAL) await this.newPairingCode();
      await this.sendHtml(
        m.chat.id,
        fails + 1 >= MAX_FAILS_PER_CHAT ? "Слишком много неверных попыток. Привязка из этого чата заблокирована." : "Код не подошёл. Проверьте код в настройках open-bot и попробуйте ещё раз.",
      );
      return;
    }
    await this.bind(m.chat, m.from);
  }

  private async bind(chat: TgChat, from?: TgUser): Promise<void> {
    this.chat = { id: chat.id, type: chat.type, name: chatName(chat, from), boundAt: new Date().toISOString() };
    await this.ctx.storage.set("chat", this.chat);
    await this.ctx.storage.delete("pairingCode");
    this.pairingCode = undefined;
    this.pairingFails.clear();
    this.pairingFailsTotal = 0;
    this.ctx.log.info(`bound to chat ${chat.id}`);
    const name = from?.first_name ? `, ${escapeHtml(from.first_name)}` : "";
    await this.sendHtml(
      chat.id,
      `👋 Привет${name}! Готово — этот чат привязан к open-bot.\n\n` +
        "Пишите сюда как в чат с ассистентом: я передам сообщение и пришлю ответ. " +
        "Сюда же будут приходить уведомления и запросы на подтверждение действий.\n\n" +
        "/help — справка, /tasks — задачи, /stop — остановить текущую работу.",
    );
    this.emitStatus(true);
  }

  private async onForeign(m: TgMessage): Promise<void> {
    await this.replyOnce(m.chat, "Извините, этот бот личный и уже привязан к другому чату.");
  }

  /** One polite reply per foreign chat, remembered across restarts. */
  private async replyOnce(chat: TgChat, html: string): Promise<void> {
    if (this.foreignReplied.has(chat.id)) return;
    this.foreignReplied.add(chat.id);
    await this.ctx.storage.set(`foreign:${chat.id}`, true);
    await this.sendHtml(chat.id, html).catch(() => {});
  }

  private async onOwner(m: TgMessage): Promise<void> {
    const chatId = m.chat.id;
    if (typeof m.text !== "string") {
      await this.sendHtml(chatId, "Пока я понимаю только текстовые сообщения — напишите, пожалуйста, текстом.");
      return;
    }
    const text = m.text.trim();
    if (!text) return;
    const cmd = /^\/([a-z0-9_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd) {
      if (cmd[2] && this.botUser?.username && cmd[2].toLowerCase() !== this.botUser.username.toLowerCase()) return;
      switch (cmd[1].toLowerCase()) {
        case "start":
          await this.sendHtml(chatId, "Этот чат уже привязан к open-bot. Просто напишите, что нужно сделать.");
          return;
        case "help":
          await this.sendHtml(chatId, HELP);
          return;
        case "tasks":
          await this.sendTasks(chatId);
          return;
        case "stop": {
          this.stopTyping();
          try {
            const r = await this.ctx.core.call<{ interrupted?: boolean }>("channels.inbound", { channel: "telegram", text: "/stop" });
            await this.sendHtml(chatId, r?.interrupted ? "⏹ Остановил текущую работу." : "Сейчас ничего не выполняется.");
          } catch (e: any) {
            await this.sendHtml(chatId, `Не удалось остановить: ${escapeHtml(e?.message ?? String(e))}`);
          }
          return;
        }
      }
      // Other slash commands go to the assistant as text (skills and commands).
    }
    this.startTyping();
    try {
      const r = await this.ctx.core.call<{ ignored?: boolean }>("channels.inbound", { channel: "telegram", text });
      if (r?.ignored) this.stopTyping();
    } catch (e: any) {
      this.stopTyping();
      await this.sendHtml(chatId, `Не удалось передать сообщение ассистенту: ${escapeHtml(e?.message ?? String(e))}`);
    }
  }

  private async sendTasks(chatId: number): Promise<void> {
    let tasks: Task[];
    try {
      tasks = (await this.ctx.core.call<Task[]>("tasks.list", { limit: 30 })) ?? [];
    } catch (e: any) {
      await this.sendHtml(chatId, `Не удалось получить задачи: ${escapeHtml(e?.message ?? String(e))}`);
      return;
    }
    const line = (t: Task) => `• ${escapeHtml(t.title || t.goal.slice(0, 60))} — <i>${STATUS_RU[t.status] ?? t.status}</i>`;
    const active = tasks.filter((t) => !FINAL.includes(t.status)).slice(0, 15);
    const recent = tasks.filter((t) => FINAL.includes(t.status)).slice(0, 5);
    const parts: string[] = [];
    if (active.length) parts.push("<b>В работе</b>", ...active.map(line));
    if (recent.length) parts.push(...(parts.length ? [""] : []), "<b>Недавно завершены</b>", ...recent.map(line));
    await this.sendHtml(chatId, parts.length ? parts.join("\n") : "Задач пока нет.");
  }

  // ---------- typing indicator ----------

  private startTyping(): void {
    const until = Date.now() + TYPING_MAX_MS;
    if (this.typing) {
      this.typing.until = until;
      return;
    }
    const tick = () => {
      if (!this.typing || Date.now() > this.typing.until || !this.api || !this.chat) return this.stopTyping();
      void this.api.call("sendChatAction", { chat_id: this.chat.id, action: "typing" }).catch(() => {});
    };
    this.typing = { until, timer: setInterval(tick, TYPING_EVERY_MS) };
    tick();
  }

  private stopTyping(): void {
    if (this.typing) clearInterval(this.typing.timer);
    this.typing = undefined;
  }

  // ---------- callbacks (buttons) ----------

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    const api = this.api;
    if (!api) return;
    const answer = (text?: string, alert = false) =>
      api.call("answerCallbackQuery", { callback_query_id: q.id, text: text?.slice(0, 190), show_alert: alert || undefined }).catch(() => {});
    const msg = q.message;
    if (!this.chat || !msg || msg.chat.id !== this.chat.id) {
      await answer("Эта кнопка недоступна.");
      return;
    }
    const data = q.data ?? "";
    const a = /^a:([^:]+):([ad]):(.+)$/.exec(data);
    if (a) {
      const decision = a[2] === "a" ? "approve" : "deny";
      try {
        await this.ctx.core.call("approvals.resolve", { id: a[1], decision, token: a[3] });
        const label = decision === "approve" ? "✅ Разрешено" : "❌ Отклонено";
        await answer(label);
        await this.markOutcome(msg, label);
      } catch (e: any) {
        const message = String(e?.message ?? e);
        // Already answered elsewhere (console, a second tap): show the actual outcome instead of an error.
        const done = /уже обработано \((\w+)\)/.exec(message)?.[1];
        const known: Record<string, string> = { approved: "✅ Разрешено", executed: "✅ Разрешено и выполнено", denied: "❌ Отклонено", expired: "⌛ Время на ответ истекло", failed: "⚠️ Разрешено, но выполнение не удалось" };
        if (done && known[done]) {
          await answer(`Уже обработано: ${known[done]}`);
          await this.markOutcome(msg, known[done]);
          return;
        }
        const text = `Не получилось: ${message}`;
        await answer(text, true);
        await this.markOutcome(msg, `⚠️ ${text}`);
      }
      return;
    }
    const f = /^f:([^:]+):([ulo]):(.+)$/.exec(data);
    if (f) {
      const value = ({ u: "useful", l: "less", o: "off" } as const)[f[2] as "u" | "l" | "o"];
      try {
        await this.ctx.core.call("notifications.feedback", { id: f[1], value, token: f[3] });
        const label = { useful: "👍 Спасибо, учту!", less: "🔉 Хорошо, буду писать реже.", off: "🔕 Больше не буду присылать такие уведомления." }[value];
        await answer(label);
        await this.markOutcome(msg, label);
      } catch (e: any) {
        await answer(`Не получилось: ${e?.message ?? String(e)}`, true);
      }
      return;
    }
    await answer();
  }

  /** Append the outcome to the message and drop the callback buttons (URL buttons stay). */
  private async markOutcome(msg: TgMessage, label: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    const keep = (msg.reply_markup?.inline_keyboard ?? []).map((row) => row.filter((b) => b.url)).filter((row) => row.length);
    const base = { chat_id: msg.chat.id, message_id: msg.message_id };
    const html = `${entitiesToHtml(msg.text ?? "", msg.entities)}\n\n<b>${escapeHtml(label)}</b>`;
    try {
      if (htmlToPlain(html).length > TELEGRAM_LIMIT) throw new Error("too long");
      await api.call("editMessageText", { ...base, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keep } });
    } catch (e) {
      if (e instanceof TelegramError && e.notModified) return;
      await api.call("editMessageReplyMarkup", { ...base, reply_markup: { inline_keyboard: keep } }).catch(() => {});
    }
  }

  // ---------- outbound ----------

  async send(msg: OutboundMessage): Promise<{ externalId?: string }> {
    if (msg.kind === "reply") this.stopTyping();
    if (!this.chat) return {};
    if (!this.api) throw new Error(this.lastError ?? "Telegram не подключён");
    const chatId = this.chat.id;
    const buttons: InlineButton[][] = [];
    let footer = "";

    if (msg.kind === "approval" && msg.approval) {
      const a = msg.approval;
      const yes = `a:${a.id}:a:${a.approveToken}`;
      const no = `a:${a.id}:d:${a.denyToken}`;
      if (fitsCallback(yes) && fitsCallback(no)) {
        buttons.push([
          { text: "✅ Разрешить", callback_data: yes },
          { text: "❌ Отклонить", callback_data: no },
        ]);
      }
      if (msg.link) {
        footer = `\n\n🔐 Подробности и ответ на пульте: ${escapeHtml(msg.link)}`;
        if (isPublicHttpUrl(msg.link, { httpsOnly: true })) buttons.push([{ text: "🔐 Открыть пульт", url: msg.link }]);
      }
    }
    if (msg.feedback) {
      const id = msg.feedback.notificationId;
      const t = msg.feedback.tokens;
      const row = [
        { text: "👍 Полезно", callback_data: `f:${id}:u:${t.useful}` },
        { text: "🔉 Реже", callback_data: `f:${id}:l:${t.less}` },
        { text: "🔕 Выключить", callback_data: `f:${id}:o:${t.off}` },
      ];
      if (row.every((b) => fitsCallback(b.callback_data))) buttons.push(row);
    }
    if ((msg.kind === "notification" || msg.kind === "digest") && msg.link && isPublicHttpUrl(msg.link, { httpsOnly: true })) {
      buttons.push([{ text: "Открыть", url: msg.link }]);
    }

    const chunks = splitMarkdown(msg.text ?? "", TELEGRAM_LIMIT - 96 - htmlToPlain(footer).length);
    if (!chunks.length) chunks.push("");
    let lastId: number | undefined;
    for (let i = 0; i < chunks.length; i++) {
      let html: string;
      if (i === 0 && (msg.kind === "notification" || msg.kind === "digest")) {
        // The first line is the title.
        const [first, ...rest] = chunks[0].split("\n");
        html = `<b>${escapeHtml(first)}</b>${rest.length ? "\n" + markdownToHtml(rest.join("\n")) : ""}`;
      } else html = markdownToHtml(chunks[i]);
      const last = i === chunks.length - 1;
      if (last) html += footer;
      if (!html.trim()) html = "…";
      const sent = await this.sendHtml(chatId, html, {
        buttons: last ? buttons : undefined,
        silent: msg.silent,
        preview: msg.kind === "reply",
      });
      lastId = sent?.message_id;
    }
    return lastId !== undefined ? { externalId: String(lastId) } : {};
  }

  private async sendHtml(chatId: number, html: string, opts: { buttons?: InlineButton[][]; silent?: boolean; preview?: boolean } = {}): Promise<TgMessage | undefined> {
    const api = this.api;
    if (!api) throw new Error("Telegram не подключён");
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_notification: opts.silent || undefined,
      link_preview_options: opts.preview ? undefined : { is_disabled: true },
      reply_markup: opts.buttons?.length ? { inline_keyboard: opts.buttons } : undefined,
    };
    try {
      const r = await api.send<TgMessage>("sendMessage", params);
      this.lastSendError = undefined;
      return r;
    } catch (e) {
      if (e instanceof TelegramError && e.parseError) {
        this.ctx.log.warn(`HTML rejected (${e.message}), sending as plain text`);
        return api.send<TgMessage>("sendMessage", { ...params, text: htmlToPlain(html), parse_mode: undefined });
      }
      if (e instanceof TelegramError && e.code === 403 && this.chat?.id === chatId) {
        this.lastSendError = "Бот заблокирован в привязанном чате";
        this.emitStatus();
      }
      throw e;
    }
  }

  // ---------- pairing / status / http ----------

  async newPairingCode(): Promise<string> {
    this.pairingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pairingFails.clear();
    this.pairingFailsTotal = 0;
    await this.ctx.storage.set("pairingCode", this.pairingCode);
    this.emitStatus(true);
    return this.pairingCode;
  }

  async unbind(): Promise<void> {
    const old = this.chat;
    this.chat = undefined;
    this.stopTyping();
    await this.ctx.storage.delete("chat");
    await this.newPairingCode();
    if (old && this.api) await this.sendHtml(old.id, "Этот чат отвязан от open-bot. Сообщения сюда больше не приходят.").catch(() => {});
  }

  detail(): string {
    const bot = this.botUser?.username ? `@${this.botUser.username}` : "Бот";
    switch (this.state) {
      case "starting":
        return "Подключение к Telegram…";
      case "stopped":
        return "Остановлен";
      case "no-token":
      case "unauthorized":
        return this.lastError ?? "Нет токена бота";
      case "error":
        return `Нет связи с Telegram: ${this.lastError ?? "ошибка"}`;
      case "polling":
        if (!this.chat) return `${bot} ждёт привязки: отправьте ему /start ${this.pairingCode ?? ""}`.trim();
        return this.lastSendError ? `${bot}: ${this.lastSendError}` : `${bot} привязан к чату «${this.chat.name}»`;
    }
  }

  statusInfo() {
    const username = this.botUser?.username;
    return {
      connected: this.state === "polling" && !!this.chat,
      state: this.state,
      detail: this.detail(),
      bot: this.botUser ? { id: this.botUser.id, username: username ?? null, name: this.botUser.first_name ?? null } : null,
      chat: this.chat ?? null,
      pairingCode: this.chat ? null : (this.pairingCode ?? null),
      deepLink: !this.chat && username && this.pairingCode ? `https://t.me/${username}?start=${this.pairingCode}` : null,
      tokenRef: this.settings.botTokenRef,
    };
  }

  channelStatus(): { connected: boolean; detail: string } {
    const s = this.statusInfo();
    return { connected: s.connected, detail: s.detail };
  }

  private emitStatus(force = false): void {
    const s = this.statusInfo();
    const key = JSON.stringify(s);
    if (!force && key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.ctx.ui.emit("status", s);
  }

  async http(req: PluginHttpRequest): Promise<PluginHttpResponse> {
    if (req.public) return { status: 404, body: { error: "not found" } };
    const route = `${req.method.toUpperCase()} ${req.path.replace(/\/+$/, "") || "/"}`;
    switch (route) {
      case "GET /status":
        return { status: 200, body: this.statusInfo() };
      case "POST /pairing-code":
        if (this.chat) return { status: 409, body: { error: "Чат уже привязан. Сначала отвяжите его." } };
        await this.newPairingCode();
        return { status: 200, body: this.statusInfo() };
      case "POST /unbind":
        await this.unbind();
        return { status: 200, body: this.statusInfo() };
      default:
        return { status: 404, body: { error: "not found" } };
    }
  }
}
