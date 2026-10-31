// The agents' browser in the demo: the browser plugin's live view gets its state, frames and teach mode from here, as
// it would from the plugin's backend (plugins/browser/server). The pages are the made-up shop's frames rendered at
// build time (static/frames/<locale>/), and map.json says where their parts are, so the person's pointer finds them.

import type { DemoHub } from "../hub/hub";
import { PAGES, domainOf, pathOf, titleOf } from "../assets/shop/shop.mjs";
import type { AgentId } from "../world";
import type { Clock } from "./clock";

export type ShopPage = (typeof PAGES)[number];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FrameMap {
  width: number;
  height: number;
  pages: Record<string, Record<string, Box>>;
}

const PLUGIN = "browser";

export class BrowserSim {
  private hub: DemoHub;
  private clock: Clock;
  private locale: string;
  private map?: FrameMap;
  private page: ShopPage = "home";
  private frameData = new Map<string, string>();
  private control: "agent" | "user" = "agent";
  private busy: string | null = null;
  private agentId: AgentId | null = null;
  private teach: { id: string; goal: string; scope: "task"; startedAt: number; steps: number; speech: boolean } | null = null;
  private waiters = new Map<string, Array<(v: any) => void>>();
  private off: () => void;

  constructor(hub: DemoHub, clock: Clock, locale: string) {
    this.hub = hub;
    this.clock = clock;
    this.locale = locale;
    this.off = hub.onPluginMessage((pluginId, payload) => {
      if (pluginId === PLUGIN) void this.received(payload ?? {});
    });
  }

  dispose(): void {
    this.off();
  }

  private url(page: ShopPage = this.page): string {
    return `https://${domainOf(this.locale)}${pathOf(page)}`;
  }

  private state() {
    const title = titleOf(this.locale, this.page);
    return {
      running: true,
      headless: false,
      control: this.control,
      busy: this.busy,
      tabs: [{ index: 0, title, url: this.url(), active: true }],
      url: this.url(),
      title,
      loading: false,
      canGoBack: this.page !== "home",
      canGoForward: false,
      searchEngine: "duckduckgo",
      teach: this.teach,
    };
  }

  private activity() {
    return { running: true, busy: this.busy, agentId: this.agentId, url: this.url(), control: this.control, attention: false, teach: !!this.teach };
  }

  private push(): void {
    this.hub.pluginEvent(PLUGIN, "state", this.state());
    this.hub.pluginEvent(PLUGIN, "activity", this.activity());
  }

  private async frameOf(page: ShopPage): Promise<string> {
    const cached = this.frameData.get(page);
    if (cached) return cached;
    const blob = await (await fetch(new URL(`frames/${this.locale}/${page}.jpg`, document.baseURI))).blob();
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    this.frameData.set(page, data);
    return data;
  }

  async load(): Promise<void> {
    this.map = await (await fetch(new URL(`frames/${this.locale}/map.json`, document.baseURI))).json();
    await Promise.all(PAGES.map((p) => this.frameOf(p as ShopPage)));
  }

  /** The browser shows `page` (a navigation or a click that changed it). */
  async show(page: ShopPage): Promise<void> {
    this.page = page;
    this.hub.pluginEvent(PLUGIN, "frame", { data: await this.frameOf(page), width: 1280, height: 800 });
    this.push();
  }

  /** An agent drives the browser (its window opens on its own); `null` when it stops. */
  drive(agentId: AgentId | null, busy: string | null): void {
    this.agentId = agentId ?? this.agentId;
    this.busy = busy;
    this.control = "agent";
    this.push();
  }

  startTeach(agentId: AgentId, goal: string): void {
    this.agentId = agentId;
    this.control = "user";
    this.busy = null;
    this.teach = { id: `teach_${Date.now().toString(36)}`, goal, scope: "task", startedAt: Date.now(), steps: 0, speech: true };
    this.push();
  }

  /** A step of the demonstration was written down. */
  step(): void {
    if (!this.teach) return;
    this.teach = { ...this.teach, steps: this.teach.steps + 1 };
    this.push();
  }

  endTeach(): void {
    this.teach = null;
    this.control = "agent";
    this.push();
  }

  /** What the live view sent last of this kind (Done, a Highlight frame). */
  next<T = any>(kind: string): Promise<T> {
    return this.clock.until(
      new Promise<T>((resolve) => {
        const list = this.waiters.get(kind) ?? [];
        list.push(resolve);
        this.waiters.set(kind, list);
      }),
    );
  }

  private resolve(kind: string, v: unknown): void {
    const list = this.waiters.get(kind) ?? [];
    this.waiters.delete(kind);
    for (const r of list) r(v);
  }

  private async received(m: Record<string, any>): Promise<void> {
    if (m.type === "watch" && m.on && m.refresh !== false) {
      this.push();
      this.hub.pluginEvent(PLUGIN, "frame", { data: await this.frameOf(this.page), width: 1280, height: 800 });
    } else if (m.type === "activity") this.hub.pluginEvent(PLUGIN, "activity", this.activity());
    else if (m.type === "control") {
      if (this.teach) return;
      this.control = m.on ? "user" : "agent";
      this.hub.pluginEvent(PLUGIN, "control", { user: !!m.on });
      this.push();
    } else if (m.type === "teach") this.resolve(`teach:${m.action}`, m);
    else if (m.type === "highlight") {
      this.hub.pluginEvent(PLUGIN, "highlight", { ok: true, text: "" });
      this.step();
      this.resolve("highlight", m);
    }
  }

  /** Where a part of the current page is on screen (the live view's picture), for the person's pointer. */
  where(part: string): { x: number; y: number; box: DOMRect } | undefined {
    const box = this.map?.pages[this.page]?.[part];
    const img = this.picture();
    if (!box || !img) return undefined;
    const r = img.getBoundingClientRect();
    return { x: r.left + (box.x + box.w / 2) * r.width, y: r.top + (box.y + box.h / 2) * r.height, box: new DOMRect(r.left + box.x * r.width, r.top + box.y * r.height, box.w * r.width, box.h * r.height) };
  }

  picture(): HTMLImageElement | null {
    const all = [...document.querySelectorAll<HTMLImageElement>('img[src^="data:image/jpeg"]')].filter((i) => i.getBoundingClientRect().width > 0);
    return all.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] ?? null;
  }
}
