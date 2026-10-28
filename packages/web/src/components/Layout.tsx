// App shell, kept minimal: the team on the left (each agent with its dialog, then group chats, then the machines and what
// runs there; a drawer on phones), the current view, and the settings panel beside it. Views put their own slim top bar
// (TopBar) with the shared header actions.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ListChecks, Menu, PanelRight, Settings, X } from "lucide-react";
import { useStore } from "../lib/store";
import { ACTIVE_STATUSES } from "../lib/format";
import { agentForPath, chatForPath } from "../lib/team";
import { feedForPath } from "../lib/feeds";
import { ensureTasks, session, tasks } from "../state/app";
import { openPanel, panel, togglePanel } from "../state/panel";
import { PluginSidebarItems, PluginStatusItems, RightPane, SidebarPanels, useSlot } from "../plugins/slots";
import { cx, IconButton } from "./ui";
import { ApprovalsBadge, ConnectionBadge, VaultBadge } from "./StatusBadges";
import { CommandPalette } from "./CommandPalette";
import { SettingsPanel } from "./SettingsPanel";
import { MachinesBlock } from "./MachinesBlock";
import { TeamList } from "../pages/chat/TeamList";
import { t } from "../i18n";

interface Shell {
  openDrawer: () => void;
  pane: boolean;
  togglePane: () => void;
}
const ShellContext = createContext<Shell>({ openDrawer: () => {}, pane: false, togglePane: () => {} });

function Brand() {
  const s = useStore(session);
  return (
    <Link href="/" className="flex items-center gap-2.5 px-4 py-3.5">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="text-[15px] font-semibold tracking-tight">Owlbot</span>
      {s?.version && <span className="text-[11px] text-muted">{s.version}</span>}
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [loc] = useLocation();
  const s = useStore(session);
  const p = useStore(panel);
  const taskList = useStore(tasks);
  useEffect(() => ensureTasks(), []);
  const activeTasks = (taskList ?? []).filter((x) => ACTIVE_STATUSES.includes(x.status)).length;
  const tasksOpen = p.open && p.section === "tasks";
  const item = (on: boolean) =>
    cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition", on ? "bg-accent-soft text-accent-text" : "text-muted hover:bg-surface-2 hover:text-fg");
  return (
    <>
      <div className="min-h-0 flex-1">
        <TeamList activeAgentId={agentForPath(loc, s?.defaultAgent)} activeConversationId={chatForPath(loc)} activeFeedId={feedForPath(loc)} onNavigate={onNavigate} />
      </div>
      <MachinesBlock onNavigate={onNavigate} />
      <div className="flex flex-col gap-2 px-3 empty:hidden">
        <PluginSidebarItems />
        <SidebarPanels />
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border p-2">
        <button
          type="button"
          onClick={() => {
            if (tasksOpen) togglePanel();
            else openPanel("tasks");
            onNavigate?.();
          }}
          aria-pressed={tasksOpen}
          className={item(tasksOpen)}
        >
          <ListChecks className="size-[18px]" />
          <span className="min-w-0 flex-1 truncate">{t("nav.tasks")}</span>
          {activeTasks > 0 && (
            <span className="rounded-full bg-info-soft px-1.5 text-[11px] font-semibold text-info" title={t("team.activeTasks", { n: activeTasks })}>
              {activeTasks}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            if (p.open && !tasksOpen) togglePanel();
            else openPanel("home");
            onNavigate?.();
          }}
          aria-pressed={p.open && !tasksOpen}
          className={item(p.open && !tasksOpen)}
        >
          <Settings className="size-[18px]" />
          {t("nav.settings")}
        </button>
      </div>
    </>
  );
}

/** Status badges, plugin status items, the plugin side pane toggle and the settings button. Plugin status items show
 * only when the bar itself is wide enough (a container query: the settings panel may sit next to the chat). */
export function HeaderActions() {
  const shell = useContext(ShellContext);
  const panes = useSlot("pane.right");
  const p = useStore(panel);
  return (
    <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
      <div className="hidden items-center gap-2 @3xl/top:flex">
        <PluginStatusItems />
      </div>
      <ConnectionBadge />
      <VaultBadge />
      <ApprovalsBadge />
      {panes.length > 0 && (
        <IconButton label={t("layout.sidePanel")} onClick={shell.togglePane} active={shell.pane}>
          <PanelRight className="size-[18px]" />
        </IconButton>
      )}
      <IconButton label={t("nav.settings")} onClick={() => (p.open && p.section === "home" ? togglePanel() : openPanel("home"))} active={p.open}>
        <Settings className="size-[18px]" />
      </IconButton>
    </div>
  );
}

/** The slim bar at the top of a view: menu (phones), the view's own content, header actions. */
export function TopBar({ children }: { children?: ReactNode }) {
  const shell = useContext(ShellContext);
  return (
    <header className="@container/top relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/70 px-2 backdrop-blur sm:px-3">
      <IconButton label={t("layout.menu")} onClick={shell.openDrawer} className="md:hidden">
        <Menu className="size-5" />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <HeaderActions />
    </header>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [pane, setPane] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ob.pane") === "1";
    } catch {
      return false;
    }
  });
  const panes = useSlot("pane.right");
  useEffect(() => {
    try {
      localStorage.setItem("ob.pane", pane ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [pane]);
  useEffect(() => setDrawer(false), [loc]);

  return (
    <ShellContext.Provider value={{ openDrawer: () => setDrawer(true), pane, togglePane: () => setPane((v) => !v) }}>
      <div className="flex h-dvh overflow-hidden bg-bg">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface/60 md:flex">
          <Brand />
          <Sidebar />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <aside className="animate-in absolute inset-y-0 left-0 flex w-[84%] max-w-80 flex-col border-r border-border bg-surface shadow-card">
              <div className="flex items-center justify-between pr-2">
                <Brand />
                <IconButton label={t("layout.closeMenu")} onClick={() => setDrawer(false)}>
                  <X className="size-5" />
                </IconButton>
              </div>
              <Sidebar onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        <SettingsPanel />
        <RightPane open={pane && panes.length > 0} onClose={() => setPane(false)} />
        <CommandPalette />
      </div>
    </ShellContext.Provider>
  );
}
