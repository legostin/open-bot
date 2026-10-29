// Rendering of one message and its parts. Plugins can override whole messages (chat.message) or tool cards
// (chat.toolResult); overrides run inside an error boundary that falls back to the core rendering.

import { memo, useEffect, useState } from "react";
import { Bell, Check, CircleAlert, CornerUpLeft, FilePen, FileText, Mic, ShieldAlert, SquareTerminal, X } from "lucide-react";
import type { AgentDef, ApprovalStatus, Message, MessagePart } from "@owlbot/shared";
import { groupParts } from "../../lib/parts";
import { fileSize, formatDuration, formatTime, notifyLevel } from "../../lib/format";
import { useStore } from "../../lib/store";
import { native, nativeErrorText, type NativeBridge } from "../../lib/native";
import { session } from "../../state/app";
import { api, errorText } from "../../lib/api";
import { approvalLink, desktopApp, DESKTOP_EVENT, type DesktopApprovalEvent } from "../../lib/desktop";
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
import { WidgetCard } from "./WidgetCard";
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
    <div className="mt-3 flex flex-col gap-1.5">
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

/** The card's words for what the agent asks: a plain headline in the viewer's language and the detail as is. */
function approvalWords(part: Extract<MessagePart, { type: "approval" }>): { headline: string; detail?: string; reason?: string; Icon: typeof ShieldAlert } {
  const ask = part.ask;
  switch (ask?.kind) {
    case "command":
      return {
        headline: ask.host ? t("message.approval.ask.commandNetwork", { host: ask.host }) : t("message.approval.ask.command"),
        detail: ask.detail,
        reason: ask.reason,
        Icon: SquareTerminal,
      };
    case "read":
      return { headline: t("message.approval.ask.read"), detail: ask.detail, Icon: FileText };
    case "write":
      return { headline: t("message.approval.ask.write"), detail: ask.detail, Icon: FilePen };
    default:
      return { headline: part.summary, Icon: ShieldAlert };
  }
}

/**
 * Answering in the desktop app or a browser. "Deny" goes straight to the hub: saying no runs nothing. "Allow" takes
 * the person's own proof: the desktop app asks for Touch ID (showing what the card asks, as the hub tells it) and
 * answers itself; a browser opens the security console's card in a small window.
 */
function ApprovalActions({ approvalId }: { approvalId: string }) {
  const s = useStore(session);
  const app = desktopApp();
  const [busy, setBusy] = useState<"approve" | "always" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!app?.approvals) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<DesktopApprovalEvent>).detail;
      if (d?.type !== "approval" || d.id !== approvalId) return;
      if (d.outcome !== "done") setBusy(null);
      if (d.outcome === "failed") setError(t("message.approval.failed", { error: d.error ?? "" }));
    };
    window.addEventListener(DESKTOP_EVENT, on);
    return () => window.removeEventListener(DESKTOP_EVENT, on);
  }, [app?.approvals, approvalId]);

  const allow = (always: boolean) => {
    setError(null);
    if (app?.approvals) {
      setBusy(always ? "always" : "approve");
      location.href = approvalLink(app, approvalId, "approve", always);
      return;
    }
    const url = `${s?.consoleUrl ?? ""}/#/approvals/${encodeURIComponent(approvalId)}`;
    if (!window.open(url, `approval-${approvalId}`, "popup,width=460,height=620")) window.open(url, "_blank", "noopener");
  };
  const deny = async () => {
    setBusy("deny");
    setError(null);
    try {
      await api.post(`/api/approvals/${encodeURIComponent(approvalId)}/deny`);
    } catch (e) {
      setError(t("message.approval.failed", { error: errorText(e) }));
      setBusy(null);
    }
  };
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" loading={busy === "approve"} disabled={busy !== null} onClick={() => allow(false)}>
          {t("message.approval.approve")}
        </Button>
        <Button variant="secondary" className="flex-1" loading={busy === "deny"} disabled={busy !== null} onClick={() => void deny()}>
          {t("message.approval.deny")}
        </Button>
      </div>
      {app?.approvals && (
        <button
          type="button"
          className="self-center px-2 py-1 text-xs font-medium text-muted hover:text-fg disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => allow(true)}
        >
          {busy === "always" ? t("message.approval.waiting") : t("message.approval.always")}
        </button>
      )}
      {error && (
        <div className="text-xs break-words text-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ part }: { part: Extract<MessagePart, { type: "approval" }> }) {
  const known = APPROVAL[part.status];
  const st = known ? { label: t(known.label), tone: known.tone } : { label: part.status, tone: "neutral" as const };
  const pending = part.status === "pending";
  const { headline, detail, reason, Icon } = approvalWords(part);
  const [open, setOpen] = useState(false);
  return (
    <div className={cx("w-full max-w-md rounded-2xl border bg-surface p-3.5 shadow-card", pending ? "border-warning/35 ring-4 ring-warning/8" : "border-hairline")}>
      <div className="flex items-start gap-2.5">
        <span className={cx("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", pending ? "bg-warning-soft text-warning" : "bg-surface-2 text-muted")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-muted">{pending ? t("message.approval.asks") : <Badge tone={st.tone}>{st.label}</Badge>}</div>
          <div className="mt-0.5 text-sm leading-snug font-semibold break-words">{headline}</div>
        </div>
      </div>
      {reason && <div className="mt-2 text-sm leading-relaxed break-words text-fg/80">{reason}</div>}
      {detail && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? undefined : t("message.approval.showAll")}
          className="mt-2 block w-full rounded-lg bg-surface-2 px-2.5 py-2 text-left font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]"
        >
          <span className={open ? "block" : "line-clamp-3"}>{detail}</span>
        </button>
      )}
      {/* On the phone the answer is given here with Face ID; in the desktop app with Touch ID. */}
      {pending && (native ? <NativeApprovalActions approvalId={part.approvalId} bridge={native} /> : <ApprovalActions approvalId={part.approvalId} />)}
    </div>
  );
}

function NotificationCard({ part }: { part: Extract<MessagePart, { type: "notification" }> }) {
  const lvl = notifyLevel(part.level);
  return (
    <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-3.5 shadow-card">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <Bell className="size-4" />
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold">{part.title}</span>
        <Badge tone={lvl.tone}>{lvl.label}</Badge>
      </div>
      {/* The hub's own lines (a digest's items, a calendar section) keep their breaks. */}
      {part.body && <Markdown text={part.body} className="mt-1.5 text-sm" user />}
    </div>
  );
}

function ErrorPart({ message }: { message: string }) {
  return (
    <div className="flex max-w-md items-start gap-2 rounded-2xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
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
          <img src={href} alt={part.name} className="max-h-72 max-w-full rounded-2xl border border-hairline" loading="lazy" />
        </a>
      )}
      {isAudio && <audio controls preload="none" src={href} className="mb-1 h-10 w-72 max-w-full" />}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="press inline-flex max-w-full items-center gap-2 rounded-full border border-hairline bg-surface py-1.5 pr-3.5 pl-2 text-sm text-fg shadow-[0_1px_2px_rgb(70_45_10/0.06)] hover:bg-surface-2"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          {voice ? <Mic className="size-3.5" /> : <FileText className="size-3.5" />}
        </span>
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
      className="press flex max-w-full items-center gap-1.5 self-start rounded-xl border-l-[3px] border-accent bg-surface-2/80 py-1 pr-3 pl-2 text-left text-[13px] text-muted hover:text-fg"
    >
      <CornerUpLeft className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{part.text}</span>
    </button>
  );
}

function TypingDots() {
  return (
    <span className="msg-bubble inline-flex items-center gap-1.5 px-4 py-3" aria-label={t("message.typing")}>
      <span className="typing-dot size-[7px] rounded-full" />
      <span className="typing-dot size-[7px] rounded-full" />
      <span className="typing-dot size-[7px] rounded-full" />
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

/** Whether the chat shows the message at all: a finished one with nothing for the person (only tool calls, a note for the model) is left out. */
/** `inline`: tools whose plugin line ("Remembered: …") is for the person, shown without the details mode. */
export function messageShown(message: Message, details: boolean, inline?: (tool: string) => boolean): boolean {
  return (
    message.status === "streaming" ||
    message.parts.some((p) => (p.type === "tool_call" && !details && !!inline?.(p.name)) || (p.type !== "reply_to" && partShown(p, message.role, details)))
  );
}

/** Who wrote it, for runs of messages: the person, an agent (or a teammate writing in a thread), or nobody (system). */
export function authorOf(message: Message): string | undefined {
  if (message.role === "system") return undefined;
  if (message.role === "user" && !message.agentId) return "user";
  return `agent:${message.agentId ?? ""}`;
}

function Parts({ message }: { message: Message }) {
  const { contributions } = usePluginRegistry();
  const details = useStore(showDetails);
  // Without the details mode, a plugin's inline lines ("Remembered: …") go under a finished message, after its words.
  const streaming = message.status === "streaming";
  const grouped = groupParts(message.parts);
  const inline = (it: (typeof grouped)[number]) => it.kind === "tool" && !!pickToolRenderer(contributions, it.call.name)?.inline;
  const items = details || streaming ? grouped : [...grouped.filter((it) => !inline(it)), ...grouped.filter(inline)];
  const lastPart = message.parts[message.parts.length - 1];
  return (
    <>
      {items.map((it, idx) => {
        // A plugin's inline line ("Remembered: …") is for the person: shown without the details mode.
        const plugin = it.kind === "tool" ? pickToolRenderer(contributions, it.call.name) : undefined;
        if (!details && it.kind !== "part" && !plugin?.inline) return null;
        if (it.kind === "part" && !partShown(it.part, message.role, details)) return null;
        if (it.kind === "tool") {
          const running = streaming && !it.result;
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
          case "widget":
            return <WidgetCard key={it.key} part={p} message={message} />;
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

/**
 * Core rendering of a message (also passed to chat.message overrides as `Default`). Yours is an amber bubble on the
 * right; an agent's words are paper bubbles beside its face, its cards bare under them. `grouped`: the same author
 * wrote just before, so no face or name again. `fresh`: it arrived while the chat was open, so it comes in with motion.
 */
export const DefaultMessage = memo(function DefaultMessage({
  message,
  agentName,
  agent,
  grouped,
  fresh,
}: {
  message: Message;
  agentName?: string;
  agent?: AgentDef;
  grouped?: boolean;
  fresh?: boolean;
}) {
  const details = useStore(showDetails);
  const { contributions } = usePluginRegistry();
  const name = agentName ?? agent?.name ?? message.agentId ?? t("message.assistant");
  // A finished message with nothing for the person (only tool calls, or a note for the model) is not shown at all.
  if (!messageShown(message, details, (tool) => !!pickToolRenderer(contributions, tool)?.inline)) return null;
  // A teammate writing in a thread is a user-role message with its agent: it reads as that agent's message.
  if (message.role === "user" && !message.agentId) {
    return (
      <div className={cx("flex justify-end", grouped && "-mt-3.5")} data-message-id={message.id}>
        <div
          className={cx(
            "bubble-user flex max-w-[86%] flex-wrap items-end gap-x-2.5 px-3.5 py-2 text-[15px] leading-relaxed sm:max-w-[72%]",
            grouped && "is-grouped",
            fresh && "animate-send",
          )}
        >
          {/* The time sits on the last line when it fits there, as in a messenger. */}
          <div className="min-w-0">
            <Parts message={message} />
          </div>
          <div className="ml-auto translate-y-[2px] text-[10.5px] leading-5 font-medium whitespace-nowrap tabular-nums opacity-55">
            {channelLabel(message.channel)}
            {formatTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div className={cx("mx-auto w-full max-w-[640px] text-sm", fresh && "animate-in")} data-message-id={message.id}>
        <Parts message={message} />
      </div>
    );
  }
  const streaming = message.status === "streaming";
  return (
    <div className={cx("flex gap-2.5", grouped && "-mt-3.5", fresh && "animate-in")} data-message-id={message.id}>
      <div className="w-8 shrink-0">{!grouped && <AgentAvatar avatar={agent?.avatar} id={message.agentId} name={name} size={32} running={streaming} />}</div>
      <div className={cx("min-w-0 flex-1", grouped && "is-grouped")}>
        {!grouped && (
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2 pl-0.5 text-[12.5px] text-muted">
            <span className="font-semibold text-fg">{name}</span>
            {details && message.brainRef && <span className="font-mono text-[11px]">{message.brainRef}</span>}
            <span className="tabular-nums">{formatTime(message.createdAt)}</span>
          </div>
        )}
        <div className="msg-parts text-[15px] leading-relaxed">
          <Parts message={message} />
        </div>
      </div>
    </div>
  );
});

function DefaultMessageForPlugins({ message }: { message: Message }) {
  return <DefaultMessage message={message} />;
}

export function MessageView({ message, agent, grouped, fresh }: { message: Message; agent?: AgentDef; grouped?: boolean; fresh?: boolean }) {
  const { contributions } = usePluginRegistry();
  const override = pickMessageRenderer(contributions, message);
  const core = <DefaultMessage message={message} agentName={agent?.name} agent={agent} grouped={grouped} fresh={fresh} />;
  if (!override) return core;
  const C = override.component;
  return (
    <PluginBoundary pluginId={override.pluginId} fallback={core}>
      <C pluginId={override.pluginId} message={message} Default={DefaultMessageForPlugins} />
    </PluginBoundary>
  );
}
