// End-to-end tests: the plugin runs in a real child process (testkit harness) and drives headless Chromium
// against a local HTTP server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { ToolResult } from "@openbot/shared";
import { catalogLookup, localizeValue, readPluginLayout } from "@openbot/shared";
import { startPlugin, type PluginHarness } from "@openbot/testkit";

const PLUGIN_DIR = join(import.meta.dirname, "..");
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
    const summary = h.tools.get("submit")!.approvalSummary!;
    expect(summary).toBe("%approval.submit%");
    const { messages } = readPluginLayout(PLUGIN_DIR);
    expect(localizeValue(summary, catalogLookup(messages, "en"))).toBe("Browser: {description} ({url})");
    expect(localizeValue(summary, catalogLookup(messages, "ru"))).toBe("Браузер: {description} ({url})");
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
    const buy = await call("click", { ref: refOf(snap, /button "Купить"/) });
    expect(buy.isError).toBe(true);
    expect(text(buy)).toContain("browser_submit");
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
    const wrong = await call("submit", { ref: refOf(snap, /button "Купить"/), url: "https://shop.example/", description: "Купить" });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("The page has changed");
    const r = await ok("submit", { ref: refOf(snap, /button "Купить"/), url: base + "/", description: "Оформить заказ в тестовом магазине" });
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
    const r = await ok("submit", { ref, url: base + "/confirm", description: "Удалить запись" });
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
    const r = await ok("submit", { ref: refOf(after, /button "Войти"/), url: base + "/login", description: "Войти на тестовый сайт" });
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
    expect(frame.payload).toMatchObject({ width: 1280, height: 800, url: base + "/counter" });
    await until(() => emits().find((e) => e.channel === "state" && e.payload.running && e.payload.url === base + "/counter"));

    h.uiMessage({ type: "control", on: true });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === true));
    const blocked = await call("snapshot");
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("The user is controlling the browser");

    // Click the big button (top-left 640x400 of the 1280x800 viewport) and type into the field below it.
    const framesBefore = emits().filter((e) => e.channel === "frame").length;
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 0.1, button: "left", clickCount: 1 });
    // The repaint after the click arrives as a screencast frame.
    await until(() => emits().filter((e) => e.channel === "frame").length > framesBefore);
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 520 / 800, button: "left", clickCount: 1 });
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
        res.writeHead(auth ? 403 : 407, { "proxy-authenticate": 'Basic realm="openbot"' }).end();
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
        socket.end(`HTTP/1.1 ${auth ? "403 Forbidden" : "407 Proxy Authentication Required"}\r\nProxy-Authenticate: Basic realm="openbot"\r\n\r\n`);
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
      env: { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "", no_proxy: "" },
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
