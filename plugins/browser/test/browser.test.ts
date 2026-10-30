// End-to-end tests: the plugin runs in a real child process (testkit harness) and drives headless Chromium
// against a local HTTP server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { ToolResult } from "@owlbot/shared";
import { catalogLookup, localizeValue, readPluginLayout, renderTemplate } from "@owlbot/shared";
import { startPlugin, type PluginHarness } from "@owlbot/testkit";
import { chromium } from "playwright";

const PLUGIN_DIR = join(import.meta.dirname, "..");

/**
 * The harness gives the plugin its own HOME, where Playwright finds no browsers and would download Chromium on the
 * first call (too slow for a test, and impossible behind the fake proxy below, which tunnels every CONNECT to a plain
 * HTTP server). Point the plugin at the browsers this machine already has, unless PLAYWRIGHT_BROWSERS_PATH is set.
 */
function browsersEnv(): Record<string, string> {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return {};
  const exe = chromium.executablePath();
  const m = /^(.*?)[\\/]chromium-\d+[\\/]/.exec(exe);
  return m && existsSync(exe) ? { PLAYWRIGHT_BROWSERS_PATH: m[1] } : {};
}
const SECRET = "S3cr3t-Pa55!word";
const LONG = Array.from({ length: 600 }, (_, i) => `Строка номер ${i} с некоторым текстом.`).join("\n");

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/": page(
    "Главная",
    `<h1>Магазин</h1>
     <a href="/about">О нас</a>
     <form method="post" action="/order"><input name="name" placeholder="Имя"><button>Купить</button></form>
     <form role="search" action="/search"><input type="search" name="q" aria-label="Поиск"><button>Найти</button></form>
     <textarea aria-label="Заметка"></textarea>
     <select aria-label="Город"><option>Москва</option><option>Казань</option></select>
     <a href="/file.txt">Скачать отчёт</a>
     <a href="/delete-account">Удалить аккаунт</a>`,
  ),
  "/about": page("О нас", `<h1>О нас</h1><p>Мы продаём всё.</p>`),
  "/login": page(
    "Вход",
    `<form method="post" action="/login">
       <input name="username" aria-label="Логин">
       <input type="password" name="password" aria-label="Пароль">
       <input type="text" name="pin" aria-label="Код">
       <button type="submit">Войти</button>
       <button type="button" id="noop">Показать пароль</button>
     </form>`,
  ),
  "/long": page("Длинная", `<main><p>${LONG.replace(/\n/g, "<br>")}</p></main>`),
  "/confirm": page("Записи", `<button onclick="if (confirm('Точно удалить?')) document.title = 'Удалено'">Удалить запись</button>`),
  "/captcha": page("Проверка", `<p>Подтвердите действие</p><div class="g-recaptcha" style="width:304px;height:78px;border:1px solid #ccc"></div>`),
  "/frame": page("Фрейм", `<p>Встроенная форма:</p><iframe src="/inner" style="width:600px;height:200px"></iframe>`),
  "/inner": page("Внутри", `<form method="post" action="/order"><input name="name" aria-label="Имя во фрейме"><button>Заказать</button></form>`),
  // Controls with consequences hide behind ARIA names, icons, identifiers and JS; ordinary ones must stay one click.
  "/actions": page(
    "Действия",
    `<h1>Действия</h1>
     <button aria-label="Карточка товара">Buy now</button>
     <span role="button" tabindex="0" data-testid="placeYourOrderButton">→</span>
     <button onclick="return confirm('Sure?')">Archive</button>
     <a href="/items/5/delete" title="Корзина">🗑</a>
     <a href="/posts/1" data-method="delete">Destroy</a>
     <a href="/unsubscribe?u=1">Отписаться</a>
     <a href="/blog/how-to-delete-your-account">How to delete your account in five easy steps</a>
     <button>Оформить заказ</button>
     <button>Подписаться</button>
     <button>Перевести 500 ₽</button>
     <button>Забронировать</button>
     <form class="checkout-form" action="/pay"><input aria-label="Карта"><button type="button" onclick="this.form.submit()">Continue</button></form>
     <form action="/profile"><input aria-label="Ник"><button type="button">Continue editing</button></form>
     <button onclick="document.title = 'В корзине'">Add to cart</button>
     <button>Remove filter</button>
     <button>Мои заказы</button>
     <button>Sign in</button>
     <button role="tab">Delete account</button>
     <input type="checkbox" id="news"><label for="news">Subscribe to the newsletter</label>
     <div contenteditable="true" aria-label="Send a message" style="min-height:20px;border:1px solid #ccc"></div>
     <input aria-label="Отправить сообщение">`,
  ),
  "/counter": page(
    "Счётчик",
    `<style>body{margin:0}</style>
     <button id="b" style="position:absolute;left:0;top:0;width:640px;height:400px" onclick="this.textContent = 'нажато ' + (++window.n)">нажато 0</button>
     <input id="t" aria-label="Поле" style="position:absolute;left:0;top:500px;width:640px;height:40px">
     <script>window.n = 0</script>`,
  ),
};

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  let s = "";
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

function authorizedSeen(auth: string | undefined): boolean {
  return !!auth && Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString() === "tok_test:x";
}

function text(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

function refOf(snapshot: string, re: RegExp): string {
  const line = snapshot.split("\n").find((l) => /^\[e\d+\]/.test(l) && re.test(l));
  if (!line) throw new Error(`no element matching ${re} in:\n${snapshot}`);
  return /^\[(e\d+)\]/.exec(line)![1];
}

async function until<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("browser plugin (headless Chromium)", () => {
  let h: PluginHarness;
  let server: Server;
  let base: string;
  const workspace = mkdtempSync(join(tmpdir(), "browser-ws-"));
  /** Same contract as the hub's files.deliver (packages/core/src/core-call.ts), minus the session lookup. */
  const fakeCore = (method: string, p: any) => {
    if (method !== "files.deliver") return {};
    const dir = join(workspace, "downloads");
    mkdirSync(dir, { recursive: true });
    let rel: string = p.path;
    if (!rel) {
      const dot = p.name.lastIndexOf(".");
      let candidate = p.name;
      for (let i = 1; existsSync(join(dir, candidate)); i++) candidate = `${p.name.slice(0, dot)} (${i})${p.name.slice(dot)}`;
      rel = `downloads/${candidate}`;
    }
    appendFileSync(join(workspace, rel), Buffer.from(p.data, "base64"));
    return { path: rel, absolutePath: join(workspace, rel) };
  };
  const posted: Array<{ path: string; body: URLSearchParams }> = [];
  const outputs: string[] = [];

  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await h.invoke(name, input);
    outputs.push(JSON.stringify(r));
    return r;
  };
  const ok = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await call(name, input);
    expect(r.isError, text(r)).toBeFalsy();
    return text(r);
  };

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST") {
        const body = await readBody(req);
        posted.push({ path: url.pathname, body });
        const html =
          url.pathname === "/order" ? page("Заказ", `<p>Заказ принят: ${body.get("name")}</p>`) : page("Кабинет", `<p>Вход выполнен: ${body.get("username")}</p>`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
        return;
      }
      if (url.pathname === "/search") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Поиск", `<p>Результаты для: ${url.searchParams.get("q")}</p>`));
        return;
      }
      if (url.pathname === "/file.txt") {
        res
          .writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("отчёт 1.txt")}` })
          .end("hello file");
        return;
      }
      const html = PAGES[url.pathname];
      if (!html) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h = await startPlugin({
      dir: PLUGIN_DIR,
      settings: { headless: "always", allowLocalNetwork: true, takeoverWaitSec: 0 },
      vault: { "site-login": { url: base, username: "alice", password: SECRET } },
      core: fakeCore,
      env: browsersEnv(),
    });
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
    server?.close();
  });

  it("registers browser tools with effects and source flags", () => {
    const effects = Object.fromEntries([...h.tools.values()].map((t) => [t.name, t.effect]));
    expect(effects).toEqual({
      open: "read",
      snapshot: "read",
      get_text: "read",
      screenshot: "read",
      scroll: "read",
      back: "read",
      tabs: "read",
      wait: "read",
      click: "local-write",
      type: "local-write",
      press_key: "local-write",
      fill_secret: "local-write",
      download: "local-write",
      submit: "external",
    });
    expect([...h.tools.values()].every((t) => t.source === true)).toBe(true);
    // The approval summary is a catalog reference: the hub resolves it in the hub language, then fills {field}s.
    // The card names the site and the control as the page shows it, not only the agent's own description.
    const summary = h.tools.get("submit")!.approvalSummary!;
    expect(summary).toBe("%approval.submit%");
    const { messages } = readPluginLayout(PLUGIN_DIR);
    const input = { ref: "e7", label: "Pay $34.00", url: "https://shop.example/checkout?step=3", description: "Pay for 2 items, $34.00" };
    expect(renderTemplate(localizeValue(summary, catalogLookup(messages, "en")), input)).toBe("Browser, shop.example, “Pay $34.00”: Pay for 2 items, $34.00");
    expect(renderTemplate(localizeValue(summary, catalogLookup(messages, "ru")), input)).toBe("Браузер, shop.example, «Pay $34.00»: Pay for 2 items, $34.00");
    expect(h.tools.get("submit")!.inputSchema.required).toEqual(["ref", "label", "url", "description"]);
  });

  it("opens a page and lists interactive elements with refs", async () => {
    const opened = await ok("open", { url: base + "/" });
    expect(opened).toContain("Opened.");
    expect(opened).toContain(`Page: Главная — ${base}/`);
    expect(opened).toContain(`Главная — ${base}/`);
    const snap = await ok("snapshot");
    expect(snap).toContain("# Магазин");
    expect(snap).toMatch(/\[e\d+\] link "О нас" -> \/about/);
    expect(snap).toMatch(/\[e\d+\] textbox "Имя"/);
    expect(snap).toMatch(/\[e\d+\] button "Купить" \(needs browser_submit\)/);
    expect(snap).toMatch(/\[e\d+\] button "Найти"(?! \(needs)/);
    expect(snap).toMatch(/\[e\d+\] select "Город" value="Москва" options: Москва \| Казань/);
    // Refs are stable across snapshots of the same page.
    expect(refOf(await ok("snapshot"), /"О нас"/)).toBe(refOf(snap, /"О нас"/));
  });

  it("clicks a link and goes back", async () => {
    const snap = await ok("snapshot");
    const r = await ok("click", { ref: refOf(snap, /link "О нас"/) });
    expect(r).toContain(`О нас — ${base}/about`);
    const back = await ok("back");
    expect(back).toContain(`Главная — ${base}/`);
    // Old refs do not survive navigation.
    const stale = await call("click", { ref: refOf(snap, /link "О нас"/) });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("browser_snapshot");
  });

  it("types into fields and chooses select options", async () => {
    const snap = await ok("snapshot");
    await ok("type", { ref: refOf(snap, /textbox "Имя"/), text: "Иван" });
    await ok("type", { ref: refOf(snap, /select "Город"/), text: "Казань" });
    const after = await ok("snapshot");
    expect(after).toMatch(/textbox "Имя" value="Иван"/);
    expect(after).toMatch(/select "Город" value="Казань"/);
    const bad = await call("type", { ref: refOf(snap, /link "О нас"/), text: "x" });
    expect(bad.isError).toBe(true);
  });

  it("refuses submit-like clicks and Enter in forms, pointing to browser_submit", async () => {
    const snap = await ok("snapshot");
    const buyRef = refOf(snap, /button "Купить"/);
    const buy = await call("click", { ref: buyRef });
    expect(buy.isError).toBe(true);
    // The refusal hands the model the exact call, label and url included.
    expect(text(buy)).toContain(`Call browser_submit with ref "${buyRef}", label "Купить", url "${base}/"`);
    const del = await call("click", { ref: refOf(snap, /link "Удалить аккаунт"/) });
    expect(del.isError).toBe(true);
    const enter = await call("press_key", { key: "Enter", ref: refOf(snap, /textbox "Имя"/) });
    expect(enter.isError).toBe(true);
    expect(text(enter)).toContain("browser_submit");
    const note = await call("press_key", { key: "Enter", ref: refOf(snap, /textbox "Заметка"/) });
    expect(note.isError).toBe(true);
    expect(posted).toHaveLength(0);
    // Search boxes are fine: Enter there is just navigation.
    await ok("type", { ref: refOf(snap, /textbox\[search\] "Поиск"/), text: "чайник" });
    const search = await ok("press_key", { key: "Enter" });
    expect(search).toContain("Поиск —");
    expect(await ok("get_text")).toContain("Результаты для: чайник");
  });

  it("treats a line break at the end of browser_type like Enter", async () => {
    await ok("open", { url: base + "/" });
    const snap = await ok("snapshot");
    const name = refOf(snap, /textbox "Имя"/);
    const typed = await ok("type", { ref: name, text: "Привет\n" });
    expect(typed).toContain('Typed into [' + name + '] "Имя": "Привет".');
    expect(typed).toContain("nothing was submitted");
    expect(typed).toContain(`Call browser_submit with ref "${name}", label "Имя"`);
    // The same in a field outside any form.
    expect(await ok("type", { ref: refOf(snap, /textbox "Заметка"/), text: "строка\r\n  " })).toContain("nothing was submitted");
    expect(posted).toHaveLength(0);
    const after = await ok("snapshot");
    expect(after).toMatch(/textbox "Имя" value="Привет"/);
    expect(after).toMatch(/textbox "Заметка" value="строка"/);
    // A search box searches: Enter there is just navigation.
    const search = await ok("type", { ref: refOf(snap, /textbox\[search\] "Поиск"/), text: "самовар\n" });
    expect(search).toContain("Pressed Enter.");
    expect(await ok("get_text")).toContain("Результаты для: самовар");
  });

  it("classifies consequential controls by name, text, identifiers, links and forms", async () => {
    await ok("open", { url: base + "/actions" });
    const snap = await ok("snapshot");
    const needs = (re: RegExp) => {
      const line = snap.split("\n").find((l) => /^\[e\d+\]/.test(l) && re.test(l));
      if (!line) throw new Error(`no element matching ${re} in:\n${snap}`);
      return line.includes("(needs browser_submit)");
    };
    // An ARIA name that hides "Buy now", an icon with a test id, a JS confirm, links that act.
    expect(needs(/button "Карточка товара"/)).toBe(true);
    expect(needs(/button "→"/)).toBe(true);
    expect(needs(/button "Archive"/)).toBe(true);
    expect(needs(/link "🗑"/)).toBe(true);
    expect(needs(/link "Destroy"/)).toBe(true);
    expect(needs(/link "Отписаться"/)).toBe(true);
    expect(needs(/button "Оформить заказ"/)).toBe(true);
    expect(needs(/button "Подписаться"/)).toBe(true);
    expect(needs(/button "Перевести 500 ₽"/)).toBe(true);
    expect(needs(/button "Забронировать"/)).toBe(true);
    // "Continue" in a payment form commits it even as a plain JS button; elsewhere it is just a button.
    expect(needs(/button "Continue"(?! editing)/)).toBe(true);
    expect(needs(/button "Continue editing"/)).toBe(false);
    // Ordinary browsing stays one click: articles, carts, filters, tabs, sign-in, checkboxes, fields.
    expect(needs(/link "How to delete your account/)).toBe(false);
    expect(needs(/button "Add to cart"/)).toBe(false);
    expect(needs(/button "Remove filter"/)).toBe(false);
    expect(needs(/button "Мои заказы"/)).toBe(false);
    expect(needs(/button "Sign in"/)).toBe(false);
    expect(needs(/tab "Delete account"/)).toBe(false);
    expect(needs(/checkbox "Subscribe to the newsletter"/)).toBe(false);
    expect(needs(/textbox "Send a message"/)).toBe(false);
    expect(needs(/textbox "Отправить сообщение"/)).toBe(false);

    for (const re of [/button "→"/, /link "🗑"/, /button "Archive"/, /button "Continue"(?! editing)/]) {
      const r = await call("click", { ref: refOf(snap, re) });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toContain("Nothing was clicked");
    }
    expect(posted).toHaveLength(0);
    expect(await ok("click", { ref: refOf(snap, /checkbox "Subscribe to the newsletter"/) })).toContain("Clicked");
    expect(await ok("snapshot")).toMatch(/checkbox "Subscribe to the newsletter" \[x\]/);
    expect(await ok("click", { ref: refOf(snap, /button "Add to cart"/) })).toContain("В корзине —");
    expect(await ok("click", { ref: refOf(snap, /textbox "Send a message"/) })).toContain("Clicked");
  });

  it("works inside iframes with the same safety rules", async () => {
    await ok("open", { url: base + "/frame" });
    const snap = await ok("snapshot");
    expect(snap).toContain(`-- iframe ${new URL(base).host} --`);
    const field = refOf(snap, /textbox "Имя во фрейме"/);
    await ok("type", { ref: field, text: "Фрейм" });
    expect((await call("press_key", { key: "Enter", ref: field })).isError).toBe(true);
    expect((await call("click", { ref: refOf(snap, /button "Заказать"/) })).isError).toBe(true);
    expect(posted).toHaveLength(0);
    expect(await ok("snapshot")).toMatch(/textbox "Имя во фрейме" value="Фрейм"/);
  });

  it("submits a form through browser_submit", async () => {
    await ok("open", { url: base + "/" });
    const snap = await ok("snapshot");
    await ok("type", { ref: refOf(snap, /textbox "Имя"/), text: "Пётр" });
    const buy = refOf(snap, /button "Купить"/);
    const wrong = await call("submit", { ref: buy, label: "Купить", url: "https://shop.example/", description: "Купить" });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("The page has changed");
    // The user approved a control by its name: another name on the card means nothing is clicked.
    const renamed = await call("submit", { ref: buy, label: "Купить за 1 ₽", url: base + "/", description: "Купить" });
    expect(renamed.isError).toBe(true);
    expect(text(renamed)).toContain('Not done: [' + buy + '] is now button "Купить", but the user approved "Купить за 1 ₽"');
    const noLabel = await call("submit", { ref: buy, url: base + "/", description: "Купить" });
    expect(noLabel.isError).toBe(true);
    expect(text(noLabel)).toContain("Parameter label is required");
    expect(posted).toHaveLength(0);
    const r = await ok("submit", { ref: buy, label: "купить", url: base + "/", description: "Оформить заказ в тестовом магазине" });
    expect(r).toContain("Done: Оформить заказ в тестовом магазине");
    expect(r).toContain("Заказ —");
    expect(posted.at(-1)).toMatchObject({ path: "/order" });
    expect(posted.at(-1)!.body.get("name")).toBe("Пётр");
  });

  it("accepts confirm() dialogs only inside an approved submit", async () => {
    await ok("open", { url: base + "/confirm" });
    const snap = await ok("snapshot");
    const ref = refOf(snap, /button "Удалить запись"/);
    expect((await call("click", { ref })).isError).toBe(true);
    const r = await ok("submit", { ref, label: "Удалить запись", url: base + "/confirm", description: "Удалить запись" });
    expect(r).toContain("Удалено —");
  });

  it("fills secrets from the vault without revealing them", async () => {
    await ok("open", { url: base + "/login" });
    const snap = await ok("snapshot");
    const vaultRef = "vault://site-login";
    await ok("fill_secret", { ref: refOf(snap, /textbox "Логин"/), vaultRef, field: "username" });
    const pw = await ok("fill_secret", { ref: refOf(snap, /textbox\[password\] "Пароль"/), vaultRef });
    expect(pw).toContain("the value is not shown");
    await ok("fill_secret", { ref: refOf(snap, /textbox "Код"/), vaultRef });
    const notInput = await call("fill_secret", { ref: refOf(snap, /button "Показать пароль"/), vaultRef });
    expect(notInput.isError).toBe(true);
    const after = await ok("snapshot");
    expect(after).toMatch(/textbox "Логин" value="alice"/);
    expect(after).toMatch(/textbox\[password\] "Пароль" value="••••••"/);
    expect(after).toMatch(/textbox "Код" value="••••••"/);
    await ok("get_text");
    await ok("screenshot");
    const r = await ok("submit", { ref: refOf(after, /button "Войти"/), label: "Войти", url: base + "/login", description: "Войти на тестовый сайт" });
    expect(r).toContain("Кабинет —");
    const login = posted.find((p) => p.path === "/login")!;
    expect(login.body.get("password")).toBe(SECRET);
    expect(login.body.get("pin")).toBe(SECRET);
    expect(login.body.get("username")).toBe("alice");
    for (const o of outputs) expect(o).not.toContain(SECRET);
    expect(h.logs.join("\n")).not.toContain(SECRET);
  });

  it("returns a JPEG screenshot as an image part", async () => {
    await ok("open", { url: base + "/" });
    const r = await call("screenshot");
    const img = r.content.find((c) => c.type === "image") as { type: "image"; data: string; mimeType: string };
    expect(img.mimeType).toBe("image/jpeg");
    const buf = Buffer.from(img.data, "base64");
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf.length).toBeLessThan(400_000);
    expect(text(r)).toContain("Screenshot of the visible area");
  });

  it("truncates page text", async () => {
    await ok("open", { url: base + "/long" });
    const t = await ok("get_text", { maxChars: 500 });
    expect(t).toContain("Строка номер 0");
    expect(t).not.toContain("Строка номер 599");
    expect(t).toMatch(/truncated: showing 500 of \d+ characters/);
  });

  it("downloads files by ref and by url", async () => {
    await ok("open", { url: base + "/" });
    const snap = await ok("snapshot");
    const byRef = await ok("download", { ref: refOf(snap, /link "Скачать отчёт"/) });
    expect(byRef).toMatch(/File saved to the workspace: downloads\/отчёт 1\.txt \(.*, 10 B\)/);
    const byUrl = await ok("download", { url: base + "/file.txt" });
    expect(byUrl).toMatch(/workspace: downloads\/отчёт 1 \(1\)\.txt/);
    const dir = join(h.dataDir, "downloads");
    expect(readdirSync(dir).sort()).toEqual(["отчёт 1 (1).txt", "отчёт 1.txt"]);
    expect(readFileSync(join(dir, "отчёт 1.txt"), "utf8")).toBe("hello file");
    // The hub copied them into the agent's workspace (see the fake files.deliver in beforeAll).
    expect(readFileSync(join(workspace, "downloads", "отчёт 1.txt"), "utf8")).toBe("hello file");
    expect(h.coreCalls.filter((c) => c.method === "files.deliver").every((c) => c.params.sessionId)).toBe(true);
    // Opening a file URL downloads it instead of failing.
    expect(await ok("open", { url: base + "/file.txt" })).toMatch(/The URL turned out to be a file; it was downloaded\. File saved to the workspace: downloads\/отчёт 1 \(2\)\.txt/);
  });

  it("manages tabs", async () => {
    await ok("tabs", { action: "new", url: base + "/about" });
    const list = await ok("tabs", { action: "list" });
    expect(list).toMatch(/2 \* О нас/);
    await ok("tabs", { action: "switch", index: 1 });
    await ok("tabs", { action: "close", index: 2 });
    expect(await ok("tabs", { action: "list" })).not.toContain("О нас");
  });

  it("tells the model to hand captchas to the user", async () => {
    const r = await ok("open", { url: base + "/captcha" });
    expect(r).toContain("captcha");
    expect(r).toContain("take control");
  });

  it("reports activity for the live view: who drives the browser and when it needs the user", async () => {
    const acts = () =>
      h.coreCalls.filter((c) => c.method === "ui.emit" && (c.params as { channel: string }).channel === "activity").map((c) => (c.params as { payload: any }).payload);
    const from = acts().length;
    await ok("open", { url: base + "/captcha" });
    const during = acts().slice(from);
    expect(during.some((a) => a.busy === "open" && a.agentId === "assistant")).toBe(true);
    expect(during.at(-1)).toMatchObject({ running: true, busy: null, agentId: "assistant", control: "agent", attention: true });

    // Taking control answers the request; a page without a captcha clears it too.
    h.uiMessage({ type: "control", on: true });
    await until(() => acts().at(-1)?.control === "user" && acts().at(-1)?.attention === false);
    h.uiMessage({ type: "control", on: false });
    await until(() => acts().at(-1)?.control === "agent");
    await ok("snapshot");
    expect(acts().at(-1)).toMatchObject({ attention: true });
    await ok("open", { url: base + "/about" });
    expect(acts().at(-1)).toMatchObject({ busy: null, attention: false, url: base + "/about" });

    // A UI that loads later asks for the current value.
    const before = acts().length;
    h.uiMessage({ type: "activity" });
    await until(() => acts().length > before);
    expect(acts().at(-1)).toMatchObject({ running: true, url: base + "/about" });
  });

  it("keeps the agent away from local addresses unless allowed", async () => {
    h.setSettings({ headless: "always", takeoverWaitSec: 0 });
    const r = await call("open", { url: base + "/" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("local network");
    expect((await call("download", { url: "http://169.254.169.254/latest" })).isError).toBe(true);
    h.setSettings({ headless: "always", allowLocalNetwork: true, takeoverWaitSec: 0 });
    await ok("open", { url: base + "/" });
  });

  it("reports pane errors with a code the UI translates", async () => {
    h.uiMessage({ type: "navigate", url: "ftp://example.com/" });
    const err = await until(() => h.coreCalls.find((c) => c.method === "ui.emit" && (c.params as { channel: string }).channel === "error"));
    expect((err.params as { payload: unknown }).payload).toEqual({
      message: "Only http(s) URLs can be opened, not ftp:",
      code: "urlProtocol",
      params: { protocol: "ftp:" },
    });
  });

  it("streams frames to the UI and lets the user take over", async () => {
    await ok("open", { url: base + "/counter" });
    const emits = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    h.uiMessage({ type: "watch", on: true });
    const frame = await until(() => emits().find((e) => e.channel === "frame"));
    expect(Buffer.from(frame.payload.data, "base64")[0]).toBe(0xff);
    // The page gets what the 1280×900 window leaves under its toolbar.
    expect(frame.payload).toMatchObject({ width: 1280, url: base + "/counter" });
    expect(frame.payload.height).toBeGreaterThan(700);
    const height: number = frame.payload.height;
    await until(() => emits().find((e) => e.channel === "state" && e.payload.running && e.payload.url === base + "/counter"));

    h.uiMessage({ type: "control", on: true });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === true));
    const blocked = await call("snapshot");
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("The user is controlling the browser");

    // Click the big button (top-left 640x400 of the page) and type into the field below it.
    const framesBefore = emits().filter((e) => e.channel === "frame").length;
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 0.1, button: "left", clickCount: 1 });
    // The repaint after the click arrives as a screencast frame.
    await until(() => emits().filter((e) => e.channel === "frame").length > framesBefore);
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 520 / height, button: "left", clickCount: 1 });
    for (const key of ["a", "b"]) {
      h.uiMessage({ type: "input", event: "key", action: "down", key, code: `Key${key.toUpperCase()}` });
      h.uiMessage({ type: "input", event: "key", action: "up", key, code: `Key${key.toUpperCase()}` });
    }
    h.uiMessage({ type: "input", event: "text", text: "вг" });
    h.uiMessage({ type: "control", on: false });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === false));
    await new Promise((r) => setTimeout(r, 300));
    const snap = await ok("snapshot");
    expect(snap).toContain('button "нажато 1"');
    expect(snap).toContain('textbox "Поле" value="abвг"');
    h.uiMessage({ type: "watch", on: false });
  });
});

describe("browser plugin behind the hub egress proxy", () => {
  let h: PluginHarness;
  let proxy: Server;
  let origin: Server;
  const seen: Array<{ method: string; url: string; auth?: string }> = [];

  beforeAll(async () => {
    // Every host "behind" the proxy is served by this local origin.
    origin = createServer((req, res) => {
      const path = req.url ?? "/";
      const local = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/secret`;
      if (path.endsWith("/data.csv")) {
        res.writeHead(200, { "content-type": "text/csv" }).end("a,b\n1,2\n");
      } else if (path.endsWith("/redirect")) {
        res.writeHead(302, { location: local }).end();
      } else if (path.endsWith("/secret")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Секретная админка", "<h1>Админка</h1>"));
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Через прокси", `<h1>Через прокси</h1><a href="${local}">Локальная ссылка</a>`));
      }
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const originPort = (origin.address() as AddressInfo).port;
    // A minimal proxy that, like the hub's egress proxy, wants the token in Proxy-Authorization (plain HTTP and CONNECT).
    const authorized = (auth: string | undefined) => !!auth && Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString() === "tok_test:x";
    proxy = createServer((req, res) => {
      const auth = req.headers["proxy-authorization"] as string | undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth });
      if (!authorized(auth)) {
        res.writeHead(auth ? 403 : 407, { "proxy-authenticate": 'Basic realm="owlbot"' }).end();
        return;
      }
      const target = new URL(req.url ?? "/");
      const up = request({ host: "127.0.0.1", port: originPort, path: target.pathname + target.search, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    proxy.on("connect", (req, socket: Socket, head) => {
      const auth = req.headers["proxy-authorization"] as string | undefined;
      seen.push({ method: "CONNECT", url: req.url ?? "", auth });
      if (!authorized(auth)) {
        socket.end(`HTTP/1.1 ${auth ? "403 Forbidden" : "407 Proxy Authentication Required"}\r\nProxy-Authenticate: Basic realm="owlbot"\r\n\r\n`);
        return;
      }
      const up = connect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const url = `http://tok_test:x@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    h = await startPlugin({
      dir: PLUGIN_DIR,
      settings: { headless: "always" },
      env: { ...browsersEnv(), HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "", no_proxy: "" },
    });
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
    proxy?.close();
    origin?.close();
  });

  it("sends browser traffic through the proxy with the token from the env", async () => {
    const r = await h.invoke("open", { url: "http://proxied.example/" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toContain("Через прокси — http://proxied.example/");
    expect(seen.some((s) => s.url === "http://proxied.example/" && authorizedSeen(s.auth))).toBe(true);
    // Downloads by URL use the browser context's request API, which must use the same proxy and token.
    const d = await h.invoke("download", { url: "http://proxied.example/data.csv" });
    expect(d.isError, text(d)).toBeFalsy();
    expect(readFileSync(join(h.dataDir, "downloads", "data.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(seen.filter((s) => s.url.includes("proxied.example")).every((s) => !s.auth || authorizedSeen(s.auth))).toBe(true);
  });

  it("does not let links or redirects from public pages take the agent to local addresses", async () => {
    await h.invoke("open", { url: "http://proxied.example/" });
    const snap = text(await h.invoke("snapshot"));
    const click = await h.invoke("click", { ref: refOf(snap, /link "Локальная ссылка"/) });
    expect(click.isError).toBe(true);
    expect(text(click)).toContain("local address 127.0.0.1");
    expect(text(click)).not.toContain("Секретная админка");
    expect(text(click)).toContain("about:blank");
    const redirect = await h.invoke("open", { url: "http://proxied.example/redirect" });
    expect(redirect.isError).toBe(true);
    expect(text(redirect)).not.toContain("Секретная админка");
  });
});
