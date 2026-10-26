// Ctrl/Cmd+K command palette: navigation, quick actions and plugin commands.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { CornerDownLeft, Search } from "lucide-react";
import { createStore, useStore } from "../lib/store";
import { createChat, logout, session } from "../state/app";
import { toast } from "../state/toast";
import { usePluginRegistry } from "../plugins/slots";
import { Icon } from "./icon";
import { cx } from "./ui";
import { NAV } from "./nav";

const open = createStore(false);
export const openPalette = () => open.set(true);

interface Item {
  id: string;
  title: string;
  group: string;
  icon?: string;
  run: () => void | Promise<void>;
}

export function filterItems<T extends { title: string; group: string }>(items: T[], q: string): T[] {
  const query = q.trim().toLowerCase();
  if (!query) return items;
  const words = query.split(/\s+/);
  return items
    .map((it) => {
      const hay = `${it.title} ${it.group}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      return { it, score: it.title.toLowerCase().startsWith(query) ? 0 : 1 };
    })
    .filter((x): x is { it: T; score: number } => !!x)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.it);
}

export function CommandPalette() {
  const isOpen = useStore(open);
  const [, navigate] = useLocation();
  const { routes, commands } = usePluginRegistry();
  const s = useStore(session);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open.set(!open.get());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [isOpen]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [
      { id: "new-chat", title: "Новый чат", group: "Действия", icon: "plus", run: async () => navigate(`/chat/${(await createChat()).id}`) },
      { id: "new-task", title: "Новая задача", group: "Действия", icon: "list-todo", run: () => navigate("/tasks?new=1") },
    ];
    for (const n of NAV) out.push({ id: `nav:${n.path}`, title: n.label, group: "Перейти", run: () => navigate(n.path), icon: undefined });
    for (const r of routes) if (!r.path.includes(":")) out.push({ id: `route:${r.key}`, title: r.title, group: "Плагины", icon: r.icon, run: () => navigate(r.path.replace(/\/\*$/, "")) });
    for (const c of commands) out.push({ id: `cmd:${c.key}`, title: c.title, group: `Команда · ${c.pluginId}`, icon: "zap", run: c.run });
    if (s) {
      out.push({ id: "console", title: "Пульт безопасности", group: "Перейти", icon: "shield-check", run: () => void window.open(s.consoleUrl, "_blank", "noopener") });
      out.push({ id: "approvals", title: "Подтверждения", group: "Перейти", icon: "shield", run: () => void window.open(`${s.consoleUrl}/#/approvals`, "_blank", "noopener") });
    }
    out.push({ id: "logout", title: "Выйти", group: "Действия", icon: "power", run: () => logout() });
    return out;
  }, [routes, commands, s, navigate]);

  const filtered = useMemo(() => filterItems(items, q), [items, q]);

  useEffect(() => {
    list.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!isOpen) return null;

  const run = async (it: Item | undefined) => {
    if (!it) return;
    open.set(false);
    try {
      await it.run();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh]">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => open.set(false)} />
      <div className="animate-in relative w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-card" role="dialog" aria-label="Палитра команд">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") open.set(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                void run(filtered[sel]);
              }
            }}
            placeholder="Куда перейти или что сделать?"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted">Ничего не найдено</div>}
          {filtered.map((it, i) => (
            <button
              key={it.id}
              type="button"
              data-idx={i}
              onMouseMove={() => setSel(i)}
              onClick={() => void run(it)}
              className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm", i === sel ? "bg-accent-soft text-accent-text" : "text-fg")}
            >
              <Icon name={it.icon ?? "compass"} className="size-4 shrink-0 opacity-80" />
              <span className="min-w-0 flex-1 truncate">{it.title}</span>
              <span className="shrink-0 text-xs text-muted">{it.group}</span>
              {i === sel && <CornerDownLeft className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
