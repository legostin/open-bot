// Rendering of one message and its parts. Plugins can override whole messages (chat.message) or tool cards
// (chat.toolResult); overrides run inside an error boundary that falls back to the core rendering.

import { memo } from "react";
import { Bell, CircleAlert, ExternalLink, FileText, Mic, ShieldAlert } from "lucide-react";
import type { AgentDef, ApprovalStatus, Message, MessagePart } from "@owlbot/shared";
import { groupParts } from "../../lib/parts";
import { fileSize, formatDuration, formatTime, notifyLevel } from "../../lib/format";
import { useStore } from "../../lib/store";
import { session } from "../../state/app";
import { showDetails } from "../../state/prefs";
import { Markdown } from "../../components/markdown";
import { Badge, cx } from "../../components/ui";
import { AgentAvatar } from "../../components/AgentAvatar";
import { PluginBoundary } from "../../plugins/boundary";
import { pickMessageRenderer, pickToolRenderer } from "../../plugins/registry";
import { usePluginRegistry } from "../../plugins/slots";
import { ToolCard } from "./ToolCard";
import { PluginSetupCard, SecretRequestCard } from "../../components/SecretCards";
import { AgentDraftCard } from "./AgentDraftCard";
import { BrainLoginCard } from "../../components/BrainLoginCard";
import { BrainSetupCard } from "../../components/BrainSetupCard";
import { ImagesCard } from "./ImagesCard";
import { MapCard } from "./MapCard";
import { t, type MessageKey } from "../../i18n";

const APPROVAL: Record<ApprovalStatus, { label: MessageKey; tone: "warning" | "success" | "danger" | "neutral" | "info" }> = {
  pending: { label: "approvalStatus.pending", tone: "warning" },
  approved: { label: "approvalStatus.approved", tone: "success" },
  denied: { label: "approvalStatus.denied", tone: "danger" },
  expired: { label: "approvalStatus.expired", tone: "neutral" },
  executed: { label: "approvalStatus.executed", tone: "success" },
  failed: { label: "approvalStatus.failed", tone: "danger" },
};

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
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <div className="mt-1.5 text-sm break-words">{part.summary}</div>
      {s && (
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
      {part.body && <Markdown text={part.body} className="mt-1.5 text-sm" />}
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
            return message.role === "user" ? (
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
          case "brain_setup":
            return <BrainSetupCard key={it.key} conversationId={message.conversationId} />;
          default:
            return null;
        }
      })}
      {streaming && (items.length === 0 || items[items.length - 1].kind !== "part") && <TypingDots />}
    </>
  );
}

/** Core rendering of a message (also passed to chat.message overrides as `Default`). */
export const DefaultMessage = memo(function DefaultMessage({ message, agentName, agent }: { message: Message; agentName?: string; agent?: AgentDef }) {
  const details = useStore(showDetails);
  const name = agentName ?? agent?.name ?? message.agentId ?? t("message.assistant");
  // A finished message with nothing for the person (only tool calls, or a note for the model) is not shown at all.
  if (message.status !== "streaming" && !message.parts.some((p) => partShown(p, message.role, details))) return null;
  if (message.role === "user") {
    return (
      <div className="animate-in flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-user-bubble px-3.5 py-2 text-user-bubble-fg text-[15px] leading-relaxed sm:max-w-[75%]">
          <Parts message={message} />
          <div className="mt-0.5 text-right text-[11px] text-muted">
            {message.channel && message.channel !== "web" ? `${message.channel} · ` : ""}
            {formatTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div className="animate-in mx-auto w-full max-w-[640px] text-sm">
        <Parts message={message} />
      </div>
    );
  }
  return (
    <div className="animate-in flex gap-2.5">
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
