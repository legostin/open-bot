// Telegram channel: long polling, pairing with exactly one chat, inbound chat, outbound messages,
// approval and feedback buttons. Everything the bot writes is in the hub language (ctx.i18n).

import { randomInt } from "node:crypto";
import type { PluginContext, PluginHttpRequest, PluginHttpResponse } from "@owlbot/plugin-sdk";
import type { OutboundMessage, Params, Task, TaskStatus } from "@owlbot/shared";
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

/** A status message: a catalog key (rendered in the hub language when read) or raw text from Telegram / the network. */
type StatusText = string | { key: string; params?: Params };

const TYPING_MAX_MS = 120_000;
const TYPING_EVERY_MS = 4_500;
const MAX_FAILS_PER_CHAT = 5;
const MAX_FAILS_TOTAL = 20;

/** Bot commands handled here; their descriptions (cmd.<name>) go to the Telegram command menu. */
const COMMANDS = ["tasks", "stop", "help"] as const;
const FINAL: TaskStatus[] = ["done", "failed", "cancelled"];

/**
 * Error of approvals.resolve when the approval was already answered elsewhere: "... already been handled (denied)".
 * The second alternative is the same message in Russian ("uzhe obrabotano"), as older hubs report it.
 */
const ALREADY_HANDLED_RE = /(?:already been handled|\u0443\u0436\u0435 \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u0430\u043d\u043e) \((\w+)\)/;

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
  lastError?: StatusText;
  lastSendError?: StatusText;

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

  /** Text in the hub language. */
  private t(key: string, params?: Params): string {
    return this.ctx.i18n.t(key, params);
  }

  private render(s: StatusText): string {
    return typeof s === "string" ? s : this.t(s.key, s.params);
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

  /** The user typed a token into the chat: if it is ours, connect now (a replaced token needs a reconnect). */
  onVaultUpdated(p: { ids?: string[] } | undefined): void {
    const ours = this.settings.botTokenRef.replace(/^vault:\/\//, "");
    if (!p?.ids?.includes(ours)) return;
    if (this.api) this.reconnect();
    else this.wake?.();
  }

  /** Hub language changed: new command menu and status text. */
  onLocaleChange(): void {
    this.emitStatus();
    void this.registerCommands();
  }

  /** The command menu in the hub language; failures are not fatal. */
  private async registerCommands(api = this.api): Promise<void> {
    if (!api) return;
    try {
      await api.call("setMyCommands", { commands: COMMANDS.map((command) => ({ command, description: this.t(`cmd.${command}`) })) });
    } catch (e: any) {
      this.ctx.log.warn(`setMyCommands failed: ${e?.message ?? e}`);
    }
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
          this.setState("unauthorized", { key: "status.tokenRejected" });
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
      // Not stored yet (or the vault is not open): the setup card asks for it, no need for the raw error.
      if (["vault.notFound", "vault.sealed", "vault.uninitialized"].includes(e?.data?.key)) this.setState("no-token", { key: "status.noToken" });
      else this.setState("no-token", { key: "status.tokenMissing", params: { ref: this.settings.botTokenRef, error: e?.data?.text ?? e?.message ?? String(e) } });
      return false;
    }
    if (!token) {
      this.setState("no-token", { key: "status.tokenEmpty", params: { ref: this.settings.botTokenRef } });
      return false;
    }
    const api = new TelegramApi(this.settings.apiBaseUrl, token);
    try {
      this.botUser = await api.call<TgUser>("getMe", {}, { signal });
    } catch (e) {
      if (e instanceof TelegramError && e.unauthorized) {
        this.setState("unauthorized", { key: "status.tokenRejected" });
        return false;
      }
      throw e;
    }
    // Update ids are per bot: a new token starts from its own offset.
    this.offset = Number(await this.ctx.storage.get<number>(this.offsetKey())) || 0;
    this.api = api;
    // The token works: connected now. Waiting for the first getUpdates kept the card on "Connecting…"
    // (and hid the pairing button) for a whole empty long poll.
    this.setState("polling");
    this.ctx.log.info(`connected as @${this.botUser.username ?? this.botUser.id}`);
    void this.registerCommands(api);
    return true;
  }

  private offsetKey(): string {
    return `offset:${this.botUser?.id ?? "unknown"}`;
  }

  private setState(state: State, error?: StatusText): void {
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
      await this.replyOnce(m.chat, this.t("bot.unboundHint"));
      return;
    }
    if (m.chat.type !== "private") {
      await this.replyOnce(m.chat, this.t("bot.privateOnly"));
      return;
    }
    const fails = this.pairingFails.get(m.chat.id) ?? 0;
    if (fails >= MAX_FAILS_PER_CHAT) return;
    const code = start[1];
    if (!code) {
      await this.sendHtml(m.chat.id, this.t("bot.sendCode"));
      return;
    }
    if (!this.pairingCode || code !== this.pairingCode) {
      this.pairingFails.set(m.chat.id, fails + 1);
      if (++this.pairingFailsTotal >= MAX_FAILS_TOTAL) await this.newPairingCode();
      await this.sendHtml(m.chat.id, this.t(fails + 1 >= MAX_FAILS_PER_CHAT ? "bot.tooManyAttempts" : "bot.wrongCode"));
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
    const hello = from?.first_name ? this.t("bot.helloName", { name: escapeHtml(from.first_name) }) : this.t("bot.hello");
    await this.sendHtml(chat.id, `${hello} ${this.t("bot.linked")}`);
    this.emitStatus(true);
  }

  private async onForeign(m: TgMessage): Promise<void> {
    await this.replyOnce(m.chat, this.t("bot.foreign"));
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
      await this.sendHtml(chatId, this.t("bot.textOnly"));
      return;
    }
    const text = m.text.trim();
    if (!text) return;
    const cmd = /^\/([a-z0-9_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd) {
      if (cmd[2] && this.botUser?.username && cmd[2].toLowerCase() !== this.botUser.username.toLowerCase()) return;
      switch (cmd[1].toLowerCase()) {
        case "start":
          await this.sendHtml(chatId, this.t("bot.alreadyLinked"));
          return;
        case "help":
          await this.sendHtml(chatId, this.help());
          return;
        case "tasks":
          await this.sendTasks(chatId);
          return;
        case "stop": {
          this.stopTyping();
          try {
            const r = await this.ctx.core.call<{ interrupted?: boolean }>("channels.inbound", { channel: "telegram", text: "/stop" });
            await this.sendHtml(chatId, this.t(r?.interrupted ? "bot.stopped" : "bot.nothingRunning"));
          } catch (e: any) {
            await this.sendHtml(chatId, this.t("bot.stopFailed", { error: escapeHtml(e?.message ?? String(e)) }));
          }
          return;
        }
      }
      // Other slash commands go to the assistant as text (skills and commands).
    }
    this.startTyping();
    try {
      const r = await this.ctx.core.call<{ ignored?: boolean; secrets?: number }>("channels.inbound", { channel: "telegram", text });
      if (r?.ignored) this.stopTyping();
      // The hub took a secret out of this message (it is in the vault now): the copy in Telegram goes too.
      if (r?.secrets) {
        const gone = await this.api!.send("deleteMessage", { chat_id: chatId, message_id: m.message_id }).then(
          () => true,
          () => false,
        );
        await this.sendHtml(chatId, this.t(gone ? "bot.secretStored" : "bot.secretStoredDeleteYourself")).catch(() => {});
      }
    } catch (e: any) {
      this.stopTyping();
      await this.sendHtml(chatId, this.t("bot.forwardFailed", { error: escapeHtml(e?.message ?? String(e)) }));
    }
  }

  private help(): string {
    return [
      `<b>${this.t("help.title")}</b>`,
      "",
      this.t("help.chat"),
      this.t("help.notifications"),
      "",
      `/tasks — ${this.t("cmd.tasks")}`,
      `/stop — ${this.t("cmd.stop")}`,
      `/help — ${this.t("help.self")}`,
    ].join("\n");
  }

  private statusLabel(status: TaskStatus): string {
    const key = `task.status.${status}`;
    const label = this.t(key);
    return label === key ? status : label;
  }

  private async sendTasks(chatId: number): Promise<void> {
    let tasks: Task[];
    try {
      tasks = (await this.ctx.core.call<Task[]>("tasks.list", { limit: 30 })) ?? [];
    } catch (e: any) {
      await this.sendHtml(chatId, this.t("bot.tasksFailed", { error: escapeHtml(e?.message ?? String(e)) }));
      return;
    }
    const line = (t: Task) => `• ${escapeHtml(t.title || t.goal.slice(0, 60))} — <i>${this.statusLabel(t.status)}</i>`;
    const active = tasks.filter((t) => !FINAL.includes(t.status)).slice(0, 15);
    const recent = tasks.filter((t) => FINAL.includes(t.status)).slice(0, 5);
    const parts: string[] = [];
    if (active.length) parts.push(`<b>${this.t("tasks.active")}</b>`, ...active.map(line));
    if (recent.length) parts.push(...(parts.length ? [""] : []), `<b>${this.t("tasks.recent")}</b>`, ...recent.map(line));
    await this.sendHtml(chatId, parts.length ? parts.join("\n") : this.t("tasks.none"));
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
      await answer(this.t("callback.unavailable"));
      return;
    }
    const data = q.data ?? "";
    const a = /^a:([^:]+):([ad]):(.+)$/.exec(data);
    if (a) {
      const decision = a[2] === "a" ? "approve" : "deny";
      try {
        await this.ctx.core.call("approvals.resolve", { id: a[1], decision, token: a[3] });
        const label = this.t(decision === "approve" ? "callback.approved" : "callback.denied");
        await answer(label);
        await this.markOutcome(msg, label);
      } catch (e: any) {
        const message = String(e?.message ?? e);
        // Already answered elsewhere (console, a second tap): show the actual outcome instead of an error.
        const done = ALREADY_HANDLED_RE.exec(message)?.[1];
        if (done && ["approved", "executed", "denied", "expired", "failed"].includes(done)) {
          const outcome = this.t(`callback.${done}`);
          await answer(this.t("callback.alreadyHandled", { outcome }));
          await this.markOutcome(msg, outcome);
          return;
        }
        const text = this.t("callback.error", { error: message });
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
        const label = this.t(`feedback.${value}`);
        await answer(label);
        await this.markOutcome(msg, label);
      } catch (e: any) {
        await answer(this.t("callback.error", { error: e?.message ?? String(e) }), true);
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
    if (!this.api) throw new Error(this.render(this.lastError ?? { key: "status.notConnected" }));
    const chatId = this.chat.id;
    const buttons: InlineButton[][] = [];
    let footer = "";

    if (msg.kind === "approval" && msg.approval) {
      const a = msg.approval;
      const yes = `a:${a.id}:a:${a.approveToken}`;
      const no = `a:${a.id}:d:${a.denyToken}`;
      if (fitsCallback(yes) && fitsCallback(no)) {
        buttons.push([
          { text: this.t("button.approve"), callback_data: yes },
          { text: this.t("button.deny"), callback_data: no },
        ]);
      }
      if (msg.link) {
        footer = `\n\n${this.t("approval.footer", { link: escapeHtml(msg.link) })}`;
        if (isPublicHttpUrl(msg.link, { httpsOnly: true })) buttons.push([{ text: this.t("button.console"), url: msg.link }]);
      }
    }
    if (msg.feedback) {
      const id = msg.feedback.notificationId;
      const t = msg.feedback.tokens;
      const row = [
        { text: this.t("button.useful"), callback_data: `f:${id}:u:${t.useful}` },
        { text: this.t("button.less"), callback_data: `f:${id}:l:${t.less}` },
        { text: this.t("button.off"), callback_data: `f:${id}:o:${t.off}` },
      ];
      if (row.every((b) => fitsCallback(b.callback_data))) buttons.push(row);
    }
    if ((msg.kind === "notification" || msg.kind === "digest") && msg.link && isPublicHttpUrl(msg.link, { httpsOnly: true })) {
      buttons.push([{ text: this.t("button.open"), url: msg.link }]);
    }

    // A reply to something typed in the web UI: show what it answers, so the chat here reads as one conversation.
    let header = "";
    if (msg.kind === "reply" && msg.quote?.trim()) {
      const q = msg.quote.trim();
      header = `<blockquote><i>${escapeHtml(this.t("bot.fromWeb"))}</i> ${escapeHtml(q.length > 300 ? `${q.slice(0, 300)}…` : q)}</blockquote>\n`;
    }
    const chunks = splitMarkdown(msg.text ?? "", TELEGRAM_LIMIT - 96 - htmlToPlain(footer).length - htmlToPlain(header).length);
    if (!chunks.length) chunks.push("");
    let lastId: number | undefined;
    for (let i = 0; i < chunks.length; i++) {
      let html: string;
      if (i === 0 && (msg.kind === "notification" || msg.kind === "digest")) {
        // The first line is the title.
        const [first, ...rest] = chunks[0].split("\n");
        html = `<b>${escapeHtml(first)}</b>${rest.length ? "\n" + markdownToHtml(rest.join("\n")) : ""}`;
      } else html = markdownToHtml(chunks[i]);
      if (i === 0) html = header + html;
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
    if (!api) throw new Error(this.t("status.notConnected"));
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
        this.lastSendError = { key: "status.blocked" };
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
    if (old && this.api) await this.sendHtml(old.id, this.t("bot.unlinked")).catch(() => {});
  }

  /** Connection status for the settings page and the channels list, in the hub language. */
  detail(): string {
    const bot = this.botUser?.username ? `@${this.botUser.username}` : this.t("status.bot");
    switch (this.state) {
      case "starting":
        return this.t("status.connecting");
      case "stopped":
        return this.t("status.stopped");
      case "no-token":
      case "unauthorized":
        return this.render(this.lastError ?? { key: "status.noToken" });
      case "error":
        return this.t("status.noConnection", { error: this.render(this.lastError ?? { key: "status.unknownError" }) });
      case "polling":
        if (!this.chat) return this.t("status.waitingPairing", { bot, code: this.pairingCode ?? "" }).trim();
        return this.lastSendError ? `${bot}: ${this.render(this.lastSendError)}` : this.t("status.linked", { bot, chat: this.chat.name });
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
        if (this.chat) return { status: 409, body: { error: this.ctx.i18n.t("http.alreadyLinked", undefined, req.locale) } };
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
