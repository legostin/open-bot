// List of threads: main thread, user chats and task threads.

import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { House, ListChecks, MessageSquare, Plus } from "lucide-react";
import type { Conversation } from "@openbot/shared";
import { useStore } from "../../lib/store";
import { relativeTime, TASK_STATUS } from "../../lib/format";
import { errorText } from "../../lib/api";
import { conversations, createChat, ensureTasks, session, tasks } from "../../state/app";
import { toast } from "../../state/toast";
import { Badge, Button, cx } from "../../components/ui";

function Row({ c, active, onNavigate, href, badge }: { c: Conversation; active: boolean; onNavigate?: () => void; href: string; badge?: ReactNode }) {
  const Icon = c.kind === "main" ? House : c.kind === "task" ? ListChecks : MessageSquare;
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cx("flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition", active ? "bg-accent-soft text-accent-text" : "hover:bg-surface-2")}
    >
      <Icon className={cx("size-4 shrink-0", active ? "" : "text-muted")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{c.title || "Без названия"}</span>
        <span className="block truncate text-[11px] text-muted">{relativeTime(c.updatedAt)}</span>
      </span>
      {badge}
    </Link>
  );
}

export function ConversationList({ activeId, onNavigate }: { activeId: string; onNavigate?: () => void }) {
  const list = useStore(conversations);
  const taskList = useStore(tasks);
  const s = useStore(session);
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  useEffect(() => ensureTasks(), []);

  const main = list.find((c) => c.kind === "main") ?? (s ? list.find((c) => c.id === s.mainConversationId) : undefined);
  const chats = list.filter((c) => c.kind === "chat");
  const taskThreads = list.filter((c) => c.kind === "task");
  const shownTasks = showAllTasks ? taskThreads : taskThreads.slice(0, 8);
  const taskById = new Map((taskList ?? []).map((t) => [t.id, t]));

  const newChat = async () => {
    setCreating(true);
    try {
      const c = await createChat();
      navigate(`/chat/${c.id}`);
      onNavigate?.();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3">
        <Button variant="primary" className="w-full" icon={<Plus className="size-4" />} onClick={newChat} loading={creating}>
          Новый чат
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {main && <Row c={{ ...main, title: main.title || "Главный" }} href="/" active={activeId === main.id} onNavigate={onNavigate} />}
        {chats.length > 0 && (
          <>
            <div className="px-2.5 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Чаты</div>
            {chats.map((c) => (
              <Row key={c.id} c={c} href={`/chat/${c.id}`} active={activeId === c.id} onNavigate={onNavigate} />
            ))}
          </>
        )}
        {taskThreads.length > 0 && (
          <>
            <div className="px-2.5 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Задачи</div>
            {shownTasks.map((c) => {
              const t = c.taskId ? taskById.get(c.taskId) : undefined;
              const st = t ? TASK_STATUS[t.status] : undefined;
              return (
                <Row
                  key={c.id}
                  c={c}
                  href={c.taskId ? `/tasks/${c.taskId}` : `/chat/${c.id}`}
                  active={activeId === c.id}
                  onNavigate={onNavigate}
                  badge={st && t?.status !== "done" ? <Badge tone={st.tone}>{st.label}</Badge> : undefined}
                />
              );
            })}
            {taskThreads.length > shownTasks.length && (
              <button type="button" className="w-full px-2.5 py-2 text-left text-xs text-muted hover:text-fg" onClick={() => setShowAllTasks(true)}>
                Показать все ({taskThreads.length})
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
