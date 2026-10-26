// Browser lifecycle: lazy Chromium launch with a persistent profile, active tab, serialized agent tool calls,
// idle shutdown, dialogs and downloads, live view (CDP screencast) and user takeover (CDP input).

import { chromium } from "playwright";
import type { BrowserContext, CDPSession, Dialog, Download, Frame, Locator, Page } from "playwright";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@openbot/shared";
import type { PluginContext } from "@openbot/plugin-sdk";
import { pageCall } from "./page-script.ts";
import { ACTION_LABEL_RE, LINK_ACTION_LABEL_RE } from "./safety.ts";
import {
  cut,
  decideHeadless,
  formatSize,
  isPrivateHost,
  normalizeUrl,
  proxyFromEnv,
  readSettings,
  sanitizeFilename,
  sleep,
  uniquePath,
  withTimeout,
  type BrowserSettings,
} from "./util.ts";

/** An error whose message is meant for the model / user as is. */
export class ToolError extends Error {}

export const VIEWPORT = { width: 1280, height: 800 };
const WATCH_TTL_MS = 30_000;
const FRAME_INTERVAL_MS = 100;

export interface Classified {
  submit: boolean;
  reason: string;
  search: boolean;
  inForm: boolean;
  editable: boolean;
  tag: string;
  inputType: string;
  role: string;
  name: string;
  href: string;
}

export interface DownloadRecord {
  path: string;
  name: string;
  size: number;
  url: string;
}

interface Cast {
  page: Page;
  cdp: CDPSession;
  width: number;
  height: number;
  lastEmit: number;
  pending: string | null;
  timer: NodeJS.Timeout | null;
}

export class BrowserManager {
  ctx: PluginContext;
  settings: BrowserSettings;
  readonly downloadsDir: string;
  private readonly profileDir: string;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private active: Page | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private refSeq = 1;
  private lastUse = Date.now();
  private notes: string[] = [];
  private downloadWaiters: Array<(r: { done: Promise<DownloadRecord> }) => void> = [];
  private acceptDialogs = false;
  private headlessMode: boolean | null = null;
  private timers: NodeJS.Timeout[] = [];
  // live view and takeover
  private watchers = new Map<string, number>();
  private cast: Cast | null = null;
  private castChain: Promise<void> = Promise.resolve();
  private inputCdp: { page: Page; cdp: CDPSession } | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private titles = new WeakMap<Page, string>();
  userControl = false;
  busy: string | null = null;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.settings = readSettings(ctx.settings);
    this.downloadsDir = join(ctx.dataDir, "downloads");
    this.profileDir = join(ctx.dataDir, "profile");
    this.timers.push(setInterval(() => void this.tick(), 5_000));
    for (const t of this.timers) t.unref();
  }

  // ---------- settings and lifecycle ----------

  updateSettings(raw: Record<string, any>): void {
    const prev = this.settings;
    this.settings = readSettings(raw);
    if (this.context && prev.headless !== this.settings.headless && !this.busy && !this.userControl) {
      void this.close();
    }
  }

  get running(): boolean {
    return !!this.context;
  }

  /** Someone has the browser pane open (each viewer renews its watch every 20 s). */
  private watching(): boolean {
    const now = Date.now();
    for (const [id, until] of this.watchers) if (until <= now) this.watchers.delete(id);
    return this.watchers.size > 0;
  }

  /** The last viewer left: stop streaming and give control back to the agent. */
  private onWatchersGone(): void {
    if (this.userControl) this.setControl(false);
    this.syncCast();
  }

  private async tick(): Promise<void> {
    if (this.watchers.size && !this.watching()) this.onWatchersGone();
    const idleMs = this.settings.idleMinutes * 60_000;
    if (this.context && !this.busy && !this.userControl && !this.watching() && Date.now() - this.lastUse > idleMs) {
      this.ctx.log.info(`closing the browser after ${this.settings.idleMinutes} min without use`);
      await this.close();
    }
  }

  touch(): void {
    this.lastUse = Date.now();
  }

  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.launching ??= this.launch().finally(() => (this.launching = null));
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    mkdirSync(this.profileDir, { recursive: true });
    mkdirSync(this.downloadsDir, { recursive: true });
    // A previous process (or container) may have left Chromium's profile lock behind; we are the only user of it.
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(this.profileDir, f), { force: true });
    const headless = decideHeadless(this.settings.headless, process.env, process.platform);
    const proxy = proxyFromEnv(process.env, this.settings.allowLocalNetwork);
    const open = (h: boolean) =>
      // Default channel: Playwright's headless shell when headless, full Chromium when headed (Xvfb in Docker).
      chromium.launchPersistentContext(this.profileDir, {
        headless: h,
        viewport: VIEWPORT,
        acceptDownloads: true,
        ...(proxy ? { proxy } : {}),
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=Translate",
          // WebRTC must not open UDP connections around the egress proxy.
          ...(proxy ? ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] : []),
        ],
      });
    let context: BrowserContext;
    try {
      context = await open(headless);
      this.headlessMode = headless;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/Executable doesn't exist|browserType\.launch.*install/i.test(msg)) {
        throw new ToolError("Chromium не установлен. Выполните на сервере: npx playwright install chromium");
      }
      if (!headless) {
        this.ctx.log.warn(`headed launch failed (${msg.split("\n")[0]}), falling back to headless`);
        context = await open(true);
        this.headlessMode = true;
      } else {
        throw new ToolError(`Не удалось запустить браузер: ${msg.split("\n")[0]}`);
      }
    }
    this.ctx.log.info(`browser started (${this.headlessMode ? "headless" : "headed"}${proxy ? ", via egress proxy" : ""})`);
    context.on("close", () => this.onContextClosed(context));
    context.on("page", (p) => {
      this.trackPage(p);
      if (this.context === context) {
        if (this.active && !this.active.isClosed() && this.busy && this.busy !== "tabs") this.note("Открылась новая вкладка, она стала активной.");
        this.setActive(p);
      }
    });
    for (const p of context.pages()) this.trackPage(p);
    this.context = context;
    this.active = context.pages()[0] ?? (await context.newPage());
    this.scheduleState();
    this.syncCast();
    return context;
  }

  async close(): Promise<void> {
    const c = this.context;
    this.context = null;
    this.active = null;
    if (this.userControl) this.setControl(false);
    await this.stopCastNow();
    this.inputCdp = null;
    if (c) await withTimeout(c.close(), 10_000).catch(() => {});
    this.scheduleState();
  }

  async dispose(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    await this.close();
  }

  private onContextClosed(c: BrowserContext): void {
    if (this.context !== c) return;
    this.context = null;
    this.active = null;
    this.cast = null;
    this.inputCdp = null;
    if (this.userControl) this.setControl(false);
    this.scheduleState();
  }

  private trackPage(p: Page): void {
    p.on("dialog", (d) => void this.onDialog(d));
    p.on("download", (d) => this.onDownload(d));
    p.on("close", () => this.onPageClosed(p));
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) this.scheduleState();
    });
    p.on("load", () => this.scheduleState());
  }

  private onPageClosed(p: Page): void {
    if (this.active === p) {
      const rest = this.context?.pages().filter((x) => !x.isClosed()) ?? [];
      this.active = rest[rest.length - 1] ?? null;
      this.syncCast();
    }
    this.scheduleState();
  }

  setActive(p: Page): void {
    if (this.active === p) return;
    this.active = p;
    void p.bringToFront().catch(() => {});
    this.syncCast();
    this.scheduleState();
  }

  pages(): Page[] {
    return this.context?.pages().filter((p) => !p.isClosed()) ?? [];
  }

  activePage(): Page | null {
    return this.active && !this.active.isClosed() ? this.active : null;
  }

  async ensurePage(): Promise<Page> {
    const context = await this.ensureContext();
    if (this.active && !this.active.isClosed()) return this.active;
    const rest = this.pages();
    const p = rest[rest.length - 1] ?? (await context.newPage());
    this.setActive(p);
    return p;
  }

  /** While an approved browser_submit runs, confirm() dialogs are part of the approved action and get accepted. */
  allowConfirmDialogs(on: boolean): void {
    this.acceptDialogs = on;
  }

  // ---------- notes: dialogs, downloads, new tabs ----------

  note(s: string): void {
    this.notes.push(s);
    if (this.notes.length > 10) this.notes.shift();
  }

  private async onDialog(d: Dialog): Promise<void> {
    const type = d.type();
    const msg = cut(d.message().replace(/\s+/g, " "), 200);
    try {
      if (type === "beforeunload") await d.accept();
      else if (this.acceptDialogs && type === "confirm") {
        await d.accept();
        this.note(`Страница спросила «${msg}» — подтверждено в рамках одобренного действия.`);
      } else {
        await d.dismiss();
        this.note(type === "alert" ? `Страница показала сообщение: «${msg}».` : `Страница показала диалог (${type}): «${msg}» — отменён автоматически.`);
      }
    } catch {
      /* dialog already handled */
    }
  }

  private onDownload(d: Download): void {
    const done = this.saveDownload(d);
    done.catch(() => {});
    const waiter = this.downloadWaiters.shift();
    if (waiter) {
      waiter({ done });
      return;
    }
    done.then(
      (r) => this.note(`Скачан файл: ${r.path} (${formatSize(r.size)}).`),
      (e) => this.note(`Не удалось скачать файл: ${e.message}`),
    );
  }

  private async saveDownload(d: Download): Promise<DownloadRecord> {
    mkdirSync(this.downloadsDir, { recursive: true });
    const name = sanitizeFilename(d.suggestedFilename());
    const path = uniquePath(this.downloadsDir, name);
    await d.saveAs(path);
    const failure = await d.failure();
    if (failure) throw new Error(failure);
    const size = statSync(path).size;
    const max = this.settings.maxDownloadMb * 1024 * 1024;
    if (size > max) {
      rmSync(path, { force: true });
      throw new Error(`файл больше ${this.settings.maxDownloadMb} МБ`);
    }
    return { path, name, size, url: d.url() };
  }

  /**
   * Resolves as soon as a download starts within `ms` (its `done` settles when the file is saved).
   * Register before triggering the download.
   */
  waitDownloadStart(ms: number): { started: Promise<{ done: Promise<DownloadRecord> }>; cancel: () => void } {
    let resolveFn!: (r: { done: Promise<DownloadRecord> }) => void;
    const started = new Promise<{ done: Promise<DownloadRecord> }>((resolve, reject) => {
      resolveFn = resolve;
      setTimeout(() => {
        const i = this.downloadWaiters.indexOf(resolveFn);
        if (i >= 0) {
          this.downloadWaiters.splice(i, 1);
          reject(new ToolError("Скачивание не началось."));
        }
      }, ms).unref();
    });
    this.downloadWaiters.push(resolveFn);
    started.catch(() => {});
    return {
      started,
      cancel: () => {
        const i = this.downloadWaiters.indexOf(resolveFn);
        if (i >= 0) this.downloadWaiters.splice(i, 1);
      },
    };
  }

  // ---------- agent tool execution ----------

  /**
   * Run an agent tool: serialized, waits while the user controls the browser, appends notes and the page line.
   * `fn` returns the main text (or a full ToolResult, e.g. with an image).
   */
  async tool(name: string, fn: (page: Page) => Promise<string | ToolResult>): Promise<ToolResult> {
    const job = this.queue.then(() => this.runTool(name, fn));
    this.queue = job.catch(() => {});
    return job;
  }

  private async runTool(name: string, fn: (page: Page) => Promise<string | ToolResult>): Promise<ToolResult> {
    if (this.userControl) {
      const until = Date.now() + this.settings.takeoverWaitSec * 1000;
      while (this.userControl && Date.now() < until) await sleep(200);
      if (this.userControl) {
        return {
          content: [
            {
              type: "text",
              text: "Пользователь управляет браузером. Дождитесь, пока он вернёт управление (кнопка в панели «Браузер»), и повторите действие; при необходимости спросите пользователя.",
            },
          ],
          isError: true,
        };
      }
    }
    this.touch();
    this.busy = name;
    this.scheduleState();
    let result: ToolResult;
    try {
      const page = await this.ensurePage();
      const before = { page, url: page.url(), pages: new Set(this.pages()) };
      const out = await fn(page);
      result = typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
      const blocked = await this.guardLanded(before);
      if (blocked) result = { content: [{ type: "text", text: blocked }], isError: true };
    } catch (e: any) {
      result = { content: [{ type: "text", text: friendlyError(e) }], isError: true };
    } finally {
      this.busy = null;
      this.touch();
      this.scheduleState();
    }
    const tail = [...this.drainNotes(), await this.pageLine()].filter(Boolean).join("\n");
    const texts = result.content.filter((c) => c.type === "text");
    if (texts.length) {
      const last = texts[texts.length - 1] as { type: "text"; text: string };
      last.text = `${last.text}\n${tail}`;
    } else {
      result.content.push({ type: "text", text: tail });
    }
    return result;
  }

  private drainNotes(): string[] {
    const n = this.notes;
    this.notes = [];
    return n;
  }

  async pageLine(): Promise<string> {
    const p = this.activePage();
    if (!p) return this.context ? "Открытых вкладок нет." : "Браузер закрыт.";
    const title = await this.titleOf(p);
    const pages = this.pages();
    const tab = pages.length > 1 ? ` (вкладка ${pages.indexOf(p) + 1} из ${pages.length})` : "";
    return `Страница: ${cut(title, 120) || "(без заголовка)"} — ${cut(p.url(), 300)}${tab}`;
  }

  async titleOf(p: Page): Promise<string> {
    const t = await withTimeout(p.title(), 1000).catch(() => this.titles.get(p) ?? "");
    this.titles.set(p, t);
    return t;
  }

  /** Wait until the page settles after an action (navigation or SPA update), bounded. */
  async settle(maxMs = 2500): Promise<void> {
    const deadline = Date.now() + maxMs;
    await sleep(150);
    const p = this.activePage();
    if (!p) return;
    await p.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await p.waitForLoadState("networkidle", { timeout: Math.max(300, deadline - Date.now()) }).catch(() => {});
  }

  /** Agent navigation guard: no localhost / LAN unless allowed in settings. */
  guardUrl(u: URL): void {
    if (u.protocol === "about:") return;
    if (!this.settings.allowLocalNetwork && isPrivateHost(u.hostname)) {
      throw new ToolError(
        `Адрес ${u.hostname} относится к локальной сети или этому серверу; агенту он закрыт. ` +
          "Пользователь может разрешить это в настройках плагина «Браузер» (allowLocalNetwork) или открыть адрес сам в панели «Браузер».",
      );
    }
  }

  /** After a navigation: a public URL must not land on a local address through redirects. */
  /**
   * After an agent tool: if it navigated (link, redirect, popup) to a local address, leave that page and report.
   * Pages the user opened there himself are left alone.
   */
  private async guardLanded(before: { page: Page; url: string; pages: Set<Page> }): Promise<string | null> {
    if (this.settings.allowLocalNetwork) return null;
    const p = this.activePage();
    if (!p) return null;
    let u: URL;
    try {
      u = new URL(p.url());
    } catch {
      return null;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !isPrivateHost(u.hostname)) return null;
    const navigated = p === before.page ? p.url() !== before.url : !before.pages.has(p);
    if (!navigated) return null;
    if (p === before.page) await p.goto("about:blank").catch(() => {});
    else await p.close().catch(() => {});
    return `Переход привёл на локальный адрес ${u.hostname}; агенту он закрыт, страница покинута. Пользователь может разрешить такие адреса в настройках плагина «Браузер» (allowLocalNetwork).`;
  }

  // ---------- page script helpers ----------

  async evalIn<T = any>(frame: Frame, op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const full = { action: ACTION_LABEL_RE.source, linkAction: LINK_ACTION_LABEL_RE.source, seq: this.refSeq, ...args };
    const r = (await withTimeout(frame.evaluate(pageCall(op, full)), timeoutMs, "страница не отвечает")) as any;
    if (r && typeof r === "object" && typeof r.seq === "number" && r.seq > this.refSeq) this.refSeq = r.seq;
    return r as T;
  }

  /** Find an element by ref in any frame of the page. */
  async locate(page: Page, ref: string): Promise<{ frame: Frame; loc: Locator }> {
    const r = String(ref ?? "").trim();
    if (!/^e\d+$/.test(r)) throw new ToolError(`Неверный ref «${cut(r, 40)}»: используйте ref из browser_snapshot, например e12.`);
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const loc = frame.locator(`[data-ob-ref="${r}"]`);
      const n = await loc.count().catch(() => 0);
      if (n > 1) throw new ToolError(`Ссылка ${r} неоднозначна (страница скопировала элемент). Вызовите browser_snapshot и используйте новые ref.`);
      if (n === 1) return { frame, loc };
    }
    throw new ToolError(`Элемент ${r} не найден на текущей странице (она могла измениться). Вызовите browser_snapshot и используйте новые ref.`);
  }

  async classify(frame: Frame, ref: string): Promise<Classified> {
    const c = await this.evalIn<Classified | null>(frame, "classify", { ref });
    if (!c) throw new ToolError(`Элемент ${ref} не найден. Вызовите browser_snapshot.`);
    return c;
  }

  /**
   * The focused element (assigns it a ref), or null when nothing is focused. When focus is inside an iframe we
   * can not inspect, the answer is conservative: treat it as an editable field.
   */
  async focusInfo(page: Page): Promise<any | null> {
    const main = await this.evalIn<any>(page.mainFrame(), "focus", {}, 3000).catch(() => null);
    if (!main || main.none) return null;
    if (!main.frame) return main;
    for (const frame of page.frames().slice(1)) {
      if (frame.isDetached()) continue;
      const r = await this.evalIn<any>(frame, "focus", {}, 3000).catch(() => null);
      if (r && !r.frame && !r.none) return r;
    }
    return { tag: "iframe", name: "", editable: true, inForm: false, search: false, submit: false };
  }

  // ---------- live view and takeover (driven by the UI) ----------

  onUiMessage(m: any): void {
    if (!m || typeof m !== "object") return;
    const run = (f: () => Promise<unknown>) =>
      void f().catch((e) => {
        this.ctx.log.warn(`ui ${m.type}: ${e?.message ?? e}`);
        this.ctx.ui.emit("error", { message: friendlyError(e) });
      });
    switch (m.type) {
      case "watch": {
        const id = typeof m.id === "string" && m.id ? m.id.slice(0, 64) : "default";
        if (m.on === false) {
          const had = this.watchers.delete(id);
          if (had && !this.watching()) this.onWatchersGone();
        } else {
          const first = !this.watching();
          this.watchers.set(id, Date.now() + WATCH_TTL_MS);
          if (first || m.refresh) void this.emitState();
          this.syncCast(first || !!m.refresh);
        }
        return;
      }
      case "start":
        this.touch();
        return run(() => this.ensurePage());
      case "navigate":
        this.touch();
        return run(async () => {
          // The user is trusted: no local-network guard here, only the http(s) scheme check.
          const u = normalizeUrl(String(m.url ?? ""));
          const page = await this.ensurePage();
          await page.goto(u.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        });
      case "back":
      case "forward":
      case "reload":
        this.touch();
        return run(async () => {
          const page = this.activePage();
          if (!page) return;
          if (m.type === "back") await page.goBack({ timeout: 15_000 });
          else if (m.type === "forward") await page.goForward({ timeout: 15_000 });
          else await page.reload({ timeout: 30_000 });
        });
      case "tab":
        this.touch();
        return run(async () => {
          const pages = this.pages();
          const idx = Number(m.index) - 1;
          if (m.action === "new") this.setActive(await (await this.ensureContext()).newPage());
          else if (m.action === "switch" && pages[idx]) this.setActive(pages[idx]);
          else if (m.action === "close" && (pages[idx] ?? this.activePage())) await (pages[idx] ?? this.activePage())!.close();
        });
      case "control":
        this.setControl(!!m.on);
        return;
      case "input":
        if (!this.userControl) return;
        this.touch();
        return run(() => this.dispatchInput(m));
      case "state":
        void this.emitState();
        return;
    }
  }

  setControl(on: boolean): void {
    if (this.userControl === on) return;
    this.userControl = on;
    this.ctx.log.info(on ? "user took control of the browser" : "user returned control to the agent");
    this.ctx.ui.emit("control", { user: on });
    void this.emitState();
  }

  private viewport(): { w: number; h: number } {
    if (this.cast) return { w: this.cast.width, h: this.cast.height };
    const vp = this.activePage()?.viewportSize();
    return { w: vp?.width ?? VIEWPORT.width, h: vp?.height ?? VIEWPORT.height };
  }

  private async inputSession(): Promise<CDPSession | null> {
    const page = this.activePage();
    if (!page || !this.context) return null;
    if (this.cast?.page === page) return this.cast.cdp;
    if (this.inputCdp?.page === page) return this.inputCdp.cdp;
    void this.inputCdp?.cdp.detach().catch(() => {});
    const cdp = await this.context.newCDPSession(page);
    this.inputCdp = { page, cdp };
    return cdp;
  }

  async dispatchInput(m: any): Promise<void> {
    const cdp = await this.inputSession();
    if (!cdp) return;
    const { w, h } = this.viewport();
    const x = clamp01(m.x) * w;
    const y = clamp01(m.y) * h;
    const modifiers = modifierMask(m);
    switch (m.event) {
      case "mouse": {
        const type = ({ down: "mousePressed", up: "mouseReleased", move: "mouseMoved" } as const)[m.action as "down" | "up" | "move"];
        if (!type) return;
        const button = ["left", "middle", "right", "back", "forward"].includes(m.button) ? m.button : type === "mouseMoved" ? "none" : "left";
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button,
          buttons: Number.isInteger(m.buttons) ? m.buttons : undefined,
          clickCount: type === "mouseMoved" ? 0 : Math.min(3, Math.max(1, Number(m.clickCount) || 1)),
          modifiers,
        });
        return;
      }
      case "wheel":
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: clampAbs(Number(m.deltaX) || 0, 5000),
          deltaY: clampAbs(Number(m.deltaY) || 0, 5000),
          modifiers,
        });
        return;
      case "key": {
        const params = keyEventParams(m, modifiers);
        if (params) await cdp.send("Input.dispatchKeyEvent", params);
        return;
      }
      case "text": {
        const text = String(m.text ?? "").slice(0, 10_000);
        if (text) await cdp.send("Input.insertText", { text });
        return;
      }
    }
  }

  /**
   * Start/stop/move the screencast to match "someone is watching" and the active tab. Serialized.
   * `refresh` sends a still frame right away (a new viewer would otherwise wait for the next repaint).
   */
  syncCast(refresh = false): void {
    this.castChain = this.castChain.then(() => this.syncCastNow(refresh)).catch((e) => this.ctx.log.warn(`screencast: ${e?.message ?? e}`));
  }

  private emitFrame(cast: Cast, data: string): void {
    cast.lastEmit = Date.now();
    this.ctx.ui.emit("frame", { data, width: cast.width, height: cast.height, url: cast.page.url(), title: this.titles.get(cast.page) ?? "" });
  }

  /** At most one frame per FRAME_INTERVAL_MS to the UI; the trailing frame is always delivered. */
  private flushFrame(cast: Cast): void {
    if (cast.timer) return;
    const wait = Math.max(0, cast.lastEmit + FRAME_INTERVAL_MS - Date.now());
    cast.timer = setTimeout(() => {
      cast.timer = null;
      if (this.cast !== cast || !cast.pending) return;
      const data = cast.pending;
      cast.pending = null;
      this.emitFrame(cast, data);
    }, wait);
  }

  private async syncCastNow(refresh: boolean): Promise<void> {
    const page = this.activePage();
    const want = this.watching() && !!this.context && !!page;
    if (!want) return this.stopCastNow();
    if (this.cast?.page !== page) {
      await this.stopCastNow();
      const cdp = await this.context!.newCDPSession(page!);
      const vp = page!.viewportSize() ?? VIEWPORT;
      const cast: Cast = { page: page!, cdp, width: vp.width, height: vp.height, lastEmit: 0, pending: null, timer: null };
      this.cast = cast;
      cdp.on("Page.screencastFrame", (f) => {
        // Ack at once: Chrome does not resend a repaint it skipped while waiting for an ack, so a throttled ack
        // would leave the viewer on a stale picture. Throttling happens on our side, latest frame wins.
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        if (this.cast !== cast) return;
        cast.width = Math.round(f.metadata.deviceWidth) || cast.width;
        cast.height = Math.round(f.metadata.deviceHeight) || cast.height;
        cast.pending = f.data;
        this.flushFrame(cast);
      });
      // Page domain events (screencastFrame) are only delivered to sessions that enabled the domain.
      await cdp.send("Page.enable");
      // everyNthFrame 1: with 2, a single repaint (one typed letter) can be skipped and never shown.
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
      refresh = true;
    }
    // Chrome only sends screencast frames on repaint: a static page would show nothing until it changes.
    const cast = this.cast;
    if (refresh && cast) {
      const shot = await cast.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 50 }).catch(() => null);
      if (shot && this.cast === cast) this.emitFrame(cast, shot.data);
    }
  }

  private async stopCastNow(): Promise<void> {
    const c = this.cast;
    this.cast = null;
    if (!c) return;
    if (c.timer) clearTimeout(c.timer);
    await c.cdp.send("Page.stopScreencast").catch(() => {});
    await c.cdp.detach().catch(() => {});
  }

  /** Debounced "state" event for the UI (only while someone watches). */
  scheduleState(): void {
    if (!this.watching()) return;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.emitState();
    }, 150);
  }

  async emitState(): Promise<void> {
    const pages = this.pages();
    const active = this.activePage();
    const tabs = await Promise.all(
      pages.map(async (p, i) => ({ index: i + 1, title: cut(await this.titleOf(p), 80), url: p.url(), active: p === active })),
    );
    this.ctx.ui.emit("state", {
      running: !!this.context,
      headless: this.headlessMode,
      control: this.userControl ? "user" : "agent",
      busy: this.busy,
      tabs,
      url: active?.url() ?? "",
      title: active ? (this.titles.get(active) ?? "") : "",
    });
  }
}

// ---------- helpers ----------

function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function clampAbs(n: number, max: number): number {
  return Math.max(-max, Math.min(max, n));
}

function modifierMask(m: any): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

const SPECIAL_KEYS: Record<string, [number, string?]> = {
  Enter: [13, "\r"],
  Tab: [9],
  Backspace: [8],
  Escape: [27],
  Delete: [46],
  Insert: [45],
  Home: [36],
  End: [35],
  PageUp: [33],
  PageDown: [34],
  ArrowLeft: [37],
  ArrowUp: [38],
  ArrowRight: [39],
  ArrowDown: [40],
  Shift: [16],
  Control: [17],
  Alt: [18],
  Meta: [91],
  CapsLock: [20],
  ContextMenu: [93],
};
for (let i = 1; i <= 12; i++) SPECIAL_KEYS[`F${i}`] = [111 + i];

/** UI keyboard event → CDP Input.dispatchKeyEvent params. */
export function keyEventParams(m: any, modifiers: number): any | null {
  const key = String(m.key ?? "");
  if (!key || key.length > 32) return null;
  const code = String(m.code ?? "");
  const special = SPECIAL_KEYS[key];
  const printable = [...key].length === 1;
  const vk = special?.[0] ?? (Number.isInteger(m.keyCode) && m.keyCode > 0 ? m.keyCode : printable ? key.toUpperCase().charCodeAt(0) : 0);
  // Ctrl/Meta shortcuts do not insert text (AltGr = Ctrl+Alt does).
  const shortcut = (modifiers & 4) !== 0 || ((modifiers & 2) !== 0 && (modifiers & 1) === 0);
  const text = shortcut ? undefined : (special?.[1] ?? (printable ? key : undefined));
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  if (m.action === "up") return { ...base, type: "keyUp" };
  return { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text, autoRepeat: !!m.repeat };
}

/** Playwright errors are long (call logs); keep the first line and translate the common cases. */
export function friendlyError(e: any): string {
  if (e instanceof ToolError) return e.message;
  const msg = String(e?.message ?? e);
  const first = msg.split("\n")[0].replace(/^\w+\.\w+:\s*/, "");
  if (/intercepts pointer events/.test(msg)) return "Элемент перекрыт другим элементом (баннер, всплывающее окно или диалог). Закройте его или прокрутите страницу и попробуйте снова.";
  if (/Target page, context or browser has been closed|Target closed/i.test(msg)) return "Вкладка или браузер были закрыты.";
  if (/Timeout \d+ms exceeded|timeout/i.test(first)) return `Время ожидания истекло: ${cut(first, 200)}`;
  if (/net::ERR_NAME_NOT_RESOLVED/.test(msg)) return "Сайт не найден (ошибка DNS). Проверьте адрес.";
  if (/net::ERR_TUNNEL_CONNECTION_FAILED|net::ERR_PROXY|407/.test(msg)) return "Прокси хаба не пропустил соединение (сайт закрыт для браузера или прокси недоступен).";
  if (/net::ERR_/.test(msg)) return `Не удалось открыть страницу: ${cut(first, 200)}`;
  return `Ошибка: ${cut(first, 300)}`;
}
