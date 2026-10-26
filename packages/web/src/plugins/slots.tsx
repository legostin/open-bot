// React renderers for plugin slots.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useStore } from "../lib/store";
import { Icon } from "../components/icon";
import { cx, IconButton } from "../components/ui";
import { PluginBoundary } from "./boundary";
import { inSlot, registry } from "./registry";

export function usePluginRegistry() {
  return useStore(registry);
}

export function useSlot(slot: Parameters<typeof inSlot>[1]) {
  const { contributions } = usePluginRegistry();
  return useMemo(() => inSlot(contributions, slot), [contributions, slot]);
}

/** layout.statusbar + ui.statusbar.add items. */
export function PluginStatusItems() {
  const { statusbar } = usePluginRegistry();
  if (!statusbar.length) return null;
  return (
    <>
      {statusbar.map((s) => {
        const C = s.render;
        return (
          <PluginBoundary key={s.key} pluginId={s.pluginId} silent>
            <span className="inline-flex items-center text-xs">
              <C pluginId={s.pluginId} />
            </span>
          </PluginBoundary>
        );
      })}
    </>
  );
}

/** layout.sidebar: extra items at the bottom of the left navigation. */
export function PluginSidebarItems() {
  const items = useSlot("layout.sidebar");
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((c) => {
        const C = c.component;
        return (
          <PluginBoundary key={c.key} pluginId={c.pluginId}>
            <C pluginId={c.pluginId} />
          </PluginBoundary>
        );
      })}
    </div>
  );
}

/** sidebar.panel: collapsible panels in the left sidebar. */
export function SidebarPanels() {
  const panels = useSlot("sidebar.panel");
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ob.panels") ?? "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("ob.panels", JSON.stringify(closed));
    } catch {
      /* private mode */
    }
  }, [closed]);
  if (!panels.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {panels.map((p) => {
        const C = p.component;
        const id = `${p.pluginId}:${p.id}`;
        const open = !closed[id];
        return (
          <div key={p.key} className="rounded-xl border border-border bg-surface">
            <button
              type="button"
              onClick={() => setClosed((c) => ({ ...c, [id]: open }))}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] font-medium"
              aria-expanded={open}
            >
              <Icon name={p.icon} className="size-4 text-muted" />
              <span className="min-w-0 flex-1 truncate">{p.title ?? p.id}</span>
              {open ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
            </button>
            {open && (
              <div className="border-t border-border p-2.5 text-sm">
                <PluginBoundary pluginId={p.pluginId}>
                  <C pluginId={p.pluginId} />
                </PluginBoundary>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** pane.right: a collapsible pane with tabs (desktop: side column, phone: full-screen sheet). */
export function RightPane({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tabs = useSlot("pane.right");
  const [active, setActive] = useState<string | undefined>();
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  if (!open || !current) return null;
  const C = current.component;
  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-surface lg:static lg:z-auto lg:w-[420px] lg:shrink-0 lg:border-l lg:border-border xl:w-[480px]">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActive(t.key)}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition",
                t.key === current.key ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              <Icon name={t.icon} className="size-4" />
              {t.title ?? t.id}
            </button>
          ))}
        </div>
        <IconButton label="Закрыть панель" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <PluginBoundary key={current.key} pluginId={current.pluginId}>
          <C pluginId={current.pluginId} />
        </PluginBoundary>
      </div>
    </aside>
  );
}

/** chat.composerActions: extra buttons next to the send button. */
export function ComposerActions({ conversationId }: { conversationId: string }) {
  const items = useSlot("chat.composerActions");
  if (!items.length) return null;
  return (
    <>
      {items.map((c) => {
        const C = c.component;
        return (
          <PluginBoundary key={c.key} pluginId={c.pluginId} silent>
            <C pluginId={c.pluginId} conversationId={conversationId} />
          </PluginBoundary>
        );
      })}
    </>
  );
}
