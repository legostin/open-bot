// Plugin-side API. Plugins should only `import type` from here: the runner provides
// the implementation, so plugins installed outside the monorepo need no runtime deps.

import type {
  BrainEvent,
  BrainLoginUpdate,
  BrainSessionOptions,
  BrainTurn,
  CoreMethod,
  Locale,
  NotifyLevel,
  OutboundMessage,
  Params,
  ProbeResult,
  ToolCallContext,
  ToolResult,
  ToolSpec,
} from "@owlbot/shared";

export type ToolHandler = (input: any, ctx: ToolCallContext) => Promise<ToolResult | string> | ToolResult | string;

export interface ToolRegistration extends ToolSpec {
  /** Short name; the core exposes it as `<toolPrefix>_<name>`. */
  name: string;
  handler: ToolHandler;
}

export interface BrainSessionImpl {
  send(turn: BrainTurn): AsyncIterable<BrainEvent>;
  interrupt(): Promise<void> | void;
  close(): Promise<void> | void;
}

/** A running sign-in (see BrainProviderImpl.login). */
export interface BrainLoginImpl {
  /** The code the user pasted from the sign-in page (browser flows that report needsCode). */
  submitCode?(code: string): Promise<void> | void;
  cancel(): void;
  /** Resolves with the final update (succeeded, failed, cancelled or expired). */
  done: Promise<BrainLoginUpdate>;
}

export interface BrainProviderImpl {
  id: string;
  label: string;
  /** Named variants listed as separate brains (`<id>:<variant>`), e.g. API providers. */
  variants?: string[];
  probe(variant?: string): Promise<ProbeResult>;
  createSession(opts: BrainSessionOptions): Promise<BrainSessionImpl>;
  /**
   * Sign the CLI in without a terminal: start its device or browser login and report the page and code the user
   * needs through `onUpdate`. `env` carries the egress proxy the login may use. Only brains that can do it have it.
   */
  login?(opts: { env: Record<string, string>; onUpdate: (u: BrainLoginUpdate) => void }): BrainLoginImpl | Promise<BrainLoginImpl>;
}

export interface ChannelImpl {
  id: string;
  label: string;
  send(message: OutboundMessage): Promise<{ externalId?: string } | void>;
  status?(): Promise<{ connected: boolean; detail?: string }>;
}

export type HookName = "session.start" | "tool.before" | "tool.after" | "message.in" | "notify.before" | "digest.compose";

export interface HookPayloads {
  "session.start": { sessionId: string; agentId: string; conversationId: string; taskId?: string; background: boolean };
  "tool.before": { tool: string; input: unknown; context: ToolCallContext };
  "tool.after": { tool: string; input: unknown; result: ToolResult; context: ToolCallContext };
  "message.in": { conversationId: string; text: string; channel?: string };
  "notify.before": { level: NotifyLevel; title: string; body: string; agentId?: string; triggerId?: string };
  /** A digest is going out: `date` (YYYY-MM-DD) and `time` (HH:MM) are local in `timezone`. */
  "digest.compose": { date: string; time: string; timezone: string };
}

export interface HookResults {
  "session.start": { appendSystemPrompt?: string } | void;
  "tool.before": { block?: string; input?: unknown } | void;
  "tool.after": { result?: ToolResult } | void;
  "message.in": { block?: string; text?: string } | void;
  "notify.before": { block?: string; level?: NotifyLevel } | void;
  /** A section of the digest (in the hub language), or nothing. */
  "digest.compose": { title: string; body: string } | void;
}

export type EventName =
  | "message.created"
  | "message.updated"
  | "task.updated"
  | "notification.created"
  | "notification.feedback"
  | "approval.created"
  | "approval.resolved"
  | "conversation.updated"
  | "vault.state"
  /** `{ ids }`: vault items the user just stored from the chat (e.g. the token this plugin waits for). */
  | "vault.updated";

export interface PluginHttpRequest {
  method: string;
  /** Path after /api/plugins/<id>/http (or /hooks/<id> for public requests), starting with "/". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** True for unauthenticated public webhooks (/hooks/<pluginId>/...). Validate secrets yourself. */
  public: boolean;
  /** Language of whoever made the request (the UI's choice); the hub language for public webhooks. */
  locale: Locale;
}

export interface PluginHttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PluginContext {
  pluginId: string;
  pluginDir: string;
  /** Private writable directory for this plugin. */
  dataDir: string;
  /** Base URL of the hub, reachable from this process (e.g. http://127.0.0.1:8080). */
  hubUrl: string;
  /** Absolute path of the hub's repository root (for locating shared binaries like the MCP bridge). */
  appRoot: string;
  settings: Record<string, any>;
  onSettingsChange(cb: (settings: Record<string, any>) => void): void;
  /**
   * Translations from the plugin's .owlbot-plugin/locales/<locale>.json. Use them for text people read
   * (channel messages, notifications, approval summaries); text for the model stays in English.
   */
  i18n: {
    /** The hub language (Settings → language). */
    locale(): Locale;
    /** Translate a key into `locale` (default: the hub language); falls back to English, then to the key. */
    t(key: string, params?: Params, locale?: Locale): string;
    onChange(cb: (locale: Locale) => void): void;
  };
  log: PluginLogger;
  tools: { register(tool: ToolRegistration): void };
  brains: { register(provider: BrainProviderImpl): void };
  channels: { register(channel: ChannelImpl): void };
  events: { on(name: EventName, cb: (payload: any) => void): void };
  hooks: { on<H extends HookName>(hook: H, handler: (payload: HookPayloads[H]) => Promise<HookResults[H]> | HookResults[H]): void };
  http: { handle(handler: (req: PluginHttpRequest) => Promise<PluginHttpResponse> | PluginHttpResponse): void };
  ui: {
    /** Push an event to all web clients: they receive {type:"plugin.event", data:{pluginId, channel, payload}}. */
    emit(channel: string, payload: unknown): void;
    /** Messages sent by this plugin's UI over the hub websocket. */
    onMessage(cb: (payload: any) => void): void;
  };
  vault: {
    /**
     * Fields of a vault item. Only items allowed by permissions.vault and the item's scope.
     * Hub errors (here and in core calls) are English in `message`; `data.text` has the same error in the
     * hub language for showing to people, and `data.key` / `data.params` identify it.
     */
    get(ref: string, opts?: { domain?: string; reason?: string }): Promise<Record<string, string>>;
  };
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
  };
  core: { call<T = any>(method: CoreMethod, params?: unknown): Promise<T> };
}

export interface PluginModule {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

/** Identity helper for type inference. Optional: plugins may export a plain object. */
export function definePlugin(mod: PluginModule): PluginModule {
  return mod;
}
