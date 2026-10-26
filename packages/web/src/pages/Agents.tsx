// Agents: list, create/edit form, delete.

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Pencil, Plus, Trash2, X } from "lucide-react";
import type { AgentDef } from "@openbot/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { slugify } from "../lib/format";
import { agents, refreshAgents } from "../state/app";
import { toast } from "../state/toast";
import { Badge, Button, cx, EmptyState, ErrorNote, Field, IconButton, Input, Loading, Modal, Page, TagInput, Textarea } from "../components/ui";

const INITIATIVE: Array<{ value: 0 | 1 | 2; title: string; text: string }> = [
  { value: 0, title: "Только отвечает", text: "Работает, только когда вы пишете. Фоновых задач не берёт." },
  { value: 1, title: "Предлагает", text: "Может работать в фоне, но только с инструментами чтения: находит, сводит, предлагает. По умолчанию." },
  { value: 2, title: "Действует", text: "В фоне выполняет действия в рамках ваших правил; всё внешнее — через подтверждения." },
];

const SOURCE: Record<string, string> = { builtin: "встроенный", user: "ваш" };

export function AgentsPage() {
  const list = useStore(agents);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<AgentDef | "new" | null>(null);
  const [deleting, setDeleting] = useState<AgentDef | null>(null);

  const load = () => {
    setError(undefined);
    refreshAgents().catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  return (
    <Page
      title="Агенты"
      subtitle="Агент — это роль: характер, набор мозгов, инструменты и уровень инициативы."
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
          Новый агент
        </Button>
      }
    >
      {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && list.length === 0 && <EmptyState icon="bot" title="Агентов нет" />}
      <div className="grid gap-3 sm:grid-cols-2">
        {list?.map((a) => (
          <div key={a.id} className="flex flex-col rounded-2xl border border-border bg-surface p-4 shadow-card">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
                <Bot className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{a.name}</span>
                  <span className="font-mono text-xs text-muted">{a.id}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-sm text-muted">{a.description || "Без описания"}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="info">инициатива {a.initiative}</Badge>
              <Badge>{SOURCE[a.source] ?? a.source}</Badge>
              {a.model && <Badge>{a.model}</Badge>}
              {a.brains.slice(0, 3).map((b) => (
                <Badge key={b} className="font-mono">
                  {b}
                </Badge>
              ))}
              {a.brains.length > 3 && <Badge>+{a.brains.length - 3}</Badge>}
            </div>
            <div className="mt-auto flex justify-end gap-1 pt-3">
              {a.source === "user" && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(a)}>
                  Удалить
                </Button>
              )}
              <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(a)}>
                Изменить
              </Button>
            </div>
          </div>
        ))}
      </div>

      {editing && <AgentForm agent={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Удалить агента?"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Отмена</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const a = deleting!;
                setDeleting(null);
                try {
                  await api.del(`/api/agents/${encodeURIComponent(a.id)}`);
                  toast(`Агент «${a.name}» удалён`, "success");
                  await refreshAgents();
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              Удалить
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Файл агента <code className="font-mono">{deleting?.id}.md</code> будет удалён. Если это была ваша версия встроенного агента, вернётся встроенная.
        </p>
      </Modal>
    </Page>
  );
}

/** Mirrors parseBrainRef in @openbot/shared: a ref without "@machine" runs on the hub ("@local"). */
function normalizeBrainRef(ref: string): string {
  const r = ref.trim();
  return r.includes("@") ? r : `${r}@local`;
}

function BrainsEditor({ value, onChange, suggestions }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState("");
  const move = (i: number, d: number) => {
    const next = value.slice();
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  const add = (ref: string) => {
    const r = ref.trim();
    if (r && !value.some((v) => normalizeBrainRef(v) === normalizeBrainRef(r))) onChange([...value, r]);
    setDraft("");
  };
  const taken = new Set(value.map(normalizeBrainRef));
  const free = suggestions.filter((s) => !taken.has(normalizeBrainRef(s)));
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && <div className="text-sm text-muted">Список пуст — агенту не на чем думать.</div>}
      <ol className="flex flex-col gap-1.5">
        {value.map((b, i) => (
          <li key={b} className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 py-1 pr-1 pl-3">
            <span className="w-5 text-xs text-muted">{i + 1}.</span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{b}</span>
            <IconButton label="Выше" disabled={i === 0} onClick={() => move(i, -1)} className="size-7">
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton label="Ниже" disabled={i === value.length - 1} onClick={() => move(i, 1)} className="size-7">
              <ArrowDown className="size-3.5" />
            </IconButton>
            <IconButton label="Убрать" onClick={() => onChange(value.filter((x) => x !== b))} className="size-7">
              <X className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Input
          value={draft}
          list="brain-refs"
          onChange={(e) => setDraft(e.target.value)}
          placeholder="claude-code@local, api:anthropic, codex@laptop…"
          className="font-mono"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
        />
        <Button onClick={() => add(draft)} disabled={!draft.trim()}>
          Добавить
        </Button>
        <datalist id="brain-refs">
          {free.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      {free.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {free.slice(0, 8).map((s) => (
            <button key={s} type="button" onClick={() => add(s)} className="rounded-lg border border-dashed border-border px-2 py-0.5 font-mono text-xs text-muted hover:border-accent hover:text-accent-text">
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentForm({ agent, onClose }: { agent?: AgentDef; onClose: () => void }) {
  const isNew = !agent;
  const [id, setId] = useState(agent?.id ?? "");
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [brains, setBrains] = useState<string[]>(agent?.brains ?? ["claude-code@local", "codex@local", "api:anthropic"]);
  const [model, setModel] = useState(agent?.model ?? "");
  const [initiative, setInitiative] = useState<0 | 1 | 2>(agent?.initiative ?? 1);
  const [tools, setTools] = useState<string[]>(agent?.tools ?? ["*"]);
  const [skills, setSkills] = useState<string[]>(agent?.skills ?? ["*"]);
  const [policyProfile, setPolicyProfile] = useState(agent?.policyProfile ?? "default");
  const [runs, setRuns] = useState(String(agent?.budget.backgroundRunsPerDay ?? 30));
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.get<Array<{ ref: string }>>("/api/brains").then(
      (l) => setSuggestions(l.map((b) => b.ref)),
      () => {},
    );
  }, []);

  const effectiveId = isNew ? (idTouched ? id : slugify(name)) : agent.id;

  const save = async () => {
    setError(undefined);
    if (!name.trim()) return setError("Укажите имя");
    if (!/^[a-z0-9_-]{1,40}$/.test(effectiveId)) return setError("Идентификатор: латинские буквы, цифры, «-» и «_»");
    const n = Number(runs);
    if (!Number.isInteger(n) || n < 0) return setError("Фоновых запусков в день — целое число ≥ 0");
    if (isNew && currentAgents().some((a) => a.id === effectiveId)) return setError(`Агент «${effectiveId}» уже существует`);
    setBusy(true);
    try {
      await api.put(`/api/agents/${encodeURIComponent(effectiveId)}`, {
        name: name.trim(),
        description: description.trim(),
        brains,
        model: model.trim() || undefined,
        initiative,
        tools,
        skills,
        policyProfile: policyProfile.trim() || "default",
        budget: { ...(agent?.budget ?? {}), backgroundRunsPerDay: n },
        prompt,
      });
      toast(isNew ? "Агент создан" : "Агент сохранён", "success");
      await refreshAgents();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={isNew ? "Новый агент" : `Агент «${agent.name}»`}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Исследователь" autoFocus={isNew} />
          </Field>
          <Field label="Идентификатор" hint={isNew ? "Имя файла agents/<id>.md" : "Нельзя изменить"}>
            <Input
              value={effectiveId}
              disabled={!isNew}
              onChange={(e) => {
                setIdTouched(true);
                setId(e.target.value.toLowerCase());
              }}
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Описание" hint="Коротко: зачем этот агент. Видно другим агентам при делегировании.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field group label="Мозги по порядку" hint="Первый доступный и залогиненный используется; при лимите или ошибке задача переходит к следующему.">
          <BrainsEditor value={brains} onChange={setBrains} suggestions={suggestions} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Модель" hint="Необязательно: sonnet, opus, gpt-5… — как понимает мозг">
            <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Профиль политики">
            <Input value={policyProfile} onChange={(e) => setPolicyProfile(e.target.value)} className="font-mono" />
          </Field>
        </div>
        <Field group label="Инициатива">
          <div className="grid gap-2 sm:grid-cols-3">
            {INITIATIVE.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setInitiative(o.value)}
                aria-pressed={initiative === o.value}
                className={cx(
                  "rounded-xl border p-3 text-left transition",
                  initiative === o.value ? "border-accent bg-accent-soft/60 ring-2 ring-accent/20" : "border-border hover:bg-surface-2",
                )}
              >
                <div className="text-sm font-semibold">
                  {o.value} · {o.title}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-muted">{o.text}</div>
              </button>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field group label="Инструменты" hint="Маски имён: * — все, browser_* — только браузер">
            <TagInput value={tools} onChange={setTools} placeholder="*" />
          </Field>
          <Field group label="Скиллы" hint="Маски имён скиллов">
            <TagInput value={skills} onChange={setSkills} placeholder="*" />
          </Field>
        </div>
        <Field label="Фоновых запусков в день" hint="Бюджет проактивности: сколько раз агент может работать сам">
          <Input type="number" min={0} value={runs} onChange={(e) => setRuns(e.target.value)} className="sm:w-40" />
        </Field>
        <Field label="Промпт" hint="Характер и правила агента. Markdown.">
          <Textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="font-mono text-[13px]" placeholder="Ты — дружелюбный и проактивный ассистент…" />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}

function currentAgents(): AgentDef[] {
  return agents.get() ?? [];
}
