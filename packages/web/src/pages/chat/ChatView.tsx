// A conversation: header (title, agent picker), scrolling message list with history loading, composer.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Check, MessagesSquare, Pencil, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { agents, conversations, ensureAgents, loadMessages, loadOlder, updateConversation, useConversationMessages } from "../../state/app";
import { toast } from "../../state/toast";
import { Button, EmptyState, ErrorNote, IconButton, Input, Select, Spinner } from "../../components/ui";
import { t } from "../../i18n";
import { MessageView } from "./MessageView";
import { Composer } from "./Composer";

function AgentPicker({ conversationId, agentId }: { conversationId: string; agentId?: string }) {
  const list = useStore(agents);
  useEffect(() => ensureAgents(), []);
  if (!list || !list.length) return null;
  return (
    <Select
      aria-label={t("chat.agent")}
      value={agentId ?? ""}
      onChange={async (e) => {
        try {
          await updateConversation(conversationId, { agentId: e.target.value });
          toast(t("chat.agentChanged", { name: list.find((a) => a.id === e.target.value)?.name ?? e.target.value }), "success");
        } catch (err) {
          toast(errorText(err), "error");
        }
      }}
      className="h-8 w-auto max-w-[44vw] rounded-lg py-0 pr-7 pl-2 text-[13px] sm:max-w-56"
    >
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );
}

function TitleEditor({ id, title }: { id: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  if (!editing)
    return (
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate font-semibold">{title}</span>
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
  onOpenThreads,
  top,
  header = true,
  emptyHint,
}: {
  conversationId: string;
  onOpenThreads?: () => void;
  /** Rendered above the messages (e.g. first-run checklist, task summary). */
  top?: ReactNode;
  header?: boolean;
  emptyHint?: ReactNode;
}) {
  const conv = useConversationMessages(conversationId);
  const convList = useStore(conversations);
  const meta = convList.find((c) => c.id === conversationId);
  const agentList = useStore(agents);
  const agentNames = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a.name])), [agentList]);
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

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {header && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
          {onOpenThreads && (
            <IconButton label={t("chat.allChats")} onClick={onOpenThreads} className="lg:hidden">
              <MessagesSquare className="size-[18px]" />
            </IconButton>
          )}
          <div className="min-w-0 flex-1">{editable ? <TitleEditor id={conversationId} title={title} /> : <span className="block truncate font-semibold">{title}</span>}</div>
          {meta && meta.kind !== "task" && <AgentPicker conversationId={conversationId} agentId={meta.agentId} />}
        </div>
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
            <EmptyState icon="sparkles" title={t("chat.empty")} hint={emptyHint ?? t("chat.emptyHint")} />
          )}
          {conv.messages.map((m) => (
            <MessageView key={m.id} message={m} agentName={m.agentId ? agentNames.get(m.agentId) : undefined} />
          ))}
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
