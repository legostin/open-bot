import type { ComponentType } from "react";
import { Bell, Bot, Brain, Laptop, ListChecks, MessagesSquare, Puzzle, Server, Settings, Sparkles, type LucideProps } from "lucide-react";
import { t, type MessageKey } from "../i18n";

export interface NavItem {
  path: string;
  /** Catalog key of the label (translated while rendering). */
  label: MessageKey;
  icon: ComponentType<LucideProps>;
  match?: (p: string) => boolean;
}

export const NAV: NavItem[] = [
  { path: "/", label: "nav.chat", icon: MessagesSquare, match: (p) => p === "/" || p.startsWith("/chat") },
  { path: "/tasks", label: "nav.tasks", icon: ListChecks },
  { path: "/notifications", label: "nav.notifications", icon: Bell },
  { path: "/agents", label: "nav.agents", icon: Bot },
  { path: "/brains", label: "nav.brains", icon: Brain },
  { path: "/plugins", label: "nav.plugins", icon: Puzzle, match: (p) => p === "/plugins" },
  { path: "/machines", label: "nav.machines", icon: Laptop },
  { path: "/mcp-servers", label: "nav.mcp", icon: Server },
  { path: "/skills", label: "nav.skills", icon: Sparkles },
  { path: "/settings", label: "nav.settings", icon: Settings },
];

/** Shown in the phone bottom bar (plus "More"). */
export const BOTTOM_NAV = ["/", "/tasks", "/notifications", "/agents"];

export function isActive(item: { path: string; match?: (p: string) => boolean }, loc: string): boolean {
  return item.match ? item.match(loc) : loc === item.path || loc.startsWith(item.path + "/");
}

export function titleFor(loc: string, pluginRoutes: Array<{ path: string; title: string }>): string {
  const pr = pluginRoutes.find((r) => r.path === loc || (r.path.endsWith("/*") && (loc === r.path.slice(0, -2) || loc.startsWith(r.path.slice(0, -1)))));
  if (pr) return pr.title;
  const item = NAV.find((n) => isActive(n, loc));
  return item ? t(item.label) : "open-bot";
}
