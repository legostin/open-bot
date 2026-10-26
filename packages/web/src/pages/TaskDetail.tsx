// Task detail: summary, cancel/retry, and the task's conversation.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Ban, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import type { Task } from "@openbot/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { ACTIVE_STATUSES, formatDateTime, relativeTime, TASK_STATUS } from "../lib/format";
import { agents, ensureAgents, hubEvents, reconnected, tasks } from "../state/app";
import { toast } from "../state/toast";
import { Markdown } from "../components/markdown";
import { Badge, Button, EmptyState, ErrorNote, Loading } from "../components/ui";
import { ChatView } from "./chat/ChatView";

export function TaskDetailPage({ id }: { id: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"cancel" | "retry" | undefined>();
  const [expanded, setExpanded] = useState(false);
  const agentList = useStore(agents);
  const cached = useStore(tasks)?.find((t) => t.id === id);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.get<Task>(`/api/tasks/${encodeURIComponent(id)}`).then(
        (t) => alive && setTask(t),
        (e) => alive && setError(errorText(e)),
      );
    setTask(null);
    setError(undefined);
    void load();
    ensureAgents();
    const off1 = hubEvents.on((e) => {
      if (e.type === "task.updated" && e.data.id === id) setTask(e.data);
    });
    const off2 = reconnected.on(() => void load());
    return () => {
      alive = false;
      off1();
      off2();
    };
  }, [id]);

  const t = task ?? cached ?? null;
  const agentName = useMemo(() => (t ? (agentList?.find((a) => a.id === t.agentId)?.name ?? t.agentId) : ""), [agentList, t]);

  if (error && !t)
    return (
      <div className="p-6">
        <EmptyState icon="list-todo" title="Задача не найдена" hint={error} />
        <div className="flex justify-center">
          <Link href="/tasks" className="text-sm text-accent-text underline">
            К списку задач
          </Link>
        </div>
      </div>
    );
  if (!t) return <Loading />;

  const st = TASK_STATUS[t.status] ?? { label: t.status, tone: "neutral" as const };
  const active = ACTIVE_STATUSES.includes(t.status);
  const canRetry = ["failed", "cancelled", "interrupted", "paused", "done"].includes(t.status);

  const act = async (kind: "cancel" | "retry") => {
    setBusy(kind);
    try {
      const r = await api.post<Task & { error?: string }>(`/api/tasks/${encodeURIComponent(t.id)}/${kind}`, {});
      if (r && (r as { error?: string }).error && !r.id) throw new Error("Задача не найдена");
      if (r?.id) setTask(r);
      toast(kind === "cancel" ? "Задача отменена" : "Задача поставлена в очередь", "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };

  const summary = (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone} dot={t.status === "running"}>
          {st.label}
        </Badge>
        {t.background && <Badge>фоновая</Badge>}
        <span className="text-xs text-muted">
          {agentName}
          {t.brainRef ? ` · ${t.brainRef}` : ""} · создана {formatDateTime(t.createdAt)}
          {t.resumeAt && t.status === "paused" ? ` · продолжит ${relativeTime(t.resumeAt)}` : ""}
        </span>
      </div>
      <div className={expanded ? "mt-3" : "mt-3 max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"}>
        <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Цель</div>
        <Markdown text={t.goal} className="text-sm" />
        {t.result && (
          <>
            <div className="mt-3 mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Результат</div>
            <Markdown text={t.result} className="text-sm" />
          </>
        )}
      </div>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {expanded ? "Свернуть" : "Подробнее"}
      </button>
      {t.error && (
        <div className="mt-2">
          <ErrorNote>{t.error}</ErrorNote>
        </div>
      )}
      {t.parentTaskId && (
        <div className="mt-2 text-xs text-muted">
          Подзадача для{" "}
          <Link href={`/tasks/${t.parentTaskId}`} className="text-accent-text underline">
            родительской задачи
          </Link>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-4">
        <Link href="/tasks" aria-label="К задачам" className="inline-flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg">
          <ArrowLeft className="size-[18px]" />
        </Link>
        <span className="min-w-0 flex-1 truncate font-semibold">{t.title || "Задача"}</span>
        {active && (
          <Button size="sm" variant="danger" icon={<Ban className="size-3.5" />} onClick={() => void act("cancel")} loading={busy === "cancel"}>
            Отменить
          </Button>
        )}
        {canRetry && (
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void act("retry")} loading={busy === "retry"}>
            Повторить
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ChatView conversationId={t.conversationId} header={false} top={summary} emptyHint="Агент ещё не начал работу над задачей." />
      </div>
    </div>
  );
}
