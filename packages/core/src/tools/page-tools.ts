// The tools agents make pages with (pages.ts): any agent makes one when an answer deserves more than a message,
// changes it, reads it back with what broke in the user's browser, and shows it in the chat again.
import type { MessagePart, PageView, ToolDescriptor, ToolResult } from "@owlbot/shared";
import type { ToolRegistry } from "./registry.ts";
import type { AgentRegistry } from "../agents.ts";
import { agentName } from "../agents.ts";
import { hubLocale } from "../i18n.ts";
import { PageError, PAGE_API_HOSTS, type Pages } from "../pages.ts";

export interface PageToolDeps {
  registry: ToolRegistry;
  pages: Pages;
  agents: AgentRegistry;
  /** Add a card to the reply the agent is writing (SessionRunner.attachPart). */
  attachPart: (conversationId: string, part: MessagePart) => void;
}

const MAX_READ_DATA = 20_000;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const UI =
  "accordion, alert, aspect-ratio, avatar, badge, button, card, carousel, checkbox, collapsible, dialog, input, label, popover, progress, " +
  "radio-group, scroll-area, select, separator, sheet, skeleton, slider, switch, table, tabs, textarea, toggle, toggle-group, tooltip";

const GUIDE =
  "Write the page as one React component in TSX with a default export: `export default function Page({ data }) { … }`. " +
  `Style it with Tailwind v4 classes and shadcn/ui components, imported as in shadcn ("@/components/ui/card" etc.: ${UI}); ` +
  'icons from "lucide-react"; hooks from "react"; `cn` from "@/lib/utils". Owlbot\'s blocks and helpers come from "@owlbot/page": ' +
  "<Map places={[{ lat, lon, label, note }]} route=\"walk\"|\"drive\"|\"bike\" (along real roads, with km and time) numbered selected onSelect height />, " +
  "<Weather lat lon days title /> (live forecast), <Gallery images={[url or { src, caption }]} />, <Video src /> (YouTube, Vimeo or a file), " +
  "<Hero title subtitle eyebrow image />, <Place name index image description why address hours price rating tags lat lon url /> (a card with " +
  "Route, Website and Ask buttons), <Stat label value hint icon />; useData() (the page's data), useStored(key, initial) (like useState, " +
  "saved with the page: ticks on a checklist, a choice), useJson(url) / getJson(url) (JSON from " +
  `${PAGE_API_HOSTS.join(", ")}), ask(text) (sends those words to you in the chat as the user's message) and openLink(url). ` +
  "Nothing else can be imported and the page cannot reach other sites: put what you found into `data`. Any http(s) picture works in <img> " +
  "(the hub fetches it) and links open outside the page. Make it beautiful and alive, not a wall of text: a Hero with a real photo, cards, " +
  "a clear hierarchy, generous spacing, interactive where it helps (tabs, a map that follows the chosen place, a checklist); mobile first, " +
  'e.g. `<main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">`. It shows light or dark like the app: use the theme colours ' +
  "(bg-background, bg-card, bg-muted, text-muted-foreground, border) rather than fixed greys.";

export function registerPageTools(d: PageToolDeps): void {
  const reg = (spec: Omit<ToolDescriptor, "owner">, fn: (input: any, ctx: any) => Promise<ToolResult> | ToolResult) =>
    d.registry.register({ ...spec, owner: "core" }, async (input, ctx) => {
      try {
        return await fn(input ?? {}, ctx);
      } catch (e) {
        if (e instanceof PageError) return text(e.message, true);
        throw e;
      }
    });
  const name = (id: string) => {
    const a = d.agents.get(id);
    return a ? agentName(a, hubLocale()) : id;
  };
  const which = (key: unknown): PageView | string =>
    typeof key === "string" && key.trim() ? (d.pages.find(key) ?? `No page "${key}". See page_list.`) : "Say which page (page: its id or title). See page_list.";
  const describe = (p: PageView) =>
    `- ${p.id} “${p.title}” by ${name(p.agentId)}, version ${p.version}, changed ${p.updatedAt}${p.summary ? `: ${p.summary}` : ""}${p.lastError ? " [has an error: page_read]" : ""}`;

  reg(
    {
      name: "page_create",
      description:
        "Make a page: a beautiful interactive web page the user opens from its card in the chat (full screen, on the phone too). Use it when an " +
        "answer deserves more than a message: a walk or trip with its places, a guide, a comparison, a plan, a report, a dashboard. The card shows " +
        `in your reply. ${GUIDE}`,
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "The page's title (≤ 120 chars)" },
          summary: { type: "string", description: "One or two lines for its card in the chat (≤ 300 chars)" },
          cover: { type: "string", description: "The card's picture: an http(s) image URL" },
          code: {
            type: "string",
            description:
              'The page: TSX, e.g. import { Hero, Map, Place, useData } from "@owlbot/page"; export default function Page() { const { stops } = useData(); ' +
              'return <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8"><Hero title="…" image={stops[0].image} /><Map places={stops} route="walk" />' +
              "{stops.map((s, i) => <Place key={i} index={i + 1} {...s} />)}</main>; }",
          },
          data: { description: "JSON the page shows (useData() and the component's `data` prop): keep facts here so page_update can change them alone" },
          show: { type: "boolean", description: "Show its card in your reply (default true)" },
        },
        required: ["title", "code"],
      },
    },
    (i, ctx) => {
      const p = d.pages.create(i, { agentId: ctx.agentId, conversationId: ctx.conversationId });
      if (i.show !== false) d.attachPart(ctx.conversationId, { type: "page", pageId: p.id });
      return text(
        `Made the page ${p.id} “${p.title}”${i.show !== false ? "; its card is in your reply" : ""}. It compiled; it runs in the user's browser, and if it breaks ` +
          "there, page_read shows the error. Change it with page_update.",
      );
    },
  );

  reg(
    {
      name: "page_update",
      description: "Change a page: its code, its data, title, summary or cover. Open copies reload at once. Give only what changes.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "string", description: "The page's id or title" },
          code: { type: "string", description: "The whole new TSX (see page_create)" },
          data: { description: "The whole new data" },
          title: { type: "string" },
          summary: { type: "string" },
          cover: { type: "string" },
          show: { type: "boolean", description: "Show its card in your reply again (default false)" },
        },
        required: ["page"],
      },
    },
    (i, ctx) => {
      const p = which(i.page);
      if (typeof p === "string") return text(p, true);
      const u = d.pages.update(p.id, i);
      if (i.show === true) d.attachPart(ctx.conversationId, { type: "page", pageId: u.id });
      return text(`Updated the page ${u.id} “${u.title}” (version ${u.version}); open copies reload.`);
    },
  );

  reg(
    {
      name: "page_read",
      description: "A page's code, data and saved state, and the error it hit in the user's browser if it broke.",
      effect: "read",
      inputSchema: { type: "object", properties: { page: { type: "string", description: "The page's id or title" } }, required: ["page"] },
    },
    (i) => {
      const p = which(i.page);
      if (typeof p === "string") return text(p, true);
      const src = d.pages.source(p.id);
      const data = JSON.stringify(src?.data ?? {}, null, 1);
      const state = JSON.stringify(d.pages.state(p.id));
      return text(
        [
          describe(p),
          p.lastError ? `Error in the browser:\n${p.lastError}` : "No error reported.",
          `Saved state: ${state}`,
          `Data:\n${data.length > MAX_READ_DATA ? `${data.slice(0, MAX_READ_DATA)}\n… (${data.length} chars)` : data}`,
          `Code:\n${src?.code ?? ""}`,
        ].join("\n\n"),
      );
    },
  );

  reg(
    {
      name: "page_list",
      description: "Pages the team made for the user, newest first.",
      effect: "read",
      inputSchema: { type: "object", properties: { mine: { type: "boolean", description: "Only yours" } } },
    },
    (i, ctx) => {
      const list = d.pages.list(i.mine ? ctx.agentId : undefined);
      return text(list.length ? list.map(describe).join("\n") : "No pages yet. Make one with page_create.");
    },
  );

  reg(
    {
      name: "page_show",
      description: "Show a page's card in your reply again, e.g. when the user asks for it.",
      effect: "read",
      inputSchema: { type: "object", properties: { page: { type: "string", description: "The page's id or title" } }, required: ["page"] },
    },
    (i, ctx) => {
      const p = which(i.page);
      if (typeof p === "string") return text(p, true);
      d.attachPart(ctx.conversationId, { type: "page", pageId: p.id });
      return text(`The user sees the card of “${p.title}” in your reply.`);
    },
  );
}
