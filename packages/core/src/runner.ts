// Session runner: turns user messages, delegated tasks and trigger runs into brain sessions.
// Handles brain selection and fallback, streaming into messages, tasks, deferred approvals and recovery.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, Approval, BrainEvent, BrainTurn, Conversation, Message, MessagePart, OutboundMedia, OutboundMessage, SecretRequest, Task, ToolResult } from "@owlbot/shared";
import { formatBrainRef, newId, nowIso, parseBrainRef, truncate } from "@owlbot/shared";
import type { Config } from "./config.ts";
import type { Store, SessionRow } from "./store.ts";
import type { Settings } from "./settings.ts";
import type { AgentRegistry } from "./agents.ts";
import type { BrainRegistry, BrainHandle } from "./brains.ts";
import type { SkillIndex } from "./skills.ts";
import type { HookRegistry } from "./hooks.ts";
import type { Notifier } from "./notifier.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { AuditLog } from "./audit.ts";
import type { EventBus } from "./bus.ts";
import type { Redactor } from "./vault/redact.ts";
import type { ToolGateway } from "./tools/gateway.ts";
import type { ApprovalService } from "./approvals.ts";
import type { EgressProxy } from "./egress.ts";
import { DEFAULT_BRAIN_EGRESS } from "./settings.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { agentName } from "./agents.ts";
import { hubLocale, LocalizedError, t } from "./i18n.ts";
import { captureNote, type CaptureResult, type SecretIntake } from "./secrets.ts";
import { MAX_IMAGE_BYTES, readWorkspaceImage } from "./media.ts";
import { TurnClock } from "./clock.ts";
import { attachmentNote, forSession, isSpeech, SPEECH_NOT_SET_UP, type AttachmentPart, type SessionFile } from "./attachments.ts";
import { MAX_AUTO_TRANSCRIBE_SEC, type Transcriber } from "./transcribe.ts";
import { firstSpeakers, groupTurn, groupTurnText, handOff, MAX_HANDOFFS, USER_LABEL } from "./group-chat.ts";

export interface RunnerDeps {
  config: Config;
  store: Store;
  settings: Settings;
  agents: AgentRegistry;
  brains: BrainRegistry;
  skills: SkillIndex;
  hooks: HookRegistry;
  notifier: Notifier;
  channels: ChannelRegistry;
  audit: AuditLog;
  bus: EventBus;
  redactor: Redactor;
  gateway: ToolGateway;
  approvals: ApprovalService;
  egress: EgressProxy;
  /** Claude Code-format plugin dirs to pass to Claude Code sessions. */
  claudePluginDirs: () => string[];
  machineName: (machineId: string) => string | undefined;
  secrets: SecretIntake;
  /** First-run setup (set by the hub): keeps messages written while no brain works and adds the prompt section. */
  setup?: {
    hold(conversationId: string, agentId: string, prompt: string, opts: { replyChannel?: string; quote?: string; attachments?: AttachmentPart[]; speech?: Record<string, string> }): void;
    promptBlock(agentId: string): Promise<string | undefined>;
  };
  /** Speech to text for voice messages (set by the hub). */
  transcriber?: Transcriber;
}

/** What the web UI passes as the channel of a typed message (not a registered channel). */
const WEB_CHANNEL = "web";

interface TurnOpts {
  task?: Task;
  /** The channel the user's message came from: the reply goes back there. */
  replyChannel?: string;
  /** The user's words typed in the web UI, quoted when the reply is mirrored to the channels. */
  quote?: string;
  /** The member who answers (group chats; default: the conversation's agent). */
  agentId?: string;
  /** Files that came with the user's message: the brain gets their paths and a note. */
  attachments?: AttachmentPart[];
  /** Voice notes without a transcript, by path: why (the note tells the agent). */
  speech?: Record<string, string>;
  /** Group chats: the user message this round answers, and why the member has the floor if not addressed by it. */
  group?: { triggerId?: string; floorNote?: string };
}

interface Live {
  handle: BrainHandle;
  brainRef: string;
  /** The agent definition the session was opened with: an edited agent gets a fresh session on its next turn. */
  stamp: string;
}

export interface TurnResult {
  text: string;
  /** Just the final answer, without the narration around tool calls: what the channels get. */
  answer?: string;
  error?: string;
  limited?: { resetAt?: string };
  awaitingApproval: boolean;
  /** The assistant message the turn wrote. */
  messageId?: string;
}

/** Harness built-in tools whose results come from the outside world. */
const NATIVE_SOURCE_TOOLS = /^(WebFetch|WebSearch|web_search|fetch)$/i;
const MAX_TASK_CONCURRENCY = 4;
/** Settings key: agent id → when the user last changed that agent's brains. */
const BRAINS_CHANGED_KEY = "brainsChangedAt";
/** Workspace images a channel gets inline with one reply, in all. */
const MAX_INLINE_MEDIA_BYTES = 4 * MAX_IMAGE_BYTES;

export class SessionRunner {
  d: RunnerDeps;
  private live = new Map<string, Live>();
  private queues = new Map<string, Promise<unknown>>();
  private activeTurns = new Map<string, { sessionId: string; handle: BrainHandle }>();
  private runningTasks = new Set<string>();
  private brainLoad = new Map<string, number>();
  /** When each live session last got the current time (clock.ts). */
  private clock = new TurnClock();
  private timer?: NodeJS.Timeout;
  private kickoff?: NodeJS.Timeout;
  private streamingMessage = new Map<string, string>(); // conversationId -> messageId
  private turning = new Map<string, number>(); // conversationId -> turns in progress
  /** Group chats: the member answering now, then the ones waiting (while a round runs). */
  private floors = new Map<string, string[]>();
  /** Group chats: bumped by Stop, so rounds started or queued before it end. */
  private groupEpoch = new Map<string, number>();
  /** Group chats: `${conversationId}|${agentId}` -> user messages up to this moment were shown to the member. */
  private groupSeen = new Map<string, string>();

  constructor(deps: RunnerDeps) {
    this.d = deps;
    deps.approvals.onDeferredApproved = (a) => this.onDeferredApproved(a);
    deps.approvals.onDeferredDenied = (a) => this.onDeferredDenied(a);
    deps.bus.on("approval.created", (a: Approval) => this.attachApprovalPart(a));
    deps.bus.on("approval.resolved", (a: Approval) => this.updateApprovalPart(a));
    deps.secrets.onResolved = (r, how) => this.onSecretResolved(r, how);
  }

  // ---------- lifecycle ----------

  start(): void {
    this.d.store.failStreamingMessages();
    for (const t of this.d.store.listTasks({ status: ["running", "waiting_approval", "interrupted"] })) {
      this.d.store.updateTask(t.id, { status: "queued" });
    }
    this.timer = setInterval(() => {
      this.scheduleTasks();
      const s = this.d.settings.get();
      const { remind } = this.d.approvals.sweep(s.approvalExpireHours);
      for (const a of remind) {
        void this.d.notifier.notify({ level: "notify", title: t("notify.awaitingApproval"), body: a.summary, agentId: a.agentId, taskId: a.taskId });
      }
    }, 15_000);
    this.timer.unref();
    this.kickoff = setTimeout(() => this.scheduleTasks(), 1000).unref();
  }

  async stop(): Promise<void> {
    // Both timers go before the hub closes the database: a hub stopped within a second of starting would otherwise query a closed db.
    clearInterval(this.timer);
    clearTimeout(this.kickoff);
    await Promise.all([...this.live.keys()].map((id) => this.closeLive(id)));
  }

  /** Close a live brain session and revoke its egress grant. */
  private async closeLive(id: string): Promise<void> {
    const l = this.live.get(id);
    this.live.delete(id);
    this.d.egress.revokeOwner(`brain:${id}`);
    this.clock.forget(id);
    await l?.handle.close().catch(() => {});
  }

  // ---------- public entry points ----------

  /** A user message arrived (web, Telegram, ...). Returns the stored user message. */
  /** `context`: lines for the model only, before the user's words (a channel's "forwarded from…", "in reply to…"). */
  async userMessage(
    conversationId: string,
    text: string,
    opts: { channel?: string; attachments?: AttachmentPart[]; context?: string; onCapture?: (c: CaptureResult) => void } = {},
  ): Promise<Message> {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) throw new LocalizedError("conversation.notFound");
    // Secrets come out first: message hooks, the stored message and the model only see vault:// references.
    const cap = this.d.secrets.capture(text, conversationId, "user");
    if (cap.stored.length || cap.withheld) opts.onCapture?.(cap);
    text = cap.text;
    const hooked = await this.d.hooks.run("message.in", { conversationId, text, channel: opts.channel }, (p, r) =>
      r.block ? { blocked: r.block } : r.text !== undefined ? { ...p, text: r.text } : p,
    );
    const attachments = opts.attachments ?? [];
    const parts: MessagePart[] = [...(text || !attachments.length ? [{ type: "text" as const, text }] : []), ...attachments];
    const msg = this.d.store.addMessage({ conversationId, role: "user", parts, status: "complete", channel: opts.channel });
    if (cap.withheld) this.d.store.addMessage({ conversationId, role: "system", parts: [{ type: "error", message: t("secrets.withheld") }], status: "complete" });
    if (hooked.blocked) {
      this.d.store.addMessage({ conversationId, role: "system", parts: [{ type: "error", message: t("message.blocked", { reason: hooked.blocked }) }], status: "complete" });
      return msg;
    }
    // Just the answer to a secret card whose tool call is still waiting: that call carries on, no new turn.
    if (cap.answered?.waited && text.trim() === `vault://${cap.answered.request.vaultId}`) return msg;
    const note = captureNote(cap);
    const expanded = this.d.skills.expandCommand(hooked.payload.text) ?? hooked.payload.text;
    const prompt = [opts.context?.trim(), note ? `${expanded}\n\n${note}` : expanded].filter(Boolean).join("\n");
    // From the web UI: the user's words travel with a mirrored reply, so the phone shows the exchange.
    const fromWeb = !opts.channel || opts.channel === WEB_CHANNEL;
    const files = attachments.length ? { attachments } : {};
    if (conv.kind === "group") {
      this.startGroupRound(conv, hooked.payload.text, prompt, msg.id, { replyChannel: opts.channel, ...files });
      return msg;
    }
    const quote = [text, ...attachments.map((a) => `📎 ${a.name}`)].filter(Boolean).join("\n");
    // Voice notes become words first, in the queue: the turn waits for them, later messages wait for the turn.
    void this.enqueue(conversationId, async () =>
      this.runTurn(conv, prompt, { replyChannel: opts.channel, ...(attachments.length ? await this.transcribeParts(msg.id, attachments) : {}), ...(fromWeb ? { quote } : {}) }),
    );
    return msg;
  }

  /** Voice notes and audio files in a user message become words: stored on the parts (the chat shows them), and why not when they cannot. */
  private async transcribeParts(messageId: string, parts: AttachmentPart[]): Promise<{ attachments: AttachmentPart[]; speech: Record<string, string> }> {
    const speech: Record<string, string> = {};
    const todo = parts.filter((p) => isSpeech(p) && p.transcript === undefined);
    if (!todo.length) return { attachments: parts, speech };
    const t = this.d.transcriber;
    if (!t?.engine()) {
      for (const p of todo) speech[p.path] = SPEECH_NOT_SET_UP;
      return { attachments: parts, speech };
    }
    const root = join(this.d.config.dataDir, "workspaces");
    const out: AttachmentPart[] = [];
    for (const p of parts) {
      if (!todo.includes(p)) out.push(p);
      else if (p.durationSec !== undefined && p.durationSec > MAX_AUTO_TRANSCRIBE_SEC) {
        speech[p.path] = "not transcribed: longer than 10 minutes (transcribe_audio can do it if the user wants)";
        out.push(p);
      } else {
        try {
          out.push({ ...p, transcript: await t.transcribe(join(root, p.path), p.mimeType) });
        } catch (e: any) {
          speech[p.path] = `could not transcribe it: ${e?.message ?? e}`;
          out.push(p);
        }
      }
    }
    const done = new Map(out.filter((p) => p.transcript !== undefined).map((p) => [p.path, p.transcript!]));
    const m = done.size ? this.d.store.getMessage(messageId) : undefined;
    if (m) this.d.store.updateMessage(m.id, { parts: m.parts.map((p) => (p.type === "attachment" && done.has(p.path) ? { ...p, transcript: done.get(p.path) } : p)) });
    return { attachments: out, speech };
  }

  // ---------- group chats ----------

  /** A group's members that are still on the team, in order (the lead first), with their names. */
  private groupMembers(conv: Conversation): Array<{ id: string; name: string }> {
    const out: Array<{ id: string; name: string }> = [];
    for (const id of conv.members ?? [conv.agentId]) {
      const a = this.d.agents.get(id);
      if (a) out.push({ id, name: agentName(a, hubLocale()) });
    }
    return out;
  }

  /** The member answering in a group chat right now, then the ones waiting for their turn. */
  floor(conversationId: string): string[] {
    return this.floors.get(conversationId) ?? [];
  }

  private setFloor(conversationId: string, queue: string[] | undefined): void {
    if (queue?.length) this.floors.set(conversationId, queue);
    else this.floors.delete(conversationId);
    this.d.bus.emit("conversation.activity", { conversationId, running: this.isRunning(conversationId) });
  }

  /** The user wrote in a group: the members it mentions answer one after another (or the lead), in the conversation queue. */
  private startGroupRound(conv: Conversation, text: string, prompt: string, triggerId: string, opts: { replyChannel?: string; attachments?: AttachmentPart[] }): void {
    const epoch = this.groupEpoch.get(conv.id) ?? 0;
    const speakers = firstSpeakers(text, this.groupMembers(conv));
    void this.enqueue(conv.id, () => this.runGroupRound(conv.id, epoch, speakers, prompt, triggerId, opts));
  }

  private async runGroupRound(
    conversationId: string,
    epoch: number,
    speakers: string[],
    prompt: string,
    triggerId: string,
    opts: { replyChannel?: string; attachments?: AttachmentPart[]; speech?: Record<string, string> },
  ): Promise<void> {
    const stopped = () => (this.groupEpoch.get(conversationId) ?? 0) !== epoch;
    if (stopped()) return;
    if (opts.attachments?.length) opts = { ...opts, ...(await this.transcribeParts(triggerId, opts.attachments)) };
    const queue = [...speakers];
    const handedBy = new Map<string, string>();
    let handoffs = 0;
    let prev: string | undefined;
    // One "running" for the whole round: the sidebar and the composer do not flicker between members.
    this.setTurning(conversationId, 1);
    try {
      while (queue.length && !stopped()) {
        const conv = this.d.store.getConversation(conversationId);
        if (!conv) break;
        const members = this.groupMembers(conv);
        const agentId = queue.shift()!;
        // Left the group (or the team) meanwhile; and nobody speaks twice in a row unless the user named them.
        if (!members.some((m) => m.id === agentId) || (agentId === prev && !speakers.includes(agentId))) continue;
        this.setFloor(conversationId, [agentId, ...queue]);
        const from = handedBy.get(agentId);
        const fromName = from ? (members.find((m) => m.id === from)?.name ?? from) : undefined;
        const r = await this.runTurn(conv, prompt, {
          ...opts,
          agentId,
          group: { triggerId, floorNote: fromName ? `[System] ${fromName} handed the floor to you. It is your turn to reply in the group.` : undefined },
        });
        prev = agentId;
        if (stopped() || (r.error && !r.text)) continue;
        const next = handOff(queue, agentId, r.answer ?? r.text, members, MAX_HANDOFFS - handoffs);
        handoffs += next.added.length;
        for (const id of next.added) handedBy.set(id, agentId);
        queue.splice(0, queue.length, ...next.queue);
      }
    } finally {
      this.setFloor(conversationId, undefined);
      this.setTurning(conversationId, -1);
    }
  }

  /** A member's turn text: what it has not seen in the group yet, then the user's message or why it is its turn. */
  private groupText(conv: Conversation, agent: AgentDef, prompt: string, opts: TurnOpts, newBrain: boolean): string {
    const key = `${conv.id}|${agent.id}`;
    const names = new Map(this.groupMembers(conv).map((m) => [m.id, m.name]));
    const name = (id: string | undefined) => (id ? (names.get(id) ?? (this.d.agents.get(id) ? agentName(this.d.agents.get(id)!, hubLocale()) : id)) : USER_LABEL);
    const turn = groupTurn({
      messages: this.d.store.listMessages(conv.id, { limit: 60 }),
      agentId: agent.id,
      name,
      prompt,
      triggerId: opts.group?.triggerId,
      floorNote: opts.group?.floorNote,
      seenUserUpTo: this.groupSeen.get(key),
    });
    if (turn.seenUserUpTo) this.groupSeen.set(key, turn.seenUserUpTo);
    // A new brain has none of the history: the recent transcript instead of just the unseen part.
    if (newBrain) return `[System] This conversation continues on a different brain. Recent history:\n${this.handoffSummary(conv.id)}\n\n---\n${turn.tail}`;
    return groupTurnText({ ...turn, lines: turn.lines.map((l) => this.d.redactor.text(l)) });
  }

  /** A card (secret request, plugin setup, images, a map) for the message the agent is writing right now in this conversation. */
  attachPart(conversationId: string, part: MessagePart): void {
    const msgId = this.streamingMessage.get(conversationId);
    const m = msgId ? this.d.store.getMessage(msgId) : undefined;
    // The same card twice in one reply (the agent called the tool again) shows once.
    const key = attachedKey(part);
    if (m && key && m.parts.some((p) => attachedKey(p) === key)) return;
    if (m) this.d.store.updateMessage(m.id, { parts: [...m.parts, part] });
    else this.d.store.addMessage({ conversationId, role: "system", parts: [part], status: "complete" });
  }

  /** The user saved (or dismissed) a secret card after its tool call stopped waiting: tell the agent and let it go on. */
  private onSecretResolved(r: SecretRequest, how: { waited: boolean; viaMessage: boolean }): void {
    this.updateSecretPart(r);
    // Answered by a chat message: that message starts the next turn itself.
    if (how.waited || how.viaMessage || r.status === "pending" || !r.conversationId) return;
    const conv = this.d.store.getConversation(r.conversationId);
    if (!conv) return;
    if (r.status === "cancelled") {
      const note = `[System] The user dismissed the request for ${r.title} (vault://${r.vaultId}).`;
      this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete" });
      return;
    }
    this.tellAgent(conv.id, `[System] The user stored ${r.title} in the vault as vault://${r.vaultId}${r.pluginId ? ` and plugin ${r.pluginId} now uses it` : ""}. Carry on with what it was needed for.`);
  }

  /** Something the user did outside the conversation (a card) that the agent should hear about: a note and a turn. */
  tellAgent(conversationId: string, note: string): void {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) return;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete" });
    void this.enqueue(conv.id, () => this.runTurn(conv, note, {}));
  }

  /** The user did something in a card, outside any turn: note it for the agent and let it answer. */
  noteAndContinue(conversationId: string, note: string): void {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) return;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete" });
    void this.enqueue(conv.id, () => this.runTurn(conv, note, {}));
  }

  /** Messages kept while no brain worked: the agent answers them now. */
  resume(conversationId: string, prompt: string, opts: { replyChannel?: string; quote?: string; attachments?: AttachmentPart[]; speech?: Record<string, string> }): void {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) return;
    void this.enqueue(conv.id, () => this.runTurn(conv, prompt, opts));
  }

  private updateSecretPart(r: SecretRequest): void {
    if (!r.conversationId) return;
    for (const m of this.d.store.listMessages(r.conversationId, { limit: 50 })) {
      if (m.parts.some((p) => p.type === "secret_request" && p.requestId === r.id && p.status !== r.status)) {
        this.d.store.updateMessage(m.id, { parts: m.parts.map((p) => (p.type === "secret_request" && p.requestId === r.id ? { ...p, status: r.status } : p)) });
      }
    }
  }

  /** Stop the turn in progress. In a group chat the members still waiting (this round and queued ones) do not answer either. */
  interrupt(conversationId: string): boolean {
    const round = this.floors.has(conversationId);
    if (round || this.d.store.getConversation(conversationId)?.kind === "group") {
      this.groupEpoch.set(conversationId, (this.groupEpoch.get(conversationId) ?? 0) + 1);
    }
    const a = this.activeTurns.get(conversationId);
    if (a) void a.handle.interrupt();
    return !!a || round;
  }

  /** A turn (brain selection included) is in progress in the conversation. */
  isRunning(conversationId: string): boolean {
    return (this.turning.get(conversationId) ?? 0) > 0;
  }

  private setTurning(conversationId: string, delta: 1 | -1): void {
    const was = this.isRunning(conversationId);
    const n = Math.max(0, (this.turning.get(conversationId) ?? 0) + delta);
    if (n) this.turning.set(conversationId, n);
    else this.turning.delete(conversationId);
    if (was !== n > 0) this.d.bus.emit("conversation.activity", { conversationId, running: n > 0 });
  }

  createTask(t: {
    agentId: string;
    goal: string;
    title: string;
    parentConversationId?: string;
    parentTaskId?: string;
    background: boolean;
    createdBy: Task["createdBy"];
    triggerId?: string;
  }): Task {
    const task = this.d.store.createTask({ ...t });
    this.d.store.addMessage({ conversationId: task.conversationId, role: "user", parts: [{ type: "text", text: t.goal }], status: "complete" });
    this.d.audit.append(t.createdBy === "user" ? "user" : `agent:${t.agentId}`, "task.create", task.id, { title: t.title, background: t.background, triggerId: t.triggerId });
    setImmediate(() => this.scheduleTasks());
    return task;
  }

  cancelTask(id: string): Task | undefined {
    const t = this.d.store.getTask(id);
    if (!t) return undefined;
    this.interrupt(t.conversationId);
    return this.d.store.updateTask(id, { status: "cancelled" });
  }

  retryTask(id: string): Task | undefined {
    const t = this.d.store.getTask(id);
    if (!t) return undefined;
    const r = this.d.store.updateTask(id, { status: "queued", error: undefined, resumeAt: undefined });
    setImmediate(() => this.scheduleTasks());
    return r;
  }

  // ---------- queueing ----------

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  // ---------- tasks ----------

  scheduleTasks(): void {
    const now = Date.now();
    const candidates = this.d.store
      .listTasks({ status: ["queued", "paused"], limit: 100 })
      .filter((t) => t.status === "queued" || (t.resumeAt && Date.parse(t.resumeAt) <= now))
      .reverse();
    for (const t of candidates) {
      if (this.runningTasks.size >= MAX_TASK_CONCURRENCY) break;
      if (this.runningTasks.has(t.id)) continue;
      this.runningTasks.add(t.id);
      void this.enqueue(t.conversationId, () => this.runTask(t)).finally(() => {
        this.runningTasks.delete(t.id);
        setImmediate(() => this.scheduleTasks());
      });
    }
  }

  private budgetOk(agent: AgentDef): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const r = this.d.store.db.prepare("select count from usage where day = ? and agent_id = ? and kind = 'background_run'").get(day, agent.id) as { count: number } | undefined;
    return (r?.count ?? 0) < agent.budget.backgroundRunsPerDay;
  }

  private countUsage(agentId: string, kind: string, tokens = 0): void {
    const day = new Date().toISOString().slice(0, 10);
    this.d.store.db
      .prepare("insert into usage(day, agent_id, kind, count, tokens) values (?,?,?,1,?) on conflict(day, agent_id, kind) do update set count = count + 1, tokens = tokens + excluded.tokens")
      .run(day, agentId, kind, tokens);
  }

  private async runTask(task: Task): Promise<void> {
    const fresh = this.d.store.getTask(task.id);
    if (!fresh || !["queued", "paused"].includes(fresh.status)) return;
    const agent = this.d.agents.get(fresh.agentId);
    const conv = this.d.store.getConversation(fresh.conversationId);
    if (!agent || !conv) {
      this.d.store.updateTask(fresh.id, { status: "failed", error: t("task.missingAgent") });
      return;
    }
    if (fresh.background && !this.budgetOk(agent)) {
      this.d.store.updateTask(fresh.id, { status: "failed", error: t("task.budgetExhausted") });
      await this.d.notifier.notify({
        level: "digest",
        title: t("notify.budgetTitle", { agent: agentName(agent, hubLocale()) }),
        body: t("notify.budgetBody", { title: fresh.title }),
        agentId: agent.id,
      });
      return;
    }
    if (fresh.background) this.countUsage(agent.id, "background_run");
    this.d.store.updateTask(fresh.id, { status: "running", resumeAt: undefined });

    const resumed = fresh.status === "paused" || this.d.store.listMessages(conv.id, { limit: 3 }).some((m) => m.role === "assistant");
    const prompt = resumed
      ? "Continue working on the task from where you stopped."
      : [
          `Task: ${fresh.title}`,
          "",
          fresh.goal,
          "",
          fresh.background
            ? "When you are done, call notify (once) with a short summary of the outcome."
            : "When you are done, briefly describe the result — it will be passed to whoever created the task.",
        ].join("\n");

    const r = await this.runTurn(conv, prompt, { task: fresh });
    const cur = this.d.store.getTask(fresh.id);
    if (!cur || cur.status === "cancelled") return;

    if (r.limited) {
      this.d.store.updateTask(fresh.id, {
        status: "paused",
        resumeAt: r.limited.resetAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
        error: t("task.limitLater"),
      });
      return;
    }
    if (r.error && !r.text) {
      this.d.store.updateTask(fresh.id, { status: "failed", error: r.error });
      if (!fresh.background || fresh.createdBy !== "trigger") {
        await this.d.notifier.notify({ level: "notify", title: t("notify.taskFailed", { title: fresh.title }), body: r.error, agentId: agent.id, taskId: fresh.id });
      }
      return;
    }
    if (r.awaitingApproval) {
      this.d.store.updateTask(fresh.id, { status: "waiting_approval", result: r.text });
      return;
    }
    this.d.store.updateTask(fresh.id, { status: "done", result: r.text, error: undefined });
    await this.reportTaskDone(this.d.store.getTask(fresh.id)!);
  }

  private async reportTaskDone(task: Task): Promise<void> {
    const result = truncate(task.result ?? "", 6000);
    if (task.createdBy === "agent" && task.parentConversationId) {
      const parent = this.d.store.getConversation(task.parentConversationId);
      if (parent) {
        const note = `[System] Delegated task ${task.id} “${task.title}” is finished.\nResult:\n${result}`;
        this.d.store.addMessage({ conversationId: parent.id, role: "system", parts: [{ type: "text", text: note }], status: "complete", taskId: task.id });
        void this.enqueue(parent.id, () => this.runTurn(parent, note, {}));
      }
      return;
    }
    if (task.createdBy === "user") {
      await this.d.notifier.notify({ level: "notify", title: t("notify.taskDone", { title: task.title }), body: result, agentId: task.agentId, taskId: task.id });
    }
    // Trigger tasks report through the agent's own notify() call.
  }

  // ---------- deferred approvals ----------

  private async onDeferredApproved(a: Approval): Promise<void> {
    const result = await this.d.gateway.executeApproved(a);
    const conv = this.d.store.getConversation(a.conversationId);
    if (!conv) return;
    const note = `[System] The user approved the action “${a.summary}”. It has been carried out.\nResult${result.isError ? " (error)" : ""}:\n${truncate(resultText(result), 4000)}`;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete", taskId: a.taskId });
    const task = a.taskId ? this.d.store.getTask(a.taskId) : undefined;
    if (task && task.status === "waiting_approval") {
      this.d.store.updateTask(task.id, { status: "running" });
      void this.enqueue(conv.id, async () => {
        const r = await this.runTurn(conv, note, { task });
        if (!r.awaitingApproval) {
          this.d.store.updateTask(task.id, { status: r.error && !r.text ? "failed" : "done", result: r.text, error: r.error });
          const t = this.d.store.getTask(task.id)!;
          if (t.status === "done") await this.reportTaskDone(t);
        } else this.d.store.updateTask(task.id, { status: "waiting_approval" });
      });
    } else {
      // In a group chat, the member whose action it was carries on.
      void this.enqueue(conv.id, () => this.runTurn(conv, note, conv.kind === "group" ? { agentId: a.agentId } : {}));
    }
  }

  private async onDeferredDenied(a: Approval): Promise<void> {
    const conv = this.d.store.getConversation(a.conversationId);
    if (!conv) return;
    const note = `[System] The user declined the action “${a.summary}”.`;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete", taskId: a.taskId });
    const task = a.taskId ? this.d.store.getTask(a.taskId) : undefined;
    if (task && task.status === "waiting_approval") this.d.store.updateTask(task.id, { status: "done", result: (task.result ?? "") + `\n\n${t("task.declinedSuffix")}` });
  }

  private attachApprovalPart(a: Approval): void {
    const msgId = this.streamingMessage.get(a.conversationId);
    if (!msgId) return;
    const m = this.d.store.getMessage(msgId);
    if (!m) return;
    this.d.store.updateMessage(m.id, { parts: [...m.parts, { type: "approval", approvalId: a.id, summary: a.summary, status: "pending" }] });
  }

  private updateApprovalPart(a: Approval): void {
    const msgs = this.d.store.listMessages(a.conversationId, { limit: 50 });
    for (const m of msgs) {
      if (m.parts.some((p) => p.type === "approval" && p.approvalId === a.id)) {
        this.d.store.updateMessage(m.id, {
          parts: m.parts.map((p) => (p.type === "approval" && p.approvalId === a.id ? { ...p, status: a.status } : p)),
        });
      }
    }
  }

  // ---------- turns ----------

  workspacePath(s: { agentId: string; taskId?: string; conversationId: string }): string {
    return join(this.d.config.dataDir, "workspaces", s.agentId, s.taskId ?? s.conversationId);
  }

  private limitedUntil(ref: string): string | undefined {
    const r = this.d.store.db.prepare("select until from brain_limits where brain_ref = ?").get(formatBrainRef(parseBrainRef(ref))) as { until: string } | undefined;
    return r && Date.parse(r.until) > Date.now() ? r.until : undefined;
  }

  private setLimited(ref: string, until: string, detail: string): void {
    this.d.store.db
      .prepare("insert into brain_limits(brain_ref, until, detail) values (?,?,?) on conflict(brain_ref) do update set until = excluded.until, detail = excluded.detail")
      .run(formatBrainRef(parseBrainRef(ref)), until, detail);
    this.d.bus.emit("brains.updated", {});
  }

  /** Brains of the agent in preference order that are connected, not rate-limited and not saturated. */
  /** Brains to try, in order; `reasons` explain the skipped ones and `hard` counts skips that waiting won't fix. */
  /** The user changed the agent's brains: its open conversations take the new order from their next turn. */
  brainsChanged(agentId: string): void {
    const at = this.d.settings.getKey<Record<string, string>>(BRAINS_CHANGED_KEY, {});
    this.d.settings.setKey(BRAINS_CHANGED_KEY, { ...at, [agentId]: nowIso() });
  }

  private async candidates(agent: AgentDef, preferred?: string): Promise<{ usable: string[]; earliestReset?: string; reasons: string[]; hard: number; setupOnly: boolean }> {
    const ordered = preferred ? [preferred, ...agent.brains.filter((b) => formatBrainRef(parseBrainRef(b)) !== formatBrainRef(parseBrainRef(preferred)))] : agent.brains;
    const usable: string[] = [];
    const reasons: string[] = [];
    let hard = 0;
    // Skips that setting up fixes (not connected, not installed, not signed in), as opposed to limits and load.
    let setup = 0;
    let earliestReset: string | undefined;
    const conc = this.d.settings.get().brainConcurrency;
    for (const ref of ordered) {
      if (!this.d.brains.has(ref)) {
        setup++;
        reasons.push(t("brain.reason.notConnected", { ref }));
        continue;
      }
      const lim = this.limitedUntil(ref);
      if (lim) {
        reasons.push(t("brain.reason.limited", { ref, until: this.formatTime(lim) }));
        if (!earliestReset || lim < earliestReset) earliestReset = lim;
        continue;
      }
      if ((this.brainLoad.get(formatBrainRef(parseBrainRef(ref))) ?? 0) >= conc) {
        reasons.push(t("brain.reason.busy", { ref }));
        continue;
      }
      const p = await this.d.brains.probe(ref);
      if (!p.available || !p.authenticated) {
        hard++;
        setup++;
        reasons.push(p.detail ? t("brain.reason.detail", { ref, detail: p.detail }) : t(p.available ? "brain.reason.notSignedIn" : "brain.reason.unavailable", { ref }));
        continue;
      }
      usable.push(ref);
    }
    return { usable, earliestReset, reasons, hard, setupOnly: ordered.length > 0 && setup === ordered.length };
  }

  /** One setup card per wait: none while the last one still has no answer after it. */
  private addSetupCard(conversationId: string): void {
    const recent = this.d.store.listMessages(conversationId, { limit: 10 });
    const card = recent.findLastIndex((m) => m.parts.some((p) => p.type === "brain_setup"));
    if (card >= 0 && card > recent.findLastIndex((m) => m.role === "assistant")) return;
    this.d.store.addMessage({ conversationId, role: "system", parts: [{ type: "brain_setup" }], status: "complete" });
  }

  /** A moment in the hub's language and time zone, for messages people read. */
  private formatTime(iso: string): string {
    const d = new Date(iso);
    try {
      return d.toLocaleString(hubLocale(), { timeZone: this.d.settings.get().timezone, dateStyle: "short", timeStyle: "short" });
    } catch {
      return d.toLocaleString(hubLocale());
    }
  }

  private async openSession(conv: Conversation, agent: AgentDef, brainRef: string, task: Task | undefined, prior?: SessionRow): Promise<{ row: SessionRow; handle: BrainHandle }> {
    const background = task?.background ?? false;
    const ref = parseBrainRef(brainRef);
    const sameBrain = prior && formatBrainRef(parseBrainRef(prior.brainRef)) === formatBrainRef(ref);
    let row: SessionRow;
    let token: string;
    if (sameBrain && prior) {
      row = prior;
      token = this.d.store.rotateSessionToken(prior.id);
    } else {
      if (prior) this.d.store.updateSession(prior.id, { status: "closed" });
      const created = this.d.store.createSession({ conversationId: conv.id, taskId: task?.id, agentId: agent.id, brainRef: formatBrainRef(ref), background, tainted: prior?.tainted });
      row = created.row;
      token = created.token;
    }

    const local = ref.machineId === "local";
    const workspace = local ? this.workspacePath(row) : `${agent.id}/${task?.id ?? conv.id}`;
    if (local) mkdirSync(workspace, { recursive: true });
    const skills = this.d.skills.forAgent(agent.skills);
    let skillsDir: string | undefined;
    if (local && ref.brainId === "claude-code") skillsDir = join(workspace, ".claude", "skills");
    if (local && ref.brainId === "codex") skillsDir = join(workspace, ".agents", "skills");
    if (skillsDir) this.d.skills.materialize(skillsDir, skills);

    const hook = await this.d.hooks.run("session.start", { sessionId: row.id, agentId: agent.id, conversationId: conv.id, taskId: task?.id, background }, (p) => p);
    const appended = hook.results.map((r) => r?.appendSystemPrompt).filter(Boolean) as string[];
    const s = this.d.settings.get();
    const systemPrompt = buildSystemPrompt({
      agent,
      defaultAgent: agent.id === s.defaultAgent,
      timezone: s.timezone,
      language: s.language,
      consoleUrl: this.d.config.consoleUrl,
      task,
      background,
      skills,
      nativeSkills: !!skillsDir,
      appended,
      machineName: local ? undefined : this.d.machineName(ref.machineId),
      setup: background || task ? undefined : await this.d.setup?.promptBlock(agent.id),
      group: conv.kind === "group" ? { title: conv.title, members: this.groupMembers(conv) } : undefined,
    });

    const env: Record<string, string> = {};
    if (local) {
      this.d.egress.revokeOwner(`brain:${row.id}`);
      const proxyToken = this.d.egress.issueToken(`brain:${row.id}`, DEFAULT_BRAIN_EGRESS);
      const proxy = `http://${proxyToken}:x@127.0.0.1:${this.d.config.egressPort}`;
      Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
    }

    const handle = await this.d.brains.create(formatBrainRef(ref), {
      sessionId: row.id,
      agent,
      variant: ref.variant,
      model: agent.model,
      workspace,
      mcp: {
        url: `${local ? this.d.config.internalUrl : this.d.config.publicUrl}/mcp`,
        token,
        bridgeCommand: local ? [process.execPath, "--disable-warning=ExperimentalWarning", join(this.d.config.appRoot, "packages", "mcp-bridge", "src", "index.ts")] : [],
      },
      systemPrompt,
      skillsDir,
      claudePluginDirs: local && ref.brainId === "claude-code" ? this.d.claudePluginDirs() : [],
      resume: sameBrain ? prior?.resumeToken : undefined,
      env,
      background,
    });
    this.live.set(row.id, { handle, brainRef: formatBrainRef(ref), stamp: sessionStamp(agent, conv) });
    if (!sameBrain) this.d.audit.append("core", "session.open", row.id, { agent: agent.id, brain: formatBrainRef(ref), conversation: conv.id, task: task?.id });
    return { row, handle };
  }

  /** Text transcript of recent messages for handing a conversation to a different brain. */
  private handoffSummary(conversationId: string): string {
    const msgs = this.d.store.listMessages(conversationId, { limit: 30 });
    // In a group chat every member speaks under its own name.
    const group = this.d.store.getConversation(conversationId)?.kind === "group";
    const speaker = (m: Message) => {
      if (m.role !== "assistant") return m.role === "user" ? "User" : "System";
      const a = group && m.agentId ? this.d.agents.get(m.agentId) : undefined;
      return a ? agentName(a, hubLocale()) : group && m.agentId ? m.agentId : "Assistant";
    };
    const lines: string[] = [];
    for (const m of msgs) {
      const t = m.parts
        .map((p) =>
          p.type === "text"
            ? p.text
            : p.type === "tool_call"
              ? `[called ${p.name}]`
              : p.type === "notification"
                ? `[notification: ${p.title}]`
                : p.type === "images"
                  ? `[showed ${p.items.length} image(s)${p.items.some((it) => it.caption) ? `: ${p.items.map((it) => it.caption ?? "").filter(Boolean).join("; ")}` : ""}]`
                  : p.type === "map"
                    ? `[showed a map${p.title ? ` of ${p.title}` : ""} at ${p.lat}, ${p.lon}]`
                    : "",
        )
        .filter(Boolean)
        .join(" ");
      if (t) lines.push(`${speaker(m)}: ${truncate(t, 800)}`);
    }
    return this.d.redactor.text(lines.join("\n"));
  }

  async runTurn(conv: Conversation, prompt: string, opts: TurnOpts): Promise<TurnResult> {
    this.setTurning(conv.id, 1);
    try {
      return await this.turn(conv, prompt, opts);
    } finally {
      this.setTurning(conv.id, -1);
    }
  }

  /**
   * Where a finished reply goes besides the web UI: back to the channel the message came from; or, in the default
   * agent's dialog, to every channel, so the user follows the main agent on the phone too (setting channelMirror).
   */
  private async deliver(conv: Conversation, text: string, opts: TurnOpts, messageId?: string): Promise<void> {
    const ch = opts.replyChannel;
    const toChannel = !!ch && ch !== WEB_CHANNEL;
    // Typed in the web UI, or a turn nobody typed (a task finished, a system note): only the default agent's dialog is mirrored.
    const s = this.d.settings.get();
    const mirror = conv.kind === "main" && conv.agentId === s.defaultAgent && s.channelMirror !== false && this.d.channels.list().length > 0;
    if (toChannel ? !this.d.channels.has(ch) : !mirror) return;
    const media = await this.replyMedia(messageId);
    if (!text && !media.length) return;
    const path = conv.kind === "main" ? `agent/${encodeURIComponent(conv.agentId)}` : conv.taskId ? `tasks/${encodeURIComponent(conv.taskId)}` : `chat/${encodeURIComponent(conv.id)}`;
    const reply: OutboundMessage = { kind: "reply", text, conversationId: conv.id, link: `${this.d.config.publicUrl}/${path}`, ...(media.length ? { media } : {}) };
    if (toChannel) await this.d.channels.send(ch, reply);
    else await this.d.channels.broadcast(opts.quote ? { ...reply, quote: opts.quote } : reply);
  }

  /** The reply's images and maps for the channels: web images by address, workspace files inline (10 MB each, 40 MB in all). */
  private async replyMedia(messageId: string | undefined): Promise<OutboundMedia[]> {
    const parts = (messageId ? this.d.store.getMessage(messageId)?.parts : undefined) ?? [];
    const out: OutboundMedia[] = [];
    let inline = 0;
    for (const p of parts) {
      if (p.type === "map") out.push({ kind: "map", lat: p.lat, lon: p.lon, ...(p.title ? { title: p.title } : {}) });
      if (p.type !== "images") continue;
      for (const it of p.items) {
        const caption = it.caption ? { caption: it.caption } : {};
        if (/^https?:\/\//i.test(it.src)) {
          out.push({ kind: "image", url: it.src, ...caption });
          continue;
        }
        if (!it.src.startsWith("file:")) continue;
        const file = await readWorkspaceImage(join(this.d.config.dataDir, "workspaces"), it.src.slice("file:".length));
        if (!file || inline + file.data.length > MAX_INLINE_MEDIA_BYTES) continue;
        inline += file.data.length;
        out.push({ kind: "image", data: file.data.toString("base64"), mimeType: file.type, name: file.name, ...caption });
      }
    }
    return out;
  }

  private async turn(conv: Conversation, prompt: string, opts: TurnOpts): Promise<TurnResult> {
    const agent = this.d.agents.get(opts.agentId ?? conv.agentId) ?? this.d.agents.get(this.d.settings.get().defaultAgent)!;
    const task = opts.task ?? (conv.taskId ? this.d.store.getTask(conv.taskId) : undefined);
    const prior = this.d.store.activeSession(conv.id, agent.id);
    // The conversation stays on the brain it fell back to, until the user changes the agent's brains after that.
    const changedAt = this.d.settings.getKey<Record<string, string>>(BRAINS_CHANGED_KEY, {})[agent.id];
    const stay = prior && !(changedAt && changedAt > prior.createdAt) ? prior.brainRef : undefined;
    const tried = new Set<string>();
    let handoff = false;
    let lastError = "";
    let earliestReset: string | undefined;

    for (let attempt = 0; attempt < 6; attempt++) {
      const { usable, earliestReset: reset, reasons, hard, setupOnly } = await this.candidates(agent, stay);
      earliestReset = reset ?? earliestReset;
      const ref = usable.find((r) => !tried.has(formatBrainRef(parseBrainRef(r))));
      // No brain of the agent is set up yet: the setup card instead of an error, and the message waits for a brain.
      // (A group chat's round goes on with the next member instead.)
      if (!ref && setupOnly && !tried.size && !task && this.d.setup && conv.kind !== "group") {
        this.d.setup.hold(conv.id, agent.id, prompt, { replyChannel: opts.replyChannel, quote: opts.quote, attachments: opts.attachments, speech: opts.speech });
        this.addSetupCard(conv.id);
        return { text: "", error: t("chat.needsBrain"), awaitingApproval: false };
      }
      if (!ref) {
        const why = reasons.length ? reasons.join("; ") : lastError || t("chat.noSuitableBrains");
        const allLimited = earliestReset && usable.length === 0 && hard === 0;
        const message = allLimited
          ? t("chat.allLimited", { time: this.formatTime(earliestReset!) })
          : t("chat.cannotStart", { agent: agentName(agent, hubLocale()), reason: why });
        this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "error", message }], status: "complete", taskId: task?.id });
        return { text: "", error: message, limited: allLimited ? { resetAt: earliestReset } : undefined, awaitingApproval: false };
      }
      const key = formatBrainRef(parseBrainRef(ref));
      tried.add(key);

      const curPrior = this.d.store.activeSession(conv.id, agent.id);
      let live = curPrior ? this.live.get(curPrior.id) : undefined;
      let row = curPrior;
      try {
        if (!live || live.brainRef !== key || live.stamp !== sessionStamp(agent, conv)) {
          // The same brain resumes the same conversation with the new instructions: let the old process finish first.
          if (live && curPrior) {
            if (live.brainRef === key) await this.closeLive(curPrior.id);
            else void this.closeLive(curPrior.id);
          }
          const opened = await this.openSession(conv, agent, ref, task, curPrior);
          row = opened.row;
          live = this.live.get(row.id)!;
          handoff = !!curPrior && formatBrainRef(parseBrainRef(curPrior.brainRef)) !== key;
        }
      } catch (e: any) {
        lastError = `${ref}: ${e.message}`;
        this.d.brains.invalidate(ref);
        continue;
      }

      let text = prompt;
      if (conv.kind === "group") {
        text = this.groupText(conv, agent, prompt, opts, handoff);
        handoff = false;
      } else if (handoff) {
        text = `[System] This conversation continues on a different brain. Recent history:\n${this.handoffSummary(conv.id)}\n\n---\n${prompt}`;
        handoff = false;
      }

      let paths: string[] = [];
      if (opts.attachments?.length) {
        const local = parseBrainRef(row!.brainRef).machineId === "local";
        const seen = local ? forSession(opts.attachments, join(this.d.config.dataDir, "workspaces"), this.workspacePath(row!)) : opts.attachments.map((part): SessionFile => ({ part }));
        const files = seen.map((f) => (opts.speech?.[f.part.path] ? { ...f, speech: opts.speech[f.part.path] } : f));
        text = [text, attachmentNote(files, { remote: !local })].filter(Boolean).join("\n\n");
        paths = files.flatMap((f) => (f.path ? [f.path] : []));
      }
      const now = this.clock.line(row!.id, this.d.settings.get().timezone);
      if (now) text = `${now}\n${text}`;

      this.brainLoad.set(key, (this.brainLoad.get(key) ?? 0) + 1);
      try {
        const r = await this.streamTurn(conv, row!, live!, agent, { text, ...(paths.length ? { attachments: paths } : {}) }, task, opts.replyChannel);
        if (r.retry) {
          lastError = r.error ?? lastError;
          if (r.limited) earliestReset = r.limited.resetAt ?? earliestReset;
          void this.closeLive(row!.id);
          continue;
        }
        // Group chats live in the web UI only.
        if (conv.kind !== "group") await this.deliver(conv, r.answer ?? r.text, opts, r.messageId);
        return r;
      } finally {
        this.brainLoad.set(key, Math.max(0, (this.brainLoad.get(key) ?? 1) - 1));
      }
    }
    return { text: "", error: lastError || t("chat.turnFailed"), awaitingApproval: false };
  }

  private async streamTurn(
    conv: Conversation,
    row: SessionRow,
    live: Live,
    agent: AgentDef,
    turn: BrainTurn,
    task: Task | undefined,
    replyChannel?: string,
  ): Promise<TurnResult & { retry?: boolean }> {
    const msg = this.d.store.addMessage({ conversationId: conv.id, role: "assistant", parts: [], status: "streaming", agentId: agent.id, taskId: task?.id, brainRef: live.brainRef, channel: replyChannel });
    this.streamingMessage.set(conv.id, msg.id);
    this.activeTurns.set(conv.id, { sessionId: row.id, handle: live.handle });

    let parts: MessagePart[] = [];
    let fullText = "";
    let lastFlush = 0;
    let produced = false;
    let error: string | undefined;
    let fatal = false;
    let limited: { resetAt?: string } | undefined;
    let resumeToken: string | undefined;
    let awaitingApproval = false;
    let tokens = 0;

    const current = () => this.d.store.getMessage(msg.id)?.parts ?? parts;
    const flush = (force = false) => {
      const now = Date.now();
      if (!force && now - lastFlush < 400) return;
      lastFlush = now;
      // Keep cards (approvals, secret requests, setup) that were attached or updated concurrently.
      parts = mergeAttached(parts, current());
      this.d.store.updateMessage(msg.id, { parts }, force);
    };

    const onEvent = (e: BrainEvent) => {
      switch (e.type) {
        case "text": {
          const delta = this.d.redactor.text(e.delta);
          produced = true;
          fullText += delta;
          const last = parts[parts.length - 1];
          if (last && last.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + delta };
          else parts.push({ type: "text", text: delta });
          this.d.bus.emit("message.delta", { id: msg.id, conversationId: conv.id, delta });
          flush();
          break;
        }
        case "tool_call": {
          produced = true;
          parts.push({ type: "tool_call", id: e.id, name: e.name, input: this.d.redactor.value(e.input) });
          if (NATIVE_SOURCE_TOOLS.test(e.name) && !row.tainted) {
            this.d.store.updateSession(row.id, { tainted: true });
            row.tainted = true;
          }
          flush(true);
          break;
        }
        case "tool_result": {
          const out = this.d.redactor.text(e.output);
          if (/awaiting_approval/.test(out)) awaitingApproval = true;
          parts.push({ type: "tool_result", id: e.id, output: truncate(out, 4000), isError: e.isError });
          flush(true);
          break;
        }
        case "usage":
          tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
          break;
        case "limit_hit":
          limited = { resetAt: e.resetAt };
          error = t("brain.limitDetail", { detail: e.detail ?? "" });
          break;
        case "error":
          error = e.message;
          if (e.fatal) fatal = true;
          break;
        case "done":
          resumeToken = e.resumeToken;
          break;
      }
    };

    try {
      await live.handle.send(turn, onEvent);
    } catch (e: any) {
      error = e.message;
      fatal = true;
    } finally {
      this.activeTurns.delete(conv.id);
      this.streamingMessage.delete(conv.id);
    }

    if (resumeToken) this.d.store.updateSession(row.id, { resumeToken });
    this.countUsage(agent.id, "turn", tokens);

    // Pending approvals from this session also mean we are waiting.
    if (!awaitingApproval) {
      awaitingApproval = !!this.d.store.db.prepare("select 1 from approvals where session_id = ? and status = 'pending' limit 1").get(row.id);
    }

    if (limited) {
      this.setLimited(live.brainRef, limited.resetAt ?? new Date(Date.now() + 60 * 60_000).toISOString(), error ?? "limit");
    }

    // Nothing produced and the brain failed or is limited: let the caller try the next brain.
    if (!produced && (limited || fatal)) {
      this.d.store.updateMessage(msg.id, { parts: [{ type: "error", message: t("chat.tryingOtherBrain", { ref: live.brainRef, error: error ?? t("chat.error") }) }], status: "error" });
      if (fatal && !limited) this.d.brains.invalidate(live.brainRef);
      return { text: "", error, limited, awaitingApproval: false, retry: true };
    }

    if (error) parts.push({ type: "error", message: error });
    parts = mergeAttached(parts, current());
    this.d.store.updateMessage(msg.id, { parts, status: error && !produced ? "error" : "complete" });
    return { text: fullText.trim(), answer: finalAnswer(parts), error, limited, awaitingApproval, messageId: msg.id };
  }
}

/** What a live session was opened with: a changed agent, or a group's new members, get a fresh session (resumed). */
function sessionStamp(agent: AgentDef, conv: Conversation): string {
  const stamp = JSON.stringify(agent);
  return conv.kind === "group" ? `${stamp}|${conv.title}|${(conv.members ?? []).join(",")}` : stamp;
}

/** Parts the hub adds to a message from outside the brain stream: cards (some with their own live status), images, maps. */
function attachedKey(p: MessagePart): string | undefined {
  if (p.type === "approval") return `approval:${p.approvalId}`;
  if (p.type === "secret_request") return `secret:${p.requestId}`;
  if (p.type === "plugin_setup") return `setup:${p.pluginId}`;
  if (p.type === "agent_draft") return `draft:${p.draftId}`;
  if (p.type === "brain_login") return `login:${p.ref}`;
  if (p.type === "device_pairing") return "device_pairing";
  // Pictures and maps carry no id: the same content shown twice in one reply is one card.
  if (p.type === "images") return `images:${JSON.stringify(p.items)}`;
  if (p.type === "map") return `map:${JSON.stringify([p.lat, p.lon, p.zoom, p.title, p.markers])}`;
  return undefined;
}

/** The streamed parts with the stored version of every card (newer status) and any card attached meanwhile. */
function mergeAttached(local: MessagePart[], stored: MessagePart[]): MessagePart[] {
  const cards = new Map<string, MessagePart>();
  for (const p of stored) {
    const k = attachedKey(p);
    if (k) cards.set(k, p);
  }
  const out = local.map((p) => {
    const k = attachedKey(p);
    return k && cards.has(k) ? cards.get(k)! : p;
  });
  for (const [k, p] of cards) if (!out.some((q) => attachedKey(q) === k)) out.push(p);
  return out;
}

/**
 * The reply as the channels get it: the text after the brain's last tool call. Its narration around the tools
 * ("let me look…") stays in the web UI with the tool calls.
 */
function finalAnswer(parts: MessagePart[]): string {
  const texts = (from: number) => parts.slice(from).flatMap((p) => (p.type === "text" ? [p.text] : []));
  const lastTool = parts.findLastIndex((p) => p.type === "tool_call" || p.type === "tool_result");
  const tail = texts(lastTool + 1).join("").trim();
  // Answered, then called a tool and said nothing more: the answer is the last thing it said.
  return tail || (texts(0).findLast((s) => s.trim()) ?? "").trim();
}

function resultText(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

export { newId, nowIso };
