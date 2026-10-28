// Rendering of one message and its parts. Plugins can override whole messages (chat.message) or tool cards
// (chat.toolResult); overrides run inside an error boundary that falls back to the core rendering.

import { memo, useState } from "react";
import { Bell, Check, CircleAlert, CornerUpLeft, ExternalLink, FileText, Mic, ShieldAlert, X } from "lucide-react";
import type { AgentDef, ApprovalStatus, Message, MessagePart } from "@owlbot/shared";
import { groupParts } from "../../lib/parts";
import { fileSize, formatDuration, formatTime, notifyLevel } from "../../lib/format";
import { useStore } from "../../lib/store";
import { native, nativeErrorText, type NativeBridge } from "../../lib/native";
import { session } from "../../state/app";
import { showDetails } from "../../state/prefs";
import { Markdown } from "../../components/markdown";
import { Badge, Button, cx } from "../../components/ui";
import { AgentAvatar } from "../../components/AgentAvatar";
import { PluginBoundary } from "../../plugins/boundary";
import { pickMessageRenderer, pickToolRenderer } from "../../plugins/registry";
import { usePluginRegistry } from "../../plugins/slots";
import { ToolCard } from "./ToolCard";
import { PluginSetupCard, SecretRequestCard } from "../../components/SecretCards";
import { AgentDraftCard } from "./AgentDraftCard";
import { BrainLoginCard } from "../../components/BrainLoginCard";
import { BrainSetupCard } from "../../components/BrainSetupCard";
import { IntegrationChatCard } from "../../components/IntegrationCard";
import { ImagesCard } from "./ImagesCard";
import { MapCard } from "./MapCard";
import { NewsCard } from "./NewsCard";
import { Choices, FeedCard } from "./ChatButtons";
import { ThinkingCard } from "./ThinkingCard";
import { PageCard } from "./PageCard";
import { TaskLine } from "./TaskLine";
import { ConnectDeviceCard } from "./ConnectDeviceCard";
import { t, type MessageKey } from "../../i18n";
import { mobileMode } from "../../lib/mobile";

const APPROVAL: Record<ApprovalStatus, { label: MessageKey; tone: "warning" | "success" | "danger" | "neutral" | "info" }> = {
  pending: { label: "approvalStatus.pending", tone: "warning" },
  approved: { label: "approvalStatus.approved", tone: "success" },
  denied: { label: "approvalStatus.denied", tone: "danger" },
  expired: { label: "approvalStatus.expired", tone: "neutral" },
  executed: { label: "approvalStatus.executed", tone: "success" },
  failed: { label: "approvalStatus.failed", tone: "danger" },
};

type Answer = "approve" | "deny";

/**
 * Inside the iOS app: answer the approval on the phone. The app loads it from the hub, asks for Face ID and signs
 * the answer; backing out of Face ID ({ cancelled }) just puts the buttons back. The card's status follows once the
 * hub has the answer.
 */
function NativeApprovalActions({ approvalId, bridge }: { approvalId: string; bridge: NativeBridge }) {
  const [busy, setBusy] = useState<Answer | null>(null);
  const [sent, setSent] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (kind: Answer) => {
    setBusy(kind);
    setError(null);
    try {
      const r = kind === "approve" ? await bridge.approve(approvalId) : await bridge.deny(approvalId);
      if (r.ok) setSent(kind);
    } catch (e) {
      setError(t("message.approval.failed", { error: nativeErrorText(e) }));
    } finally {
      setBusy(null);
    }
  };
  if (sent)
    return (
      <div className={cx("mt-2 flex items-center gap-1.5 text-[13px] font-medium", sent === "approve" ? "text-success" : "text-danger")} role="status">
        {sent === "approve" ? <Check className="size-4" /> : <X className="size-4" />}
        {sent === "approve" ? t("message.approval.approvedHere") : t("message.approval.deniedHere")}
      </div>
    );
  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" loading={busy === "approve"} disabled={busy !== null} onClick={() => void answer("approve")}>
          {t("message.approval.approve")}
        </Button>
        <Button variant="secondary" className="flex-1" loading={busy === "deny"} disabled={busy !== null} onClick={() => void answer("deny")}>
          {t("message.approval.deny")}
        </Button>
      </div>
      {error && (
        <div className="text-xs break-words text-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ part }: { part: Extract<MessagePart, { type: "approval" }> }) {
  const s = useStore(session);
  const known = APPROVAL[part.status];
  const st = known ? { label: t(known.label), tone: known.tone } : { label: part.status, tone: "neutral" as const };
  const pending = part.status === "pending";
  return (
    <div className={cx("my-2 rounded-xl border px-3 py-2.5", pending ? "border-warning/40 bg-warning-soft/60" : "border-border bg-surface-2/60")}>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className={cx("size-4", pending ? "text-warning" : "text-muted")} />
        <span className="text-sm font-semibold">{pending ? t("message.approval.titlePending") : t("message.approval.title")}</span>
        {/* "Awaiting approval" is already the title. */}
        {!pending && <Badge tone={st.tone}>{st.label}</Badge>}
      </div>
      <div className="mt-1.5 text-sm break-words">{part.summary}</div>
      {/* On the phone the answer is given here (Face ID); the security console stays on the computer. */}
      {native && pending && <NativeApprovalActions approvalId={part.approvalId} bridge={native} />}
      {s && !native && (
        <a
          href={`${s.consoleUrl}/#/approvals/${encodeURIComponent(part.approvalId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-surface px-2.5 py-1.5 text-[13px] font-medium text-accent-text shadow-sm transition hover:bg-surface-2"
        >
          {pending ? t("message.approval.open") : t("message.approval.details")} <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

function NotificationCard({ part }: { part: Extract<MessagePart, { type: "notification" }> }) {
  const lvl = notifyLevel(part.level);
  return (
    <div className="my-2 rounded-xl border border-accent/25 bg-accent-soft/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Bell className="size-4 text-accent-text" />
        <span className="text-sm font-semibold">{part.title}</span>
        <Badge tone={lvl.tone}>{lvl.label}</Badge>
      </div>
      {/* The hub's own lines (a digest's items, a calendar section) keep their breaks. */}
      {part.body && <Markdown text={part.body} className="mt-1.5 text-sm" user />}
    </div>
  );
}

function ErrorPart({ message }: { message: string }) {
  return (
    <div className="my-1.5 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
    </div>
  );
}

function Attachment({ part }: { part: Extract<MessagePart, { type: "attachment" }> }) {
  const href = `/api/files?path=${encodeURIComponent(part.path)}`;
  const isImage = part.mimeType?.startsWith("image/");
  const isAudio = part.mimeType?.startsWith("audio/");
  const voice = part.kind === "voice";
  const meta = [part.durationSec !== undefined ? formatDuration(part.durationSec) : undefined, part.size !== undefined ? fileSize(part.size) : part.mimeType].filter(Boolean).join(" · ");
  return (
    <div className="my-1.5">
      {isImage && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="mb-1 block">
          <img src={href} alt={part.name} className="max-h-72 max-w-full rounded-xl border border-border" loading="lazy" />
        </a>
      )}
      {isAudio && <audio controls preload="none" src={href} className="mb-1 h-10 w-72 max-w-full" />}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg transition hover:bg-surface-2"
      >
        {voice ? <Mic className="size-4 shrink-0 text-muted" /> : <FileText className="size-4 shrink-0 text-muted" />}
        <span className="min-w-0 truncate font-medium">{voice ? t("message.voice") : part.name || part.path}</span>
        {meta && <span className="shrink-0 text-xs text-muted">{meta}</span>}
      </a>
      {part.transcript && <p className="mt-1.5 max-w-prose whitespace-pre-wrap">{part.transcript}</p>}
    </div>
  );
}

/** The person's message this reply answers (a task's report after the talk moved on): a click scrolls to it. */
function ReplyQuote({ part }: { part: Extract<MessagePart, { type: "reply_to" }> }) {
  const jump = () => {
    const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(part.messageId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("reply-flash");
    void el.offsetWidth;
    el.classList.add("reply-flash");
  };
  return (
    <button
      type="button"
      onClick={jump}
      title={t("message.replyTo")}
      className="mb-1 flex max-w-full items-center gap-1.5 rounded-lg border-l-2 border-accent bg-surface-2 py-1 pr-2.5 pl-2 text-left text-[13px] text-muted transition hover:text-fg"
    >
      <CornerUpLeft className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{part.text}</span>
    </button>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-2" aria-label={t("message.typing")}>
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
      <span className="typing-dot size-1.5 rounded-full bg-muted" />
    </span>
  );
}

/**
 * Without detailed mode the chat shows only what is meant for the person: answers, cards, errors, files.
 * Tool calls and results, and text in system messages (notes for the model, "[System] …"), are service details.
 */
function partShown(p: MessagePart, role: Message["role"], details: boolean): boolean {
  if (details) return true;
  if (p.type === "tool_call" || p.type === "tool_result") return false;
  return !(role === "system" && p.type === "text");
}

function Parts({ message }: { message: Message }) {
  const { contributions } = usePluginRegistry();
  const details = useStore(showDetails);
  const items = groupParts(message.parts);
  const streaming = message.status === "streaming";
  const lastPart = message.parts[message.parts.length - 1];
  return (
    <>
      {items.map((it, idx) => {
        if (!details && it.kind !== "part") return null;
        if (it.kind === "part" && !partShown(it.part, message.role, details)) return null;
        if (it.kind === "tool") {
          const running = streaming && !it.result;
          const plugin = pickToolRenderer(contributions, it.call.name);
          const core = <ToolCard call={it.call} result={it.result} running={running} />;
          if (!plugin) return <div key={it.key}>{core}</div>;
          const C = plugin.component;
          return (
            <PluginBoundary key={it.key} pluginId={plugin.pluginId} fallback={core}>
              <C pluginId={plugin.pluginId} call={it.call} result={it.result} message={message} />
            </PluginBoundary>
          );
        }
        if (it.kind === "orphan_result") return <ToolCard key={it.key} result={it.result} />;
        const p = it.part;
        switch (p.type) {
          case "text": {
            const caret = streaming && idx === items.length - 1 && lastPart?.type === "text";
            return message.role === "user" && !message.agentId ? (
              <Markdown key={it.key} text={p.text} className="md-bubble" user />
            ) : (
              <Markdown key={it.key} text={p.text} className={cx(caret && "stream-caret")} />
            );
          }
          case "approval":
            return <ApprovalCard key={it.key} part={p} />;
          case "notification":
            return <NotificationCard key={it.key} part={p} />;
          case "error":
            return <ErrorPart key={it.key} message={p.message} />;
          case "attachment":
            return <Attachment key={it.key} part={p} />;
          case "images":
            return <ImagesCard key={it.key} items={p.items} />;
          case "map":
            return <MapCard key={it.key} part={p} />;
          case "secret_request":
            return <SecretRequestCard key={it.key} part={p} />;
          case "plugin_setup":
            return <PluginSetupCard key={it.key} pluginId={p.pluginId} />;
          case "agent_draft":
            return <AgentDraftCard key={it.key} draftId={p.draftId} messageId={message.id} />;
          case "brain_login":
            return <BrainLoginCard key={it.key} brainRef={p.ref} />;
          case "integration":
            return <IntegrationChatCard key={it.key} id={p.id} conversationId={message.conversationId} />;
          case "brain_setup":
            return <BrainSetupCard key={it.key} conversationId={message.conversationId} />;
          case "device_pairing":
            return <ConnectDeviceCard key={it.key} />;
          case "task":
            return <TaskLine key={it.key} taskId={p.taskId} text={p.text} reply={p.reply} from={message.agentId} />;
          case "reply_to":
            return <ReplyQuote key={it.key} part={p} />;
          case "news":
            return <NewsCard key={it.key} part={p} />;
          case "choices":
            return <Choices key={it.key} part={p} messageId={message.id} />;
          case "feed":
            return <FeedCard key={it.key} feedId={p.feedId} />;
          case "thinking":
            return <ThinkingCard key={it.key} agentId={p.agentId} />;
          case "page":
            return <PageCard key={it.key} pageId={p.pageId} conversationId={message.conversationId} />;
          default:
            return null;
        }
      })}
      {streaming && (items.length === 0 || items[items.length - 1].kind !== "part") && <TypingDots />}
    </>
  );
}

/** Where a person's message came from, before its time: nothing for the web UI, and on the phone nothing for the phone. */
function channelLabel(channel: string | undefined): string {
  if (!channel || channel === "web" || (channel === "app" && mobileMode)) return "";
  return `${channel === "app" ? t("message.fromPhone") : channel} · `;
}

/** Core rendering of a message (also passed to chat.message overrides as `Default`). */
export const DefaultMessage = memo(function DefaultMessage({ message, agentName, agent }: { message: Message; agentName?: string; agent?: AgentDef }) {
  const details = useStore(showDetails);
  const name = agentName ?? agent?.name ?? message.agentId ?? t("message.assistant");
  // A finished message with nothing for the person (only tool calls, or a note for the model) is not shown at all.
  if (message.status !== "streaming" && !message.parts.some((p) => p.type !== "reply_to" && partShown(p, message.role, details))) return null;
  // A teammate writing in a thread is a user-role message with its agent: it reads as that agent's message.
  if (message.role === "user" && !message.agentId) {
    return (
      <div className="animate-in flex justify-end" data-message-id={message.id}>
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-user-bubble px-3.5 py-2 text-user-bubble-fg text-[15px] leading-relaxed sm:max-w-[75%]">
          <Parts message={message} />
          <div className="mt-0.5 text-right text-[11px] text-muted">
            {channelLabel(message.channel)}
            {formatTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div className="animate-in mx-auto w-full max-w-[640px] text-sm" data-message-id={message.id}>
        <Parts message={message} />
      </div>
    );
  }
  return (
    <div className="animate-in flex gap-2.5" data-message-id={message.id}>
      <AgentAvatar avatar={agent?.avatar} id={message.agentId} name={name} size={28} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="font-medium text-fg">{name}</span>
          {details && message.brainRef && <span className="font-mono">{message.brainRef}</span>}
          <span>{formatTime(message.createdAt)}</span>
        </div>
        <div className="text-[15px] leading-relaxed">
          <Parts message={message} />
        </div>
      </div>
    </div>
  );
});

function DefaultMessageForPlugins({ message }: { message: Message }) {
  return <DefaultMessage message={message} />;
}

export function MessageView({ message, agent }: { message: Message; agent?: AgentDef }) {
  const { contributions } = usePluginRegistry();
  const override = pickMessageRenderer(contributions, message);
  const core = <DefaultMessage message={message} agentName={agent?.name} agent={agent} />;
  if (!override) return core;
  const C = override.component;
  return (
    <PluginBoundary pluginId={override.pluginId} fallback={core}>
      <C pluginId={override.pluginId} message={message} Default={DefaultMessageForPlugins} />
    </PluginBoundary>
  );
}
