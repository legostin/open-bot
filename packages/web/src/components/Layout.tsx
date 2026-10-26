// App shell: sidebar navigation (desktop), drawer + bottom bar (phone), header with status badges,
// plugin status items, command palette and the right plugin pane.

import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Ellipsis, LogOut, Menu, PanelRight, Search, ShieldCheck, X } from "lucide-react";
import { useStore } from "../lib/store";
import { logout, session } from "../state/app";
import { PluginSidebarItems, PluginStatusItems, RightPane, SidebarPanels, usePluginRegistry, useSlot } from "../plugins/slots";
import { Icon } from "./icon";
import { cx, IconButton } from "./ui";
import { ApprovalsBadge, ConnectionBadge, VaultBadge } from "./StatusBadges";
import { CommandPalette, openPalette } from "./CommandPalette";
import { BOTTOM_NAV, isActive, NAV, titleFor } from "./nav";
import { t } from "../i18n";

function NavLink({ to, icon, label, active, onClick }: { to: string; icon: ReactNode; label: string; active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={to}
      onClick={onClick}
      className={cx(
        "flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
        active ? "bg-accent-soft text-accent-text" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const [loc] = useLocation();
  const { routes } = usePluginRegistry();
  const s = useStore(session);
  const navRoutes = routes.filter((r) => r.nav && !r.path.includes(":"));
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
      <div className="flex flex-col gap-0.5">
        {NAV.map((n) => (
          <NavLink key={n.path} to={n.path} icon={<n.icon className="size-[18px]" />} label={t(n.label)} active={isActive(n, loc)} onClick={onNavigate} />
        ))}
      </div>
      {navRoutes.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{t("nav.fromPlugins")}</div>
          {navRoutes.map((r) => (
            <NavLink
              key={r.key}
              to={r.path.replace(/\/\*$/, "")}
              icon={<Icon name={r.icon} className="size-[18px]" />}
              label={r.title}
              active={loc === r.path || loc === r.path.replace(/\/\*$/, "")}
              onClick={onNavigate}
            />
          ))}
        </div>
      )}
      <PluginSidebarItems />
      <SidebarPanels />
      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        {s && (
          <a
            href={s.consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <ShieldCheck className="size-[18px]" />
            {t("common.securityConsole")}
          </a>
        )}
        <button
          type="button"
          onClick={() => void logout()}
          className="flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          <LogOut className="size-[18px]" />
          {t("common.logout")}
        </button>
      </div>
    </nav>
  );
}

function Brand() {
  const s = useStore(session);
  return (
    <Link href="/" className="flex items-center gap-2.5 px-5 py-4">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="text-[15px] font-semibold tracking-tight">open-bot</span>
      {s?.version && <span className="text-[11px] text-muted">{s.version}</span>}
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { routes } = usePluginRegistry();
  const panes = useSlot("pane.right");
  const [drawer, setDrawer] = useState(false);
  const [pane, setPane] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ob.pane") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("ob.pane", pane ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [pane]);
  useEffect(() => setDrawer(false), [loc]);

  const title = titleFor(loc, routes);

  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface/60 md:flex">
        <Brand />
        <Navigation />
      </aside>

      {/* Phone drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside className="animate-in absolute inset-y-0 left-0 flex w-[82%] max-w-72 flex-col border-r border-border bg-surface shadow-card">
            <div className="flex items-center justify-between pr-2">
              <Brand />
              <IconButton label={t("layout.closeMenu")} onClick={() => setDrawer(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <Navigation onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/70 px-2 backdrop-blur sm:px-4">
          <IconButton label={t("layout.menu")} onClick={() => setDrawer(true)} className="md:hidden">
            <Menu className="size-5" />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h1>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <div className="hidden items-center gap-2 lg:flex">
              <PluginStatusItems />
            </div>
            <ConnectionBadge />
            <VaultBadge />
            <ApprovalsBadge />
            <IconButton label={t("layout.commands")} onClick={openPalette}>
              <Search className="size-[18px]" />
            </IconButton>
            {panes.length > 0 && (
              <IconButton label={t("layout.sidePanel")} onClick={() => setPane((v) => !v)} active={pane}>
                <PanelRight className="size-[18px]" />
              </IconButton>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 pb-16 md:pb-0">{children}</main>
          <RightPane open={pane && panes.length > 0} onClose={() => setPane(false)} />
        </div>
      </div>

      <BottomNav loc={loc} onMore={() => setDrawer(true)} />
      <CommandPalette />
    </div>
  );
}

function BottomNav({ loc, onMore }: { loc: string; onMore: () => void }) {
  const items = NAV.filter((n) => BOTTOM_NAV.includes(n.path));
  const onBottom = items.some((n) => isActive(n, loc));
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur md:hidden" aria-label={t("nav.main")}>
      <div className="grid grid-cols-5">
        {items.map((n) => {
          const active = isActive(n, loc);
          return (
            <Link key={n.path} href={n.path} className={cx("flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium", active ? "text-accent-text" : "text-muted")}>
              <n.icon className="size-5" />
              {t(n.label)}
            </Link>
          );
        })}
        <button type="button" onClick={onMore} className={cx("flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium", !onBottom ? "text-accent-text" : "text-muted")}>
          <Ellipsis className="size-5" />
          {t("nav.more")}
        </button>
      </div>
    </nav>
  );
}
