// A conversation: top bar (agent and title, or a group's members), scrolling message list with history loading, composer.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Check, Pencil, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { agents, conversations, ensureAgents, loadMessages, loadOlder, updateConversation, useConversationMessages } from "../../state/app";
import { toast } from "../../state/toast";
import { Button, EmptyState, ErrorNote, IconButton, Input, Spinner } from "../../components/ui";
import { TopBar } from "../../components/Layout";
import { AgentHeader } from "./AgentHeader";
import { GroupFloor, GroupHeader } from "./GroupHeader";
import { DetailsToggle } from "./DetailsToggle";
import { t } from "../../i18n";
import { MessageView } from "./MessageView";
import { LatestDraftCards } from "./AgentDraftCard";
import { Composer } from "./Composer";

function TitleEditor({ id, title }: { id: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  if (!editing)
    return (
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate">{title}</span>
        <IconButton label={t("common.rename")} onClick={() => setEditing(true)} className="size-7 shrink-0">
          <Pencil className="size-3.5" />
        </IconButton>
      </div>
    );
  const save = async () => {
    setEditing(false);
    if (value.trim() && value.trim() !== title) {
      try {
        await updateConversation(id, { title: value.trim() });
      } catch (e) {
        toast(errorText(e), "error");
      }
    }
  };
  return (
    <form
      className="flex min-w-0 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="h-8 min-w-0" maxLength={120} />
      <IconButton label={t("common.save")} onClick={() => void save()} className="size-8 shrink-0">
        <Check className="size-4" />
      </IconButton>
      <IconButton label={t("common.cancel")} onClick={() => setEditing(false)} className="size-8 shrink-0">
        <X className="size-4" />
      </IconButton>
    </form>
  );
}

export function ChatView({
  conversationId,
  top,
  bottom,
  header = true,
  emptyHint,
}: {
  conversationId: string;
  /** Rendered above the messages (e.g. a task summary). */
  top?: ReactNode;
  /** Rendered after the messages (e.g. the setup card while no brain works). */
  bottom?: ReactNode;
  header?: boolean;
  emptyHint?: ReactNode;
}) {
  const conv = useConversationMessages(conversationId);
  const convList = useStore(conversations);
  const meta = convList.find((c) => c.id === conversationId);
  const agentList = useStore(agents);
  const agentById = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a])), [agentList]);
  const latestDrafts = useMemo(() => {
    const m = new Map<string, string>();
    for (const msg of conv.messages) for (const p of msg.parts) if (p.type === "agent_draft") m.set(p.draftId, msg.id);
    return m;
  }, [conv.messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const [showDown, setShowDown] = useState(false);

  useEffect(() => {
    stick.current = true;
    void loadMessages(conversationId);
    ensureAgents();
  }, [conversationId]);

  // Keep the view pinned to the bottom while new content streams in; keep position when older messages load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [conv.messages]);

  const older = () => {
    if (!scroller.current) return;
    prevHeight.current = scroller.current.scrollHeight;
    void loadOlder(conversationId).finally(() => {
      // If nothing was prepended the layout effect may not run; reset.
      setTimeout(() => (prevHeight.current = null), 50);
    });
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = fromBottom < 120;
    setShowDown(fromBottom > 400);
    if (el.scrollTop < 60 && conv.hasMore && !conv.loadingOlder && prevHeight.current === null) older();
  };

  const title = meta?.title || (meta?.kind === "main" ? t("chat.main") : t("chat.defaultTitle"));
  const editable = meta?.kind === "chat";
  const isGroup = meta?.kind === "group";
  const groupHint = isGroup ? t("group.emptyHint", { lead: agentById.get(meta.agentId)?.name ?? meta.agentId }) : undefined;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {header && (
        <TopBar>
          {meta && isGroup ? (
            <GroupHeader conv={meta} />
          ) : (
            <>
              {meta && <AgentHeader agentId={meta.agentId} settings={meta.kind !== "task"} />}
              <span className="hidden text-border sm:inline">/</span>
              <div className="hidden min-w-0 flex-1 text-sm text-muted sm:block">{editable ? <TitleEditor id={conversationId} title={title} /> : <span className="block truncate">{title}</span>}</div>
            </>
          )}
          <DetailsToggle />
        </TopBar>
      )}

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 py-5 sm:px-6">
          {top}
          {conv.hasMore && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" onClick={older} loading={conv.loadingOlder}>
                {t("chat.loadOlder")}
              </Button>
            </div>
          )}
          {conv.error && <ErrorNote onRetry={() => void loadMessages(conversationId, true)}>{conv.error}</ErrorNote>}
          {!conv.loaded && conv.loading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {conv.loaded && !conv.messages.length && !conv.error && (
            <EmptyState icon={isGroup ? "users" : "sparkles"} title={isGroup ? t("group.emptyTitle") : t("chat.empty")} hint={emptyHint ?? groupHint ?? t("chat.emptyHint")} />
          )}
          <LatestDraftCards.Provider value={latestDrafts}>
            {conv.messages.map((m) => (
              <MessageView key={m.id} message={m} agent={m.agentId ? agentById.get(m.agentId) : undefined} />
            ))}
          </LatestDraftCards.Provider>
          {isGroup && <GroupFloor conversationId={conversationId} />}
          {bottom}
        </div>
        {showDown && (
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            }}
            aria-label={t("chat.scrollDown")}
            className="sticky bottom-3 left-full mr-4 ml-auto flex size-9 items-center justify-center rounded-full border border-border bg-surface shadow-card"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      <div className="shrink-0 px-3 pt-1 pb-3 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <Composer key={conversationId} conversationId={conversationId} />
        </div>
      </div>
    </div>
  );
}
