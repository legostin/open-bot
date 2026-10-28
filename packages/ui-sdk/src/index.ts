// @owlbot/ui — the contract between the web UI host and UI plugins.
//
// A UI plugin is an ES module (built by scripts/build-ui-plugins.mjs) whose default export or named export
// `activate(ui: OwlbotUI)` registers contributions. "react", "react/jsx-runtime", "react-dom" and "@owlbot/ui"
// are provided by the host through an import map (shared instances); plugins must not bundle them.
//
// At runtime "@owlbot/ui" resolves to /shared/owlbot-ui.js, which re-exports `window.__OWLBOT_SHARED__.ui`
// (the host's implementation of everything exported below as values).

import type { ComponentType, ReactNode } from "react";
import type { Locale, Message, MessagePart, Params, RouteMode, Task, UiEvent } from "@owlbot/shared";

// ---------- slots ----------

export type SlotName =
  | "layout.sidebar" // extra items at the bottom of the left navigation
  | "layout.statusbar" // small items in the status bar
  | "sidebar.panel" // collapsible panels in the left sidebar
  | "pane.right" // right-side pane tabs (e.g. browser live view)
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

// ---------- widgets ----------

/**
 * A plugin's card in the chat (a `widget` part: the plugin's tool called ctx.widgets.show(call, kind, data)).
 * The host draws the card's frame; the component fills it. Use the theme's CSS variables (var(--fg), var(--muted),
 * var(--surface-2), var(--border), var(--accent)…) so it fits light and dark, the web and the phone.
 */
export interface WidgetProps<D = any> extends SlotProps {
  kind: string;
  /** What the tool passed, as it was when shown. */
  data: D;
  /** The agent's message the card is in. */
  message: Message;
}

// ---------- maps ----------

/** A place a map card opens in a maps app. */
export interface MapAppPlace {
  lat: number;
  lon: number;
  label?: string;
  zoom: number;
}

/** A route a map card opens in a maps app: two or more stops in order, and the way of travel. */
export interface MapAppRoute {
  stops: Array<{ lat: number; lon: number; label?: string }>;
  mode: RouteMode;
}

/** A maps app in the "Open in…" menu of map cards (ui.maps.addApp): links for a place and, if it can, a route. */
export interface MapAppContribution {
  id: string;
  /** The app's name in the menu. */
  title: string;
  place(p: MapAppPlace): string;
  /** A link that opens the route planned; without it the menu opens the route's destination. */
  route?(r: MapAppRoute): string | undefined;
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

export interface OwlbotUI {
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
  /** Maps apps for the "Open in…" menu of map cards (after Apple Maps, Google Maps and OpenStreetMap). */
  maps: { addApp(app: MapAppContribution): () => void };
  /** Draw this plugin's chat cards: `kind` as in contributes.widgets and ctx.widgets.show. */
  widgets: { add<D = any>(kind: string, component: ComponentType<WidgetProps<D>>): () => void };
  toast(text: string, kind?: "info" | "success" | "error"): void;
  /** Navigate inside the SPA. */
  navigate(path: string): void;
  api: HubApi;
  plugin: PluginChannel;
  /** All realtime hub events (messages, tasks, notifications...). Returns unsubscribe. */
  events: { on(cb: (e: UiEvent) => void): () => void };
  /**
   * Interface language and this plugin's translations (.owlbot-plugin/locales/<locale>.json, delivered by the hub).
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

export type UiPluginModule = { activate(ui: OwlbotUI): void | (() => void) };

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

// ---------- the iOS app's bridge ----------

/** Haptic feedback the phone can play. */
export type NativeHapticKind = "light" | "success" | "warning";

/** What the app tells the page (a `owlbot-native` CustomEvent on window): live words while the mic is held. */
/** What the app tells the page: live dictation words, the "Show steps" switch in its header, the hub answering again. */
export type NativeEvent = { type: "dictation"; text: string } | { type: "details"; on: boolean } | { type: "online" };

/**
 * The Owlbot iOS app around the page (its chat screen is the web UI's chat in a WKWebView). Every call is
 * `window.webkit.messageHandlers.owlbot.postMessage({ type, ... })`; a failed call rejects with an Error whose
 * message is the app's reason.
 */
export interface NativeBridge {
  /** Any bridge message: resolves with the app's reply object. */
  call<T = Record<string, unknown>>(type: string, payload?: Record<string, unknown>): Promise<T>;
  /** The page has rendered the conversation (the app hides its spinner). */
  ready(conversationId: string): Promise<{ ok: boolean }>;
  /** The app loads the approval from the hub, asks for Face ID and signs it; `cancelled` when the user backed out. */
  approve(approvalId: string): Promise<{ ok: boolean; cancelled?: boolean }>;
  deny(approvalId: string): Promise<{ ok: boolean }>;
  /** Hold-to-talk: `start` rejects with the reason when the mic or speech recognition is not allowed. */
  dictation: { start(): Promise<{ ok: boolean }>; stop(): Promise<{ text: string }> };
  /** Open a link in Safari (sign-in pages, anything outside the hub). */
  openURL(url: string): Promise<{ ok: boolean }>;
  haptic(kind: NativeHapticKind): Promise<{ ok: boolean }>;
  /** The page's session ended: the app gets a new one and reloads the page (no reply). */
  reauth(): void;
  /** Messages from the app. Returns unsubscribe. */
  onEvent(listener: (e: NativeEvent) => void): () => void;
}

declare global {
  interface Window {
    __OWLBOT_SHARED__?: {
      react: unknown;
      reactDom: unknown;
      reactDomClient: unknown;
      jsxRuntime: unknown;
      ui: OwlbotUIRuntime;
    };
  }
}

/** What the "@owlbot/ui" module exports at runtime. */
export interface OwlbotUIRuntime {
  definePluginUI(activate: (ui: OwlbotUI) => void | (() => void)): UiPluginModule;
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
  /**
   * Where the page loads a picture from: the page may only load images from the hub, so an http(s) address goes
   * through the hub's image proxy. Undefined for what cannot be shown.
   */
  mediaSrc(src: string): string | undefined;
  /** Interface language (same as ui.i18n.locale). */
  locale: Locale;
  /**
   * The iOS app's bridge when the page runs inside the Owlbot app; `undefined` in a browser, so check it first:
   * `native?.haptic("success")`.
   */
  native: NativeBridge | undefined;
}

// Value exports: declared here for type-checking only. At runtime the import map points "@owlbot/ui"
// to the host shim (/shared/owlbot-ui.js), which provides these values. Plugins must mark "@owlbot/ui" external.
export declare const definePluginUI: OwlbotUIRuntime["definePluginUI"];
export declare const Button: OwlbotUIRuntime["Button"];
export declare const Card: OwlbotUIRuntime["Card"];
export declare const Badge: OwlbotUIRuntime["Badge"];
export declare const EmptyState: OwlbotUIRuntime["EmptyState"];
export declare const Spinner: OwlbotUIRuntime["Spinner"];
export declare const Markdown: OwlbotUIRuntime["Markdown"];
export declare const useTasks: OwlbotUIRuntime["useTasks"];
export declare const useHubEvent: OwlbotUIRuntime["useHubEvent"];
export declare const api: OwlbotUIRuntime["api"];
export declare const mediaSrc: OwlbotUIRuntime["mediaSrc"];
export declare const locale: OwlbotUIRuntime["locale"];
/** The iOS app's bridge; `undefined` in a browser. */
export declare const native: OwlbotUIRuntime["native"];
export type { Locale, Message, MessagePart, Params, Task, UiEvent };
