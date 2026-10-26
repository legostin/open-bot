import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@openbot/testkit";
import { startMockTelegram, type MockTelegram } from "./mock-telegram.ts";

const TOKEN = "123456:TEST-token";
const OWNER = 111;
const STRANGER = 222;
const dir = join(import.meta.dirname, "..");

const until = async <T>(fn: () => T | Promise<T>, timeoutMs = 8000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const privateMsg = (chatId: number, text: string | undefined, extra: Record<string, unknown> = {}) => ({
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private", first_name: chatId === OWNER ? "Аня" : "Чужой" },
    from: { id: chatId, first_name: chatId === OWNER ? "Аня" : "Чужой" },
    ...(text !== undefined ? { text } : {}),
    ...extra,
  },
});

describe("telegram plugin", () => {
  let tg: MockTelegram;
  let h: PluginHarness;

  beforeAll(async () => {
    tg = await startMockTelegram(TOKEN);
    h = await startPlugin({
      dir,
      settings: { apiBaseUrl: tg.url, pollTimeoutSec: 1, tokenRetrySec: 0.2 },
      vault: { telegram_bot_token: { value: TOKEN } },
      core: (method, p) => {
        switch (method) {
          case "channels.inbound":
            return p.text === "/stop" ? { interrupted: true } : { messageId: "m1", conversationId: "c1" };
          case "approvals.resolve":
            if (p.token === "staleTok") throw new Error("This approval has already been handled (denied)");
            if (p.token === "staleTokRu") throw new Error("Подтверждение уже обработано (denied)");
            if (p.token !== "goodApproveTok1" && p.token !== "goodDenyTok12345") throw new Error("Неверная подпись кнопки");
            return { id: p.id, status: p.decision === "approve" ? "approved" : "denied" };
          case "notifications.feedback":
            if (p.token !== "fbTokLess123") throw new Error("Неверная подпись кнопки");
            return { id: p.id, feedback: p.value };
          case "tasks.list":
            return [
              { id: "t1", title: "Отчёт <Q3>", goal: "", status: "running" },
              { id: "t2", title: "Купить билеты", goal: "", status: "done" },
            ];
          default:
            return {};
        }
      },
    });
  });

  afterAll(async () => {
    await h?.stop();
    await tg?.close();
  });

  it("registers the channel and rejects public HTTP", async () => {
    expect(h.channels.get("telegram")).toBe("Telegram");
    expect((await h.http({ path: "/status", public: true })).status).toBe(404);
  });

  it("pairs with exactly one chat via /start <code>", async () => {
    const st = await until(async () => {
      const r = (await h.http({ path: "/status" })).body as any;
      return r.state === "polling" ? r : undefined;
    });
    expect(st.connected).toBe(false);
    expect(st.pairingCode).toMatch(/^\d{6}$/);
    expect(st.deepLink).toBe(`https://t.me/openbot_test_bot?start=${st.pairingCode}`);
    const wrong = st.pairingCode === "000000" ? "111111" : "000000";

    let from = tg.calls.length;
    tg.push(privateMsg(OWNER, `/start ${wrong}`));
    const bad = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(bad.params.text).toContain("That code didn't work");

    from = tg.calls.length;
    tg.push(privateMsg(OWNER, `/start ${st.pairingCode}`));
    const hello = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(hello.params.text).toContain("Hi, Аня!");
    expect(hello.params.parse_mode).toBe("HTML");

    const after = (await h.http({ path: "/status" })).body as any;
    expect(after.connected).toBe(true);
    expect(after.chat.id).toBe(OWNER);
    expect(after.pairingCode).toBeNull();
    expect(after.detail).toBe("@openbot_test_bot is linked to the chat “Аня”");
    expect(h.coreCalls.some((c) => c.method === "ui.emit" && c.params.channel === "status")).toBe(true);
    expect((await h.peer.request<any>("channel.status", { channelId: "telegram" })).connected).toBe(true);
  });

  it("registers the command menu in the hub language", async () => {
    const cmds = await tg.waitFor("setMyCommands");
    expect(cmds.params.commands).toEqual([
      { command: "tasks", description: "tasks in progress and recent ones" },
      { command: "stop", description: "stop the assistant's current work" },
      { command: "help", description: "help" },
    ]);
  });

  it("ignores other chats with one polite reply", async () => {
    const from = tg.calls.length;
    tg.push(privateMsg(STRANGER, "привет"));
    tg.push(privateMsg(STRANGER, "ну ответь"));
    tg.push(privateMsg(STRANGER, `/start 123456`));
    const marker = tg.push(privateMsg(OWNER, "/help"));
    await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER && p.text.includes("/tasks"), { from });
    expect(marker).toBeGreaterThan(0);
    const toStranger = tg.callsOf("sendMessage", (p) => p.chat_id === STRANGER);
    expect(toStranger).toHaveLength(1);
    expect(toStranger[0].params.text).toContain("already linked to another chat");
    expect(h.coreCalls.filter((c) => c.method === "channels.inbound")).toHaveLength(0);
  });

  it("forwards owner text to channels.inbound and shows typing until the reply", async () => {
    const from = tg.calls.length;
    tg.push(privateMsg(OWNER, "Что у меня завтра?"));
    await until(() => h.coreCalls.find((c) => c.method === "channels.inbound" && c.params.text === "Что у меня завтра?"));
    expect(h.coreCalls.find((c) => c.method === "channels.inbound")!.params).toEqual({ channel: "telegram", text: "Что у меня завтра?" });
    const typing = await tg.waitFor("sendChatAction", () => true, { from });
    expect(typing.params).toEqual({ chat_id: OWNER, action: "typing" });

    await h.channelSend("telegram", { kind: "reply", text: "Завтра: **созвон** в 10:00 & обед <с Олей>" });
    const reply = await tg.waitFor("sendMessage", (p) => p.text.includes("созвон"), { from });
    expect(reply.params.text).toBe("Завтра: <b>созвон</b> в 10:00 &amp; обед &lt;с Олей&gt;");
    expect(reply.params.chat_id).toBe(OWNER);
  });

  it("quotes the web message a mirrored reply answers", async () => {
    const from = tg.calls.length;
    await h.channelSend("telegram", { kind: "reply", text: "Кофе в **турке**", quote: "где кофе <в турке>?" });
    const sent = await tg.waitFor("sendMessage", (p) => p.text.includes("турке</b>"), { from });
    expect(sent.params.text).toBe("<blockquote><i>You, in the web app:</i> где кофе &lt;в турке&gt;?</blockquote>\nКофе в <b>турке</b>");
  });

  it("handles /stop, /tasks and non-text messages", async () => {
    let from = tg.calls.length;
    tg.push(privateMsg(OWNER, "/stop"));
    const stopped = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(stopped.params.text).toContain("Stopped the current work");
    expect(h.coreCalls.some((c) => c.method === "channels.inbound" && c.params.text === "/stop")).toBe(true);

    from = tg.calls.length;
    tg.push(privateMsg(OWNER, "/tasks"));
    const tasks = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(tasks.params.text).toBe("<b>In progress</b>\n• Отчёт &lt;Q3&gt; — <i>running</i>\n\n<b>Recently finished</b>\n• Купить билеты — <i>done</i>");

    from = tg.calls.length;
    tg.push(privateMsg(OWNER, undefined, { photo: [{ file_id: "x", width: 1, height: 1 }] }));
    const photo = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(photo.params.text).toContain("only understand text messages");
  });

  it("splits long messages and respects silent", async () => {
    const from = tg.calls.length;
    const long = Array.from({ length: 400 }, (_, i) => `Строка номер ${i} с текстом & символами.`).join("\n");
    await h.channelSend("telegram", { kind: "notification", text: `Длинная сводка\n\n${long}`, silent: true });
    const sends = tg.calls.slice(from).filter((c) => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(3);
    for (const s of sends) {
      expect(s.params.text.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").length).toBeLessThanOrEqual(4096);
      expect(s.params.disable_notification).toBe(true);
    }
    expect(sends[0].params.text.startsWith("<b>Длинная сводка</b>")).toBe(true);
    const all = sends.map((s) => s.params.text).join("\n");
    expect(all).toContain("Строка номер 0 ");
    expect(all).toContain("Строка номер 399 ");
  });

  it("sends approval cards and resolves them with signed buttons", async () => {
    let from = tg.calls.length;
    await h.channelSend("telegram", {
      kind: "approval",
      text: "🔐 Ассистент просит подтвердить:\nОтправить письмо boss@example.com",
      link: "http://127.0.0.1:8081/#/approvals/a1",
      approval: { id: "akz9x1", summary: "Отправить письмо", approveToken: "goodApproveTok1", denyToken: "goodDenyTok12345" },
    });
    const card = await tg.waitFor("sendMessage", (p) => !!p.reply_markup, { from });
    const kb = card.params.reply_markup.inline_keyboard;
    expect(kb).toHaveLength(1); // no URL button for a non-https console link
    expect(kb[0].map((b: any) => b.callback_data)).toEqual(["a:akz9x1:a:goodApproveTok1", "a:akz9x1:d:goodDenyTok12345"]);
    expect(kb[0].map((b: any) => b.text)).toEqual(["✅ Approve", "❌ Deny"]);
    expect(card.params.text).toContain("http://127.0.0.1:8081/#/approvals/a1");

    from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb1",
        from: { id: OWNER },
        data: "a:akz9x1:a:goodApproveTok1",
        message: { message_id: 77, chat: { id: OWNER, type: "private" }, text: "Отправить письмо", entities: [], reply_markup: card.params.reply_markup },
      },
    });
    const edit = await tg.waitFor("editMessageText", () => true, { from });
    expect(edit.params.text).toContain("✅ Approved");
    expect(edit.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(h.coreCalls.find((c) => c.method === "approvals.resolve")!.params).toEqual({ id: "akz9x1", decision: "approve", token: "goodApproveTok1" });
    const ans = tg.callsOf("answerCallbackQuery", (p) => p.callback_query_id === "cb1");
    expect(ans[0].params.text).toBe("✅ Approved");
  });

  it("reports invalid or expired approval buttons", async () => {
    const from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb2",
        from: { id: OWNER },
        data: "a:akz9x1:d:forgedTok",
        message: { message_id: 78, chat: { id: OWNER, type: "private" }, text: "Удалить файл" },
      },
    });
    const ans = await tg.waitFor("answerCallbackQuery", (p) => p.callback_query_id === "cb2", { from });
    expect(ans.params.show_alert).toBe(true);
    expect(ans.params.text).toBe("That didn't work: Неверная подпись кнопки");
    const edit = await tg.waitFor("editMessageText", (p) => p.message_id === 78, { from });
    expect(edit.params.text).toContain("⚠️");
  });

  it("shows the real outcome when the approval was already answered elsewhere", async () => {
    // The hub reports it in English ("staleTok") or, in older versions, in Russian ("staleTokRu").
    for (const [i, token] of ["staleTok", "staleTokRu"].entries()) {
      const from = tg.calls.length;
      const id = `cb2b${i}`;
      tg.push({
        callback_query: {
          id,
          from: { id: OWNER },
          data: `a:akz9x2:a:${token}`,
          message: { message_id: 79 + i * 100, chat: { id: OWNER, type: "private" }, text: "Оплатить счёт" },
        },
      });
      const edit = await tg.waitFor("editMessageText", (p) => p.message_id === 79 + i * 100, { from });
      expect(edit.params.text).toBe("Оплатить счёт\n\n<b>❌ Denied</b>");
      const ans = tg.callsOf("answerCallbackQuery", (p) => p.callback_query_id === id);
      expect(ans[0].params.text).toBe("Already handled: ❌ Denied");
      expect(ans[0].params.show_alert).toBeUndefined();
    }
  });

  it("ignores button presses from other chats", async () => {
    const before = h.coreCalls.filter((c) => c.method === "approvals.resolve").length;
    const from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb3",
        from: { id: STRANGER },
        data: "a:akz9x1:a:goodApproveTok1",
        message: { message_id: 5, chat: { id: STRANGER, type: "private" }, text: "x" },
      },
    });
    const ans = await tg.waitFor("answerCallbackQuery", (p) => p.callback_query_id === "cb3", { from });
    expect(ans.params.text).toBe("This button is not available.");
    expect(h.coreCalls.filter((c) => c.method === "approvals.resolve").length).toBe(before);
  });

  it("sends notification feedback buttons and applies the feedback", async () => {
    let from = tg.calls.length;
    await h.channelSend("telegram", {
      kind: "notification",
      text: "Цена упала\n\nБилет в Казань теперь 3 200 ₽",
      link: "https://bot.example.com/tasks/t9",
      notificationId: "n_abc",
      feedback: { notificationId: "n_abc", tokens: { useful: "fbTokUseful1", less: "fbTokLess123", off: "fbTokOff1234" } },
    });
    const msg = await tg.waitFor("sendMessage", (p) => !!p.reply_markup, { from });
    const kb = msg.params.reply_markup.inline_keyboard;
    expect(kb[0].map((b: any) => b.callback_data)).toEqual(["f:n_abc:u:fbTokUseful1", "f:n_abc:l:fbTokLess123", "f:n_abc:o:fbTokOff1234"]);
    expect(kb[1]).toEqual([{ text: "Open", url: "https://bot.example.com/tasks/t9" }]);
    for (const row of kb) for (const b of row) if (b.callback_data) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);

    from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb4",
        from: { id: OWNER },
        data: "f:n_abc:l:fbTokLess123",
        message: { message_id: 90, chat: { id: OWNER, type: "private" }, text: "Цена упала\n\nБилет", entities: [{ type: "bold", offset: 0, length: 10 }], reply_markup: msg.params.reply_markup },
      },
    });
    const edit = await tg.waitFor("editMessageText", (p) => p.message_id === 90, { from });
    expect(edit.params.text).toContain("<b>Цена упала</b>");
    expect(edit.params.text).toContain("I'll write less often");
    expect(edit.params.reply_markup.inline_keyboard).toEqual([[{ text: "Open", url: "https://bot.example.com/tasks/t9" }]]);
    expect(h.coreCalls.find((c) => c.method === "notifications.feedback")!.params).toEqual({ id: "n_abc", value: "less", token: "fbTokLess123" });
  });

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    const from = tg.calls.length;
    tg.failNext("sendMessage", 400, "Bad Request: can't parse entities: unexpected end tag");
    await h.channelSend("telegram", { kind: "reply", text: "**a *b** c*" });
    const plain = await tg.waitFor("sendMessage", (p) => p.parse_mode === undefined, { from });
    expect(plain.params.text).not.toContain("<");
  });

  it("unbinds and issues a new pairing code", async () => {
    const r = (await h.http({ method: "POST", path: "/unbind" })).body as any;
    expect(r.chat).toBeNull();
    expect(r.connected).toBe(false);
    expect(r.pairingCode).toMatch(/^\d{6}$/);
    const regen = (await h.http({ method: "POST", path: "/pairing-code" })).body as any;
    expect(regen.pairingCode).toMatch(/^\d{6}$/);
    // Unbound: outbound messages are dropped quietly.
    const from = tg.calls.length;
    await h.channelSend("telegram", { kind: "reply", text: "nobody" });
    expect(tg.calls.slice(from).filter((c) => c.method === "sendMessage" && c.params.text === "nobody")).toHaveLength(0);
  });
});

describe("telegram plugin without a token", () => {
  it("reports the missing token and keeps retrying", async () => {
    const h = await startPlugin({ dir, settings: { apiBaseUrl: "http://127.0.0.1:9", tokenRetrySec: 0.1 } });
    try {
      const st = await until(async () => {
        const s = (await h.http({ path: "/status" })).body as any;
        return s.state === "no-token" ? s : undefined;
      });
      expect(st.connected).toBe(false);
      expect(st.detail).toMatch(/^No bot token \(vault:\/\/telegram_bot_token\): /);
      const ch = await h.peer.request<any>("channel.status", { channelId: "telegram" });
      expect(ch.connected).toBe(false);
      // It keeps asking the vault.
      await new Promise((r) => setTimeout(r, 350));
      expect(h.logs.join("\n")).not.toContain("uncaught");
    } finally {
      await h.stop();
    }
  });
});

describe("telegram plugin with Telegram's long polls", () => {
  it("is connected (and shows the pairing link) as soon as the token works, not after the first empty poll", async () => {
    const tg = await startMockTelegram(TOKEN, { maxPollSec: 30 });
    const h = await startPlugin({ dir, settings: { apiBaseUrl: tg.url, pollTimeoutSec: 30 }, vault: { telegram_bot_token: { value: TOKEN } } });
    try {
      await tg.waitFor("getUpdates");
      // The first getUpdates now holds for 30 s; the card must not say "Connecting…" meanwhile.
      const st = await until(async () => {
        const s = (await h.http({ path: "/status" })).body as any;
        return s.state === "polling" ? s : undefined;
      }, 1500);
      expect(st.deepLink).toMatch(/^https:\/\/t\.me\/openbot_test_bot\?start=\d{6}$/);
    } finally {
      await h.stop();
      await tg.close();
    }
  });
});

describe("telegram plugin in Russian", () => {
  it("writes to the chat, describes commands and reports status in the hub language", async () => {
    const tg = await startMockTelegram(TOKEN);
    const h = await startPlugin({
      dir,
      locale: "ru",
      settings: { apiBaseUrl: tg.url, pollTimeoutSec: 1, tokenRetrySec: 0.2 },
      vault: { telegram_bot_token: { value: TOKEN } },
    });
    try {
      const cmds = await tg.waitFor("setMyCommands");
      expect(cmds.params.commands).toContainEqual({ command: "tasks", description: "задачи в работе и недавние" });
      const st = await until(async () => {
        const r = (await h.http({ path: "/status" })).body as any;
        return r.state === "polling" ? r : undefined;
      });
      expect(st.detail).toBe(`@openbot_test_bot ждёт привязки: отправьте ему /start ${st.pairingCode}`);

      let from = tg.calls.length;
      tg.push(privateMsg(OWNER, `/start ${st.pairingCode === "000000" ? "111111" : "000000"}`));
      const bad = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
      expect(bad.params.text).toBe("Код не подошёл. Проверьте код в настройках open-bot и попробуйте ещё раз.");

      // Switching the hub language re-registers the command menu.
      from = tg.calls.length;
      h.setLocale("en");
      const en = await tg.waitFor("setMyCommands", () => true, { from });
      expect(en.params.commands).toContainEqual({ command: "tasks", description: "tasks in progress and recent ones" });
    } finally {
      await h.stop();
      await tg.close();
    }
  });
});
