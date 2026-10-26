// Task feed: status filters, search, create.

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Bot, ChevronRight, Plus, Search, Timer, User, Zap } from "lucide-react";
import type { Task, TaskStatus } from "@openbot/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { ACTIVE_STATUSES, relativeTime, TASK_STATUS } from "../lib/format";
import { agents, ensureAgents, refreshTasks, session, tasks } from "../state/app";
import { toast } from "../state/toast";
import { Badge, Button, EmptyState, ErrorNote, Field, Input, Loading, Modal, Page, Segmented, Select, Textarea, Toggle } from "../components/ui";

type Filter = "all" | "active" | "waiting" | "done" | "failed";

const FILTERS: Record<Filter, (s: TaskStatus) => boolean> = {
  all: () => true,
  active: (s) => ACTIVE_STATUSES.includes(s),
  waiting: (s) => s === "waiting_approval" || s === "waiting_input",
  done: (s) => s === "done",
  failed: (s) => s === "failed" || s === "cancelled",
};

const CREATED_BY: Record<Task["createdBy"], { label: string; icon: typeof User }> = {
  user: { label: "вы", icon: User },
  agent: { label: "агент", icon: Bot },
  trigger: { label: "триггер", icon: Zap },
};

export function TasksPage() {
  const list = useStore(tasks);
  const agentList = useStore(agents);
  const search = useSearch();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(() => new URLSearchParams(search).get("new") === "1");

  const load = () => {
    setError(undefined);
    refreshTasks().catch((e) => setError(errorText(e)));
  };
  useEffect(() => {
    load();
    ensureAgents();
  }, []);
  useEffect(() => {
    if (new URLSearchParams(search).get("new") === "1") setCreating(true);
  }, [search]);

  const agentNames = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a.name])), [agentList]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, active: 0, waiting: 0, done: 0, failed: 0 };
    for (const t of list ?? []) for (const f of Object.keys(FILTERS) as Filter[]) if (FILTERS[f](t.status)) c[f]++;
    return c;
  }, [list]);
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (list ?? [])
      .filter((t) => FILTERS[filter](t.status))
      .filter((t) => !query || t.title.toLowerCase().includes(query) || t.goal.toLowerCase().includes(query))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [list, filter, q]);

  const closeCreate = () => {
    setCreating(false);
    if (search) navigate("/tasks", { replace: true });
  };

  return (
    <Page
      title="Задачи"
      subtitle="Всё, над чем работают агенты: ваши поручения, делегированные и запущенные триггерами."
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          Новая задача
        </Button>
      }
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `Все ${counts.all || ""}` },
            { value: "active", label: `Активные ${counts.active || ""}` },
            { value: "waiting", label: `Ждут ${counts.waiting || ""}` },
            { value: "done", label: `Готово ${counts.done || ""}` },
            { value: "failed", label: `Ошибки ${counts.failed || ""}` },
          ]}
        />
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" className="pl-9" aria-label="Поиск задач" />
        </div>
      </div>

      {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && shown.length === 0 && (
        <EmptyState
          icon="list-todo"
          title={list.length ? "Под фильтр ничего не попало" : "Задач пока нет"}
          hint={list.length ? undefined : "Создайте задачу — агент возьмётся за неё сам и напишет, когда закончит."}
        />
      )}
      {shown.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {shown.map((t, i) => {
            const st = TASK_STATUS[t.status] ?? { label: t.status, tone: "neutral" as const };
            const by = CREATED_BY[t.createdBy] ?? CREATED_BY.user;
            return (
              <Link key={t.id} href={`/tasks/${t.id}`} className={`flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2 ${i ? "border-t border-border" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{t.title || t.goal}</span>
                    <Badge tone={st.tone} dot={t.status === "running"}>
                      {st.label}
                    </Badge>
                    {t.background && <Badge>фоновая</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                    <span className="inline-flex items-center gap-1">
                      <Bot className="size-3.5" />
                      {agentNames.get(t.agentId) ?? t.agentId}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <by.icon className="size-3.5" />
                      {by.label}
                    </span>
                    {t.resumeAt && t.status === "paused" && (
                      <span className="inline-flex items-center gap-1">
                        <Timer className="size-3.5" />
                        продолжит {relativeTime(t.resumeAt)}
                      </span>
                    )}
                    <span>{relativeTime(t.updatedAt)}</span>
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted" />
              </Link>
            );
          })}
        </div>
      )}

      <CreateTaskModal open={creating} onClose={closeCreate} />
    </Page>
  );
}

function CreateTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agentList = useStore(agents);
  const s = useStore(session);
  const [, navigate] = useLocation();
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [background, setBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      ensureAgents();
      setError(undefined);
    }
  }, [open]);

  const submit = async () => {
    if (!goal.trim()) return setError("Опишите задачу");
    setBusy(true);
    setError(undefined);
    try {
      const t = await api.post<Task>("/api/tasks", { goal: goal.trim(), title: title.trim() || undefined, agentId: agentId || s?.defaultAgent, background });
      toast("Задача создана", "success");
      setGoal("");
      setTitle("");
      onClose();
      navigate(`/tasks/${t.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Новая задача"
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Создать
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Что нужно сделать" hint="Опишите цель и критерии готовности — агент сам разобьёт на шаги.">
          <Textarea
            autoFocus
            rows={5}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Например: собери сводку новых issue в репозитории и предложи, что взять в работу"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
            }}
          />
        </Field>
        <Field label="Название" hint="Необязательно — по умолчанию начало описания">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Агент">
          <Select value={agentId || s?.defaultAgent || ""} onChange={(e) => setAgentId(e.target.value)}>
            {(agentList ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Toggle
          checked={background}
          onChange={setBackground}
          label={
            <span>
              Фоновая задача
              <span className="block text-xs text-muted">Выполняется без вашего участия, в рамках уровня инициативы агента</span>
            </span>
          }
        />
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}
