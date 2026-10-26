import type { ComponentType } from "react";
import { Bell, Bot, Brain, Laptop, ListChecks, MessagesSquare, Puzzle, Server, Settings, Sparkles, type LucideProps } from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  icon: ComponentType<LucideProps>;
  match?: (p: string) => boolean;
}

export const NAV: NavItem[] = [
  { path: "/", label: "Чат", icon: MessagesSquare, match: (p) => p === "/" || p.startsWith("/chat") },
  { path: "/tasks", label: "Задачи", icon: ListChecks },
  { path: "/notifications", label: "Уведомления", icon: Bell },
  { path: "/agents", label: "Агенты", icon: Bot },
  { path: "/brains", label: "Мозги", icon: Brain },
  { path: "/plugins", label: "Плагины", icon: Puzzle, match: (p) => p === "/plugins" },
  { path: "/machines", label: "Машины", icon: Laptop },
  { path: "/mcp-servers", label: "MCP-серверы", icon: Server },
  { path: "/skills", label: "Скиллы и команды", icon: Sparkles },
  { path: "/settings", label: "Настройки", icon: Settings },
];

/** Shown in the phone bottom bar (plus "Ещё"). */
export const BOTTOM_NAV = ["/", "/tasks", "/notifications", "/agents"];

export function isActive(item: { path: string; match?: (p: string) => boolean }, loc: string): boolean {
  return item.match ? item.match(loc) : loc === item.path || loc.startsWith(item.path + "/");
}

export function titleFor(loc: string, pluginRoutes: Array<{ path: string; title: string }>): string {
  const pr = pluginRoutes.find((r) => r.path === loc || (r.path.endsWith("/*") && (loc === r.path.slice(0, -2) || loc.startsWith(r.path.slice(0, -1)))));
  if (pr) return pr.title;
  return NAV.find((n) => isActive(n, loc))?.label ?? "open-bot";
}
