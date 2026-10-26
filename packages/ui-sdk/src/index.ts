// @openbot/ui — the contract between the web UI host and UI plugins.
//
// A UI plugin is an ES module (built by scripts/build-ui-plugins.mjs) whose default export or named export
// `activate(ui: OpenBotUI)` registers contributions. "react", "react/jsx-runtime", "react-dom" and "@openbot/ui"
// are provided by the host through an import map (shared instances); plugins must not bundle them.
//
// At runtime "@openbot/ui" resolves to /shared/openbot-ui.js, which re-exports `window.__OPENBOT_SHARED__.ui`
// (the host's implementation of everything exported below as values).

import type { ComponentType, ReactNode } from "react";
import type { Locale, Message, MessagePart, Params, Task, UiEvent } from "@openbot/shared";

// ---------- slots ----------

export type SlotName =
  | "layout.sidebar" // extra items at the bottom of the left navigation
  | "layout.statusbar" // small items in the status bar
  | "sidebar.panel" // collapsible panels in the left sidebar
  | "pane.right" // right-side pane tabs
  | "live.view" // the floating live view of an agent's screen (prefer ui.liveView.register: it reports activity)
  | "chat.message" // replace rendering of a whole message (match by role / agent)
  | "chat.toolResult" // custom renderer for a tool call + result (match by tool name glob)
  | "chat.composer" // wrap/replace the message composer
  | "chat.composerActions" // extra buttons next to the send button
  | "settings.section" // extra section on the settings page
  | "route"; // full page (prefer ui.routes.add)

export interface SlotProps {
  pluginId: string;
}

export interface ToolResultProps extends SlotProps {
  call: Extract<MessagePart, { type: "tool_call" }>;
  result?: Extract<MessagePart, { type: "tool_result" }>;
  message: Message;
}

export interface MessageProps extends SlotProps {
  message: Message;
  /** Render the default message (for wrappers). */
  Default: ComponentType<{ message: Message }>;
}

export interface ComposerProps extends SlotProps {
  conversationId: string;
  /** Default composer, for wrappers. */
  Default: ComponentType<{ conversationId: string }>;
  send(text: string): Promise<void>;
}

export interface SlotContribution<P = any> {
  id: string;
  title?: string;
  /** Lucide icon name (e.g. "globe", "brain") or an emoji. */
  icon?: string;
  component: ComponentType<P>;
  /** chat.toolResult: tool name globs, e.g. ["browser_*"]. chat.message: {role?, agentId?}. */
  match?: { tool?: string[]; role?: Message["role"]; agentId?: string };
  /** Higher wins for overrides; default 0. */
  priority?: number;
}

// ---------- live view ----------
//
// A floating picture-in-picture window, owned by the host, onto something an agent works in (a browser, a desktop
// app, another machine's screen). A plugin contributes the content and reports activity; the host decides when the
// window shows (it opens on its own while a view is busy, turns into a pill a little after the work stops), where it
// sits, and draws its frame, title bar and the expanded overlay.

/** What a live view is doing now. Report the truth; the host smooths short gaps between bursts of work. */
export interface LiveViewActivity {
  /** An agent is working there right now: the window opens on its own. */
  active: boolean;
  /** The work needs the user (a captcha, a sign-in): the window reopens even if minimized or closed, highlighted. */
  attention?: boolean;
  /** The user drives it right now (takeover): the view counts as busy. */
  userControl?: boolean;
  /** The agent working there: the host shows its name and avatar. */
  agentId?: string;
  /** One line about what is going on, in the interface language ("Opened a page · example.com"). */
  status?: string;
}

export interface LiveViewProps extends SlotProps {
  /**
   * "mini": the compact corner window (view only; the host turns a click into expand).
   * "expanded": the large overlay where the user can interact (e.g. take over).
   * The component stays mounted when the mode changes, and is unmounted while the view is a pill or hidden:
   * start streaming on mount, stop on unmount.
   */
  mode: "mini" | "expanded";
  expand(): void;
  /** Back to the compact window. */
  collapse(): void;
}

export interface LiveViewContribution {
  id: string;
  title: string;
  /** Lucide icon name or an emoji. */
  icon?: string;
  component: ComponentType<LiveViewProps>;
}

export interface LiveViewHandle {
  /** Merge an activity update (call on every change). */
  update(activity: Partial<LiveViewActivity>): void;
  /** Remove the view. */
  dispose(): void;
}

// ---------- host services ----------

export interface HubApi {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  patch<T = any>(path: string, body?: unknown): Promise<T>;
  del<T = any>(path: string): Promise<T>;
}

export interface PluginChannel {
  /** Call this plugin's backend HTTP handler: /api/plugins/<id>/http/<path>. */
  http<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Send a message to this plugin's backend (ctx.ui.onMessage). */
  send(payload: unknown): void;
  /** Subscribe to this plugin's backend events (ctx.ui.emit(channel, payload)). Returns unsubscribe. */
  on(channel: string, cb: (payload: any) => void): () => void;
}

export interface OpenBotUI {
  pluginId: string;
  slots: {
    register<P = any>(slot: SlotName, contribution: SlotContribution<P>): () => void;
    /** Replace a core component (chat.composer, chat.message); highest priority wins. */
    override<P = any>(slot: SlotName, component: ComponentType<P>, opts?: { priority?: number; match?: SlotContribution["match"] }): () => void;
  };
  routes: { add(r: { path: string; title: string; icon?: string; component: ComponentType<SlotProps>; nav?: boolean }): () => void };
  statusbar: { add(item: { id: string; render: ComponentType<SlotProps> }): () => void };
  commands: { register(c: { id: string; title: string; run: () => void | Promise<void> }): () => void };
  settings: { section(s: { id: string; title: string; component: ComponentType<SlotProps> }): () => void };
  /** Live views: a plugin can register several (one per screen) and dispose them at any time. */
  liveView: { register(c: LiveViewContribution): LiveViewHandle };
  toast(text: string, kind?: "info" | "success" | "error"): void;
  /** Navigate inside the SPA. */
  navigate(path: string): void;
  api: HubApi;
  plugin: PluginChannel;
  /** All realtime hub events (messages, tasks, notifications...). Returns unsubscribe. */
  events: { on(cb: (e: UiEvent) => void): () => void };
  /**
   * Interface language and this plugin's translations (.openbot-plugin/locales/<locale>.json, delivered by the hub).
   * The page reloads when the user switches language, so `locale` is fixed for the plugin's lifetime.
   */
  i18n: {
    locale: Locale;
    /** Translate a key from this plugin's messages; falls back to English, then to the key. */
    t(key: string, params?: Params): string;
    /** Dates and numbers in the interface language. */
    formatDate(d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string;
    formatNumber(n: number, opts?: Intl.NumberFormatOptions): string;
  };
}

export type UiPluginModule = { activate(ui: OpenBotUI): void | (() => void) };

// ---------- shared components and hooks (values provided by the host at runtime) ----------

export interface ButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}
export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}
export interface BadgeProps {
  children?: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}
export interface EmptyStateProps {
  title: string;
  hint?: ReactNode;
  icon?: string;
}

declare global {
  interface Window {
    __OPENBOT_SHARED__?: {
      react: unknown;
      reactDom: unknown;
      reactDomClient: unknown;
      jsxRuntime: unknown;
      ui: OpenBotUIRuntime;
    };
  }
}

/** What the "@openbot/ui" module exports at runtime. */
export interface OpenBotUIRuntime {
  definePluginUI(activate: (ui: OpenBotUI) => void | (() => void)): UiPluginModule;
  Button: ComponentType<ButtonProps>;
  Card: ComponentType<CardProps>;
  Badge: ComponentType<BadgeProps>;
  EmptyState: ComponentType<EmptyStateProps>;
  Spinner: ComponentType<{ size?: number }>;
  Markdown: ComponentType<{ text: string }>;
  /** Live list of tasks from the hub. */
  useTasks(): Task[];
  /** Subscribe to hub events inside a component. */
  useHubEvent(cb: (e: UiEvent) => void, deps?: unknown[]): void;
  api: HubApi;
  /** Interface language (same as ui.i18n.locale). */
  locale: Locale;
}

// Value exports: declared here for type-checking only. At runtime the import map points "@openbot/ui"
// to the host shim (/shared/openbot-ui.js), which provides these values. Plugins must mark "@openbot/ui" external.
export declare const definePluginUI: OpenBotUIRuntime["definePluginUI"];
export declare const Button: OpenBotUIRuntime["Button"];
export declare const Card: OpenBotUIRuntime["Card"];
export declare const Badge: OpenBotUIRuntime["Badge"];
export declare const EmptyState: OpenBotUIRuntime["EmptyState"];
export declare const Spinner: OpenBotUIRuntime["Spinner"];
export declare const Markdown: OpenBotUIRuntime["Markdown"];
export declare const useTasks: OpenBotUIRuntime["useTasks"];
export declare const useHubEvent: OpenBotUIRuntime["useHubEvent"];
export declare const api: OpenBotUIRuntime["api"];
export declare const locale: OpenBotUIRuntime["locale"];
export type { Locale, Message, MessagePart, Params, Task, UiEvent };
