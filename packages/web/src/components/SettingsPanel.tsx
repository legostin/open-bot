// The settings panel: every section that is not the conversation, opened beside the chat (docked on wide screens,
// full-screen on phones). The home view lists the sections; a section renders its page in compact form.

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, LogOut, MessageCircleMore, ShieldCheck, X } from "lucide-react";
import { useStore } from "../lib/store";
import { logout, session } from "../state/app";
import { closePanel, openPanel, panel } from "../state/panel";
import { usePluginRegistry } from "../plugins/slots";
import { PluginBoundary } from "../plugins/boundary";
import { t } from "../i18n";
import { Icon } from "./icon";
import { EmbeddedPage, IconButton } from "./ui";
import { GROUPS, SECTIONS, sectionDef, type PanelSection } from "./nav";
import { AgentsPage } from "../pages/Agents";
import { BrainsPage } from "../pages/Brains";
import { PluginsPage } from "../pages/Plugins";
import { MachinesPage } from "../pages/Machines";
import { DevicesPage } from "../pages/Devices";
import { McpPage } from "../pages/Mcp";
import { NotificationsPage } from "../pages/Notifications";
import { SkillsPage } from "../pages/Skills";
import { SettingsPage } from "../pages/Settings";
import { TasksPage } from "../pages/Tasks";

function SectionBody({ section }: { section: PanelSection }) {
  const { routes } = usePluginRegistry();
  switch (section) {
    case "agents":
      return <AgentsPage />;
    case "brains":
      return <BrainsPage />;
    case "plugins":
      return <PluginsPage />;
    case "machines":
      return <MachinesPage />;
    case "devices":
      return <DevicesPage />;
    case "mcp":
      return <McpPage />;
    case "notifications":
      return <NotificationsPage />;
    case "skills":
      return <SkillsPage />;
    case "settings":
      return <SettingsPage />;
    case "tasks":
      return <TasksPage />;
  }
  const route = routes.find((r) => `plugin:${r.key}` === section);
  if (!route) return null;
  const C = route.component;
  return (
    <PluginBoundary key={route.key} pluginId={route.pluginId}>
      <C pluginId={route.pluginId} />
    </PluginBoundary>
  );
}

function Row({ icon, label, hint, onClick, href }: { icon: ReactNode; label: string; hint?: string; onClick?: () => void; href?: string }) {
  const inner = (
    <>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          {hint && <span className="block truncate text-xs text-muted">{hint}</span>}
        </span>
        {href ? <ExternalLink className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
    </>
  );
  const cls = "flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-2";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <div className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</div>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">{children}</div>
    </section>
  );
}

function Home() {
  const s = useStore(session);
  const { routes } = usePluginRegistry();
  const pluginPages = routes.filter((r) => r.nav && !r.path.includes(":"));
  return (
    <div className="flex flex-col gap-5 px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3 rounded-2xl bg-accent-soft/60 px-3.5 py-3 text-sm">
        <MessageCircleMore className="mt-0.5 size-4 shrink-0 text-accent-text" />
        <span>{t("panel.askHint")}</span>
      </div>
      {GROUPS.map((g) => {
        const items = SECTIONS.filter((x) => x.group === g.id);
        const extra = g.id === "assistant" ? pluginPages : [];
        return (
          <Group key={g.id} label={t(g.label)}>
            {items.map((x) => (
              <Row key={x.id} icon={<x.icon className="size-4" />} label={t(x.label)} hint={t(x.hint)} onClick={() => openPanel(x.id)} />
            ))}
            {extra.map((r) => (
              <Row key={r.key} icon={<Icon name={r.icon} className="size-4" />} label={r.title} hint={t("panel.hint.plugin", { plugin: r.pluginId })} onClick={() => openPanel(`plugin:${r.key}`)} />
            ))}
            {g.id === "general" && s && (
              <>
                <Row icon={<ShieldCheck className="size-4" />} label={t("common.securityConsole")} hint={t("panel.hint.console")} href={s.consoleUrl} />
                <button type="button" onClick={() => void logout()} className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-danger transition hover:bg-surface-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger-soft">
                    <LogOut className="size-4" />
                  </span>
                  {t("common.logout")}
                </button>
              </>
            )}
          </Group>
        );
      })}
    </div>
  );
}

export function SettingsPanel() {
  const p = useStore(panel);
  const { routes } = usePluginRegistry();
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog][aria-modal=true]")) closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.open]);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [p.section]);

  if (!p.open) return null;
  const home = p.section === "home";
  const def = p.section === "home" ? undefined : sectionDef(p.section);
  const route = !home && !def ? routes.find((r) => `plugin:${r.key}` === p.section) : undefined;
  const title = home ? t("nav.settings") : def ? t(def.label) : (route?.title ?? t("nav.settings"));

  // A link inside a section that leads to a conversation or task closes the panel while it covers the chat: a full
  // screen on phones, a sheet over the chat on mid-size windows. Next to the chat only from 1280px, where both fit.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[href^='/']");
    if (a && window.matchMedia("(max-width: 1279px)").matches) closePanel();
  };

  return (
    <>
      <div className="animate-fade fixed inset-0 z-30 hidden bg-black/25 md:block xl:hidden" onClick={closePanel} aria-hidden />
      <aside
        aria-label={t("nav.settings")}
        className="animate-in fixed inset-0 z-40 flex flex-col bg-bg md:left-auto md:w-[560px] md:max-w-[calc(100vw-4rem)] md:border-l md:border-border md:shadow-card xl:static xl:z-auto xl:max-w-none xl:shrink-0 xl:shadow-none 2xl:w-[640px]"
        onClick={onClick}
      >
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-surface/70 px-2 backdrop-blur">
          {!home && (
            <IconButton label={t("common.back")} onClick={() => openPanel("home")}>
              <ArrowLeft className="size-[18px]" />
            </IconButton>
          )}
          <h2 className={home ? "min-w-0 flex-1 truncate pl-2 text-[15px] font-semibold" : "min-w-0 flex-1 truncate text-[15px] font-semibold"}>{title}</h2>
          <IconButton label={t("layout.closePanel")} onClick={closePanel}>
            <X className="size-[18px]" />
          </IconButton>
        </div>
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
          <EmbeddedPage.Provider value={true}>{home ? <Home /> : <SectionBody section={p.section as PanelSection} />}</EmbeddedPage.Provider>
        </div>
      </aside>
    </>
  );
}
