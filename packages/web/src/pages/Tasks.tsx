// Task feed: status filters, search, create.

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Bot, ChevronRight, Plus, Search, Timer, User, Zap } from "lucide-react";
import type { Task, TaskStatus } from "@openbot/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { ACTIVE_STATUSES, relativeTime, taskStatus } from "../lib/format";
import { agents, ensureAgents, refreshTasks, session, tasks } from "../state/app";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import { Badge, Button, EmptyState, ErrorNote, Field, Input, Loading, Modal, Page, Segmented, Select, Textarea, Toggle } from "../components/ui";

type Filter = "all" | "active" | "waiting" | "done" | "failed";

const FILTERS: Record<Filter, (s: TaskStatus) => boolean> = {
  all: () => true,
  active: (s) => ACTIVE_STATUSES.includes(s),
  waiting: (s) => s === "waiting_approval" || s === "waiting_input",
  done: (s) => s === "done",
  failed: (s) => s === "failed" || s === "cancelled",
};

const CREATED_BY: Record<Task["createdBy"], { label: MessageKey; icon: typeof User }> = {
  user: { label: "tasks.by.user", icon: User },
  agent: { label: "tasks.by.agent", icon: Bot },
  trigger: { label: "tasks.by.trigger", icon: Zap },
};

const FILTER_LABELS: Record<Filter, MessageKey> = {
  all: "tasks.filter.all",
  active: "tasks.filter.active",
  waiting: "tasks.filter.waiting",
  done: "tasks.filter.done",
  failed: "tasks.filter.failed",
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
    for (const task of list ?? []) for (const f of Object.keys(FILTERS) as Filter[]) if (FILTERS[f](task.status)) c[f]++;
    return c;
  }, [list]);
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (list ?? [])
      .filter((task) => FILTERS[filter](task.status))
      .filter((task) => !query || task.title.toLowerCase().includes(query) || task.goal.toLowerCase().includes(query))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [list, filter, q]);

  const closeCreate = () => {
    setCreating(false);
    if (search) navigate("/tasks", { replace: true });
  };

  return (
    <Page
      title={t("nav.tasks")}
      subtitle={t("tasks.subtitle")}
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          {t("tasks.new")}
        </Button>
      }
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={(Object.keys(FILTER_LABELS) as Filter[]).map((f) => ({ value: f, label: `${t(FILTER_LABELS[f])} ${counts[f] || ""}` }))}
        />
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="pl-9" aria-label={t("tasks.searchLabel")} />
        </div>
      </div>

      {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && shown.length === 0 && (
        <EmptyState icon="list-todo" title={list.length ? t("tasks.emptyFiltered") : t("tasks.empty")} hint={list.length ? undefined : t("tasks.emptyHint")} />
      )}
      {shown.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {shown.map((task, i) => {
            const st = taskStatus(task.status);
            const by = CREATED_BY[task.createdBy] ?? CREATED_BY.user;
            return (
              <Link key={task.id} href={`/tasks/${task.id}`} className={`flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2 ${i ? "border-t border-border" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{task.title || task.goal}</span>
                    <Badge tone={st.tone} dot={task.status === "running"}>
                      {st.label}
                    </Badge>
                    {task.background && <Badge>{t("tasks.background")}</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                    <span className="inline-flex items-center gap-1">
                      <Bot className="size-3.5" />
                      {agentNames.get(task.agentId) ?? task.agentId}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <by.icon className="size-3.5" />
                      {t(by.label)}
                    </span>
                    {task.resumeAt && task.status === "paused" && (
                      <span className="inline-flex items-center gap-1">
                        <Timer className="size-3.5" />
                        {t("tasks.resumes", { time: relativeTime(task.resumeAt) })}
                      </span>
                    )}
                    <span>{relativeTime(task.updatedAt)}</span>
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
    if (!goal.trim()) return setError(t("tasks.goalRequired"));
    setBusy(true);
    setError(undefined);
    try {
      const task = await api.post<Task>("/api/tasks", { goal: goal.trim(), title: title.trim() || undefined, agentId: agentId || s?.defaultAgent, background });
      toast(t("tasks.created"), "success");
      setGoal("");
      setTitle("");
      onClose();
      navigate(`/tasks/${task.id}`);
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
      title={t("tasks.new")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {t("common.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("tasks.goal")} hint={t("tasks.goalHint")}>
          <Textarea
            autoFocus
            rows={5}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t("tasks.goalPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
            }}
          />
        </Field>
        <Field label={t("tasks.title")} hint={t("tasks.titleHint")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label={t("tasks.agent")}>
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
              {t("tasks.backgroundTask")}
              <span className="block text-xs text-muted">{t("tasks.backgroundHint")}</span>
            </span>
          }
        />
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}
