// Domain types shared by core, plugins, web and the node daemon.
// This file is the contract: change it deliberately.

import type { Locale } from "./i18n.ts";
import type { AgentAvatar } from "./avatar.ts";

export type ISODate = string;

// ---------- Tools ----------

/** What a tool does to the world. Drives the default policy decision. */
export type ToolEffect = "read" | "local-write" | "external";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  [k: string]: unknown;
};

/** Tool names use only [a-zA-Z0-9_-] (Anthropic/OpenAI tool-name rules). Plugin tools are `<pluginId>_<name>`. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effect: ToolEffect;
  /** Results come from outside (web, email, external MCP): reading them taints the session. */
  source?: boolean;
  /** Template for approval cards, e.g. "Send an email to {to}: {subject}" or a "%key%" from the plugin's locales. */
  approvalSummary?: string;
  /** Only available to background tasks / interactive sessions. Default: both. */
  availability?: "all" | "interactive" | "background";
}

export interface ToolDescriptor extends ToolSpec {
  /** "core", a plugin id, or "mcp:<server>". */
  owner: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** MCP CallToolResult shape plus our metadata. */
export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
  _meta?: {
    /** Force-taint the session even if the tool is not a source. */
    taint?: boolean;
    /** Files produced, relative to the workspace. */
    artifacts?: string[];
    status?: "awaiting_approval" | "denied";
    approvalId?: string;
  };
}

export interface ToolCallContext {
  sessionId: string;
  conversationId: string;
  taskId?: string;
  agentId: string;
  callId: string;
  tainted: boolean;
  background: boolean;
  workspace: string;
  machineId: string;
}

// ---------- Policy ----------

export type PolicyDecision = "allow" | "ask" | "deny";

export type RuleCondition =
  | { field: string; op: "eq"; value: string }
  | { field: string; op: "glob"; value: string }
  | { field: string; op: "domain"; value: string };

export interface Rule {
  id: string;
  tool: string; // exact tool name or glob like "browser_*"
  agentId?: string;
  conditions: RuleCondition[];
  decision: "allow" | "deny";
  note?: string;
  createdAt: ISODate;
  createdVia: "console" | "telegram" | "approval";
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed" | "failed";

export interface Approval {
  id: string;
  sessionId: string;
  conversationId: string;
  taskId?: string;
  agentId: string;
  tool: string;
  input: unknown;
  summary: string;
  effect: ToolEffect;
  tainted: boolean;
  status: ApprovalStatus;
  result?: ToolResult;
  createdAt: ISODate;
  resolvedAt?: ISODate;
  resolvedVia?: "console" | "telegram" | "rule" | "timeout";
}

// ---------- Secrets entered in the chat ----------

export type SecretRequestStatus = "pending" | "saved" | "cancelled";

/**
 * The hub asked the user for a secret in the chat. The value is typed into a card (or pasted as the next message)
 * and stored in the vault; the model only ever learns `vault://<vaultId>`.
 */
export interface SecretRequest {
  id: string;
  vaultId: string;
  /** What it is, e.g. "Telegram bot token". */
  title: string;
  /** Why it is needed / where to get it (written by the agent or the plugin manifest). */
  hint?: string;
  link?: string;
  /** Plugin that uses the secret; its `setting` receives "vault://<vaultId>". */
  pluginId?: string;
  setting?: string;
  conversationId?: string;
  status: SecretRequestStatus;
  /** Whether the vault already holds an item with this id (saving replaces it). */
  exists?: boolean;
  createdAt: ISODate;
  resolvedAt?: ISODate;
}

/** What a plugin needs before it works, for the setup card in the chat and the plugins page. */
export interface PluginSetupView {
  pluginId: string;
  name: string;
  enabled: boolean;
  status: string;
  lastError?: string;
  vaultState: VaultState;
  /** pattern: the declared format, for a warning before saving something that does not match. */
  secrets: Array<{ vaultId: string; title: string; hint?: string; link?: string; pattern?: string; required: boolean; present: boolean; setting?: string }>;
}

/** A new team agent the default agent puts together with the user in the chat. Nothing exists until it is created. */
export interface AgentDraft {
  id: string;
  conversationId: string;
  name: string;
  /** Shown to the user, in their language. */
  description: string;
  /** The new agent's instructions. */
  prompt: string;
  avatar: AgentAvatar;
  /** Unset until the user has said how proactive the agent should be (the agent then gets the default). */
  initiative?: 0 | 1 | 2;
  brains: string[];
  status: "draft" | "created";
  /** The agent made from the draft. */
  agentId?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------- Conversations, messages ----------

export type MessageRole = "user" | "assistant" | "system";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "approval"; approvalId: string; summary: string; status: ApprovalStatus }
  | { type: "notification"; level: NotifyLevel; title: string; body: string }
  | { type: "error"; message: string }
  /** A file the user sent (or a plugin attached): `path` is relative to the workspaces root, `size` in bytes. */
  | { type: "attachment"; path: string; name: string; mimeType?: string; size?: number; kind?: AttachmentKind; durationSec?: number; transcript?: string }
  /** A secret the user types into the chat card; the value goes straight to the vault and never into the conversation. */
  | { type: "secret_request"; requestId: string; vaultId: string; title: string; status: SecretRequestStatus }
  /** A plugin's setup card: its secrets and its own setup UI (e.g. Telegram pairing), live. */
  | { type: "plugin_setup"; pluginId: string }
  /** A new agent being put together in the chat: its look, description and proactivity, live, with a button that creates it. */
  | { type: "agent_draft"; draftId: string }
  /** A CLI brain's sign-in card (device code or browser code), live. */
  | { type: "brain_login"; ref: string }
  /** No brain of the agent works yet: the hub's own setup card (sign in, install, API key), live. */
  | { type: "brain_setup" }
  /** Pictures the agent shows (show_images): one item is a single image, two or more a carousel. */
  | { type: "images"; items: ImageItem[] }
  /** An OpenStreetMap map the agent shows (show_map), centred on lat/lon; without zoom it fits the markers. */
  | { type: "map"; lat: number; lon: number; zoom?: number; title?: string; markers?: MapMarker[] };

/** What a sent file is: a voice note and a photo are told apart from an audio file or a document by the channel. */
export type AttachmentKind = "photo" | "voice" | "audio" | "video" | "file";

/** `src` is an http(s) URL (shown through the hub's image proxy) or `file:<path relative to the workspaces root>`. */
export interface ImageItem {
  src: string;
  alt?: string;
  caption?: string;
}

export interface MapMarker {
  lat: number;
  lon: number;
  label?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  parts: MessagePart[];
  status: "streaming" | "complete" | "error";
  agentId?: string;
  taskId?: string;
  brainRef?: string;
  /** Where a user message came from / where an assistant reply should also go. */
  channel?: string;
  createdAt: ISODate;
}

export interface Conversation {
  id: string;
  /**
   * "main": an agent's long-lived dialog with the user (one per agent); "task": a task's thread; "chat": an older ad-hoc chat;
   * "group": the user with several agents (`members`).
   */
  kind: "main" | "task" | "chat" | "group";
  title: string;
  /** The agent who answers; in a group, its lead (`members[0]`). */
  agentId: string;
  /** A group's agents in order, the lead first (2–8, see GROUP_MAX_MEMBERS). */
  members?: string[];
  taskId?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** An agent of the user's team as the sidebar shows it: its long-lived dialog and what happens there. */
export interface TeamMember {
  agentId: string;
  /** The agent's dialog (kind "main"). */
  conversationId: string;
  /** The latest message worth a preview, as short plain text. */
  lastMessage?: { role: MessageRole; text: string; createdAt: ISODate };
  lastActivityAt: ISODate;
  /** A turn is in progress in the dialog. */
  running: boolean;
  /** Messages from the agent (or the system) the user has not seen yet. */
  unread: number;
}

/** A group chat as the sidebar shows it, kept current by "group.updated". */
export interface GroupChat {
  conversationId: string;
  title: string;
  /** The lead first. */
  members: string[];
  /** The latest message worth a preview, as short plain text; `agentId` says who wrote it. */
  lastMessage?: { role: MessageRole; text: string; createdAt: ISODate; agentId?: string };
  lastActivityAt: ISODate;
  /** Members are answering. */
  running: boolean;
  /** While running: the member who has the floor, then those who answer after them. */
  speaking: string[];
  unread: number;
}

// ---------- Tasks ----------

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "interrupted"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  conversationId: string;
  parentConversationId?: string;
  parentTaskId?: string;
  agentId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  brainRef?: string;
  createdBy: "user" | "agent" | "trigger";
  triggerId?: string;
  background: boolean;
  result?: string;
  error?: string;
  resumeAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------- Agents ----------

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  /** Ordered brain refs, e.g. ["claude-code@local", "api:anthropic"]. */
  brains: string[];
  model?: string;
  /** 0 = only reacts, 1 = suggests (read-only background), 2 = acts within rules. */
  initiative: 0 | 1 | 2;
  /** Tool name globs. ["*"] = all. */
  tools: string[];
  skills: string[];
  policyProfile: string;
  budget: { backgroundRunsPerDay: number; tokensPerDay?: number };
  prompt: string;
  source: "builtin" | "user" | string;
  /** Colour + shape picked when the agent was created; the UI derives one from the id when absent. */
  avatar?: AgentAvatar;
  /** Translated name / description shown in the UI ("i18n: { ru: { name: … } }" in the frontmatter). */
  i18n?: Partial<Record<Locale, { name?: string; description?: string }>>;
}

// ---------- Brains ----------

export interface BrainRef {
  brainId: string;
  variant?: string;
  machineId: string; // "local" for the hub host
}

export interface ProbeResult {
  available: boolean;
  authenticated: boolean;
  version?: string;
  models?: string[];
  detail?: string;
}

// ---------- Brain sign-in from the chat ----------

/**
 * [installing (the hub installs a missing CLI first)] → starting → waiting (the user signs in on the page) → verifying
 * (a pasted code is being checked) → succeeded, or failed / cancelled / expired (the code ran out before the user finished).
 */
export type BrainLoginStatus = "installing" | "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";

/** What a sign-in reports while it runs (from the brain's host to the hub). */
export interface BrainLoginUpdate {
  status: BrainLoginStatus;
  /** Page the user opens to sign in. */
  url?: string;
  /** One-time code the user types on that page (device flow, e.g. Codex). */
  userCode?: string;
  /** The page shows a code the user pastes back into the card (browser flow, e.g. Claude Code). */
  needsCode?: boolean;
  expiresAt?: ISODate;
  /** Why it failed, for people. */
  error?: string;
}

/** A CLI brain signing in without a terminal, as the sign-in card shows it. */
export interface BrainLoginState extends BrainLoginUpdate {
  id: string;
  ref: string;
  startedAt: ISODate;
  finishedAt?: ISODate;
}

/** Everything the sign-in card needs for one brain. */
export interface BrainLoginView {
  ref: string;
  label: string;
  connected: boolean;
  /** The brain can sign in from the chat. */
  supported: boolean;
  probe?: ProbeResult;
  /** The latest sign-in since the hub started, running or finished. */
  login?: BrainLoginState;
}

// ---------- First-run setup ----------

/** What the default agent walks the user through once a brain works. */
export type SetupStep = "telegram" | "backupBrain" | "machines" | "profile";

/** One of the agent's brains on this hub, as the setup card shows it. */
export interface SetupBrain {
  ref: string;
  label: string;
  /** A CLI that signs in from the chat (Claude Code, Codex), or a brain that takes a key or token. */
  kind: "cli" | "api";
  /** The CLI starts on this computer (always true for api brains). */
  installed: boolean;
  signedIn: boolean;
  /** The hub can install the missing CLI itself (desktop installs). */
  canInstall: boolean;
  detail?: string;
}

export interface SetupState {
  agentId: string;
  brains: SetupBrain[];
  /** Some brain of the agent works now (rate limits aside). */
  usable: boolean;
  vault: "absent" | "locked" | "open";
  telegram: boolean;
  machines: number;
  done: SetupStep[];
  skipped: SetupStep[];
  /** Steps neither done nor skipped, in the order the agent offers them. */
  remaining: SetupStep[];
}

export interface BrainSessionOptions {
  sessionId: string;
  agent: AgentDef;
  variant?: string;
  model?: string;
  workspace: string;
  mcp: {
    url: string;
    token: string;
    /** Command that runs the stdio MCP bridge, e.g. ["node", "/app/packages/mcp-bridge/src/index.ts"]. */
    bridgeCommand: string[];
  };
  systemPrompt: string;
  /** Where materialized skills live for this session (already copied into the workspace). */
  skillsDir?: string;
  /** Claude Code-format plugin dirs to pass via --plugin-dir. */
  claudePluginDirs?: string[];
  resume?: string;
  env: Record<string, string>;
  background: boolean;
}

export type BrainEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "limit_hit"; resetAt?: ISODate; detail: string }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "done"; resumeToken?: string };

export interface BrainTurn {
  text: string;
  attachments?: string[];
}

// ---------- Notifications ----------

export type NotifyLevel = "silent" | "digest" | "notify" | "ask";

export interface Notification {
  id: string;
  level: NotifyLevel;
  title: string;
  body: string;
  agentId?: string;
  taskId?: string;
  triggerId?: string;
  conversationId?: string;
  createdAt: ISODate;
  deliveredAt?: ISODate;
  feedback?: "useful" | "less" | "off";
}

// ---------- Channels ----------

export interface OutboundMessage {
  kind: "reply" | "notification" | "approval" | "digest";
  text: string;
  /** A reply to a message the user wrote elsewhere (the web UI): their words, so the channel shows the exchange. */
  quote?: string;
  /** Deep link into the web UI or console. */
  link?: string;
  conversationId?: string;
  notificationId?: string;
  approval?: {
    id: string;
    summary: string;
    approveToken: string;
    denyToken: string;
  };
  feedback?: { notificationId: string; tokens: { useful: string; less: string; off: string } };
  /** Deliver without sound (quiet hours). */
  silent?: boolean;
  /** Images and maps of the reply, sent after its text. */
  media?: OutboundMedia[];
}

/**
 * Media for a channel. An image comes as a public URL (the channel may let its service fetch it) or inline as base64
 * `data` (a file from the agent's workspace, at most 10 MB).
 */
export type OutboundMedia =
  | { kind: "image"; url?: string; data?: string; mimeType?: string; name?: string; caption?: string }
  | { kind: "map"; lat: number; lon: number; title?: string };

// ---------- Machines ----------

export interface MachineInfo {
  os: string;
  hostname: string;
  arch: string;
  clis: Array<{ brainId: string } & ProbeResult>;
  allowedDirs: string[];
  nodeVersion: string;
}

export interface Machine {
  id: string;
  name: string;
  publicKey: string;
  status: "online" | "offline";
  info?: MachineInfo;
  lastSeenAt?: ISODate;
  createdAt: ISODate;
}

// ---------- Vault ----------

export type VaultState = "uninitialized" | "sealed" | "unlocked";
export type VaultItemType = "login" | "secret" | "identity" | "note";

export interface VaultScope {
  domains: string[];
  plugins: string[];
  agents: string[];
  tools: string[];
  mode: "auto" | "ask";
  revealToModel: boolean;
}

export interface VaultItemMeta {
  id: string;
  type: VaultItemType;
  name: string;
  scope: VaultScope;
  /** Non-secret hints shown to the model, e.g. username or url. */
  hints: Record<string, string>;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface VaultItem extends VaultItemMeta {
  /** Secret fields: login → {url, username, password, totp?}; secret → {value}; identity → any; note → {text}. */
  fields: Record<string, string>;
}

// ---------- Audit ----------

export interface AuditEntry {
  seq: number;
  ts: ISODate;
  actor: string; // "user", "agent:<id>", "plugin:<id>", "core", "machine:<id>"
  action: string; // "tool.call", "policy.decision", "approval.resolve", "vault.access", ...
  target?: string;
  data?: unknown;
  prevHash: string;
  hash: string;
}

// ---------- Realtime events (hub → web) ----------

export type UiEvent =
  | { type: "message.created"; data: Message }
  | { type: "message.delta"; data: { id: string; conversationId: string; delta: string } }
  | { type: "message.updated"; data: Message }
  | { type: "conversation.updated"; data: Conversation }
  | { type: "team.updated"; data: TeamMember }
  | { type: "group.updated"; data: GroupChat }
  | { type: "task.updated"; data: Task }
  | { type: "notification.created"; data: Notification }
  | { type: "approval.pending"; data: { count: number } }
  | { type: "brains.updated"; data: Record<string, never> }
  | { type: "plugins.updated"; data: Record<string, never> }
  | { type: "agents.updated"; data: Record<string, never> }
  | { type: "settings.updated"; data: Record<string, unknown> }
  | { type: "machine.updated"; data: Machine }
  | { type: "vault.state"; data: { state: VaultState } }
  | { type: "secret.request"; data: SecretRequest }
  | { type: "agent_draft.updated"; data: AgentDraft }
  | { type: "brain.login"; data: BrainLoginState }
  | { type: "plugin.event"; data: { pluginId: string; channel: string; payload: unknown } };
