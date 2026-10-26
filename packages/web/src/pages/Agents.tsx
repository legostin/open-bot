// Agents: list, create/edit form, delete.

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Pencil, Plus, Trash2, X } from "lucide-react";
import type { AgentDef } from "@openbot/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { slugify } from "../lib/format";
import { agents, refreshAgents } from "../state/app";
import { toast } from "../state/toast";
import { t, tRich, type MessageKey } from "../i18n";
import { Badge, Button, cx, EmptyState, ErrorNote, Field, IconButton, Input, Loading, Modal, Page, TagInput, Textarea } from "../components/ui";

const INITIATIVE: Array<{ value: 0 | 1 | 2; title: MessageKey; text: MessageKey }> = [
  { value: 0, title: "agents.initiative0", text: "agents.initiative0Text" },
  { value: 1, title: "agents.initiative1", text: "agents.initiative1Text" },
  { value: 2, title: "agents.initiative2", text: "agents.initiative2Text" },
];

const SOURCE: Record<string, MessageKey> = { builtin: "agents.source.builtin", user: "agents.source.user" };

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
      title={t("nav.agents")}
      subtitle={t("agents.subtitle")}
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
          {t("agents.new")}
        </Button>
      }
    >
      {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && list.length === 0 && <EmptyState icon="bot" title={t("agents.empty")} />}
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
                <div className="mt-0.5 line-clamp-2 text-sm text-muted">{a.description || t("agents.noDescription")}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="info">{t("agents.initiativeBadge", { level: a.initiative })}</Badge>
              <Badge>{SOURCE[a.source] ? t(SOURCE[a.source]) : a.source}</Badge>
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
                  {t("common.delete")}
                </Button>
              )}
              <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(a)}>
                {t("common.edit")}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {editing && <AgentForm agent={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t("agents.deleteTitle")}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const a = deleting!;
                setDeleting(null);
                try {
                  await api.del(`/api/agents/${encodeURIComponent(a.id)}`);
                  toast(t("agents.deleted", { name: a.name }), "success");
                  await refreshAgents();
                } catch (e) {
                  toast(errorText(e), "error");
                }
              }}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{tRich("agents.deleteText", { file: <code className="font-mono">{deleting?.id}.md</code> })}</p>
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
      {value.length === 0 && <div className="text-sm text-muted">{t("agents.brainsEmpty")}</div>}
      <ol className="flex flex-col gap-1.5">
        {value.map((b, i) => (
          <li key={b} className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 py-1 pr-1 pl-3">
            <span className="w-5 text-xs text-muted">{i + 1}.</span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{b}</span>
            <IconButton label={t("agents.moveUp")} disabled={i === 0} onClick={() => move(i, -1)} className="size-7">
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton label={t("agents.moveDown")} disabled={i === value.length - 1} onClick={() => move(i, 1)} className="size-7">
              <ArrowDown className="size-3.5" />
            </IconButton>
            <IconButton label={t("common.remove")} onClick={() => onChange(value.filter((x) => x !== b))} className="size-7">
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
          {t("common.add")}
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
    if (!name.trim()) return setError(t("agents.errorName"));
    if (!/^[a-z0-9_-]{1,40}$/.test(effectiveId)) return setError(t("agents.errorId"));
    const n = Number(runs);
    if (!Number.isInteger(n) || n < 0) return setError(t("agents.errorRuns"));
    if (isNew && currentAgents().some((a) => a.id === effectiveId)) return setError(t("agents.errorExists", { id: effectiveId }));
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
      toast(isNew ? t("agents.created") : t("agents.saved"), "success");
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
      title={isNew ? t("agents.new") : t("agents.editTitle", { name: agent.name })}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("agents.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("agents.namePlaceholder")} autoFocus={isNew} />
          </Field>
          <Field label={t("agents.id")} hint={isNew ? t("agents.idHint") : t("agents.idFixed")}>
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
        <Field label={t("agents.description")} hint={t("agents.descriptionHint")}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field group label={t("agents.brains")} hint={t("agents.brainsHint")}>
          <BrainsEditor value={brains} onChange={setBrains} suggestions={suggestions} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("agents.model")} hint={t("agents.modelHint")}>
            <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
          </Field>
          <Field label={t("agents.policy")}>
            <Input value={policyProfile} onChange={(e) => setPolicyProfile(e.target.value)} className="font-mono" />
          </Field>
        </div>
        <Field group label={t("agents.initiative")}>
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
                  {o.value} · {t(o.title)}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-muted">{t(o.text)}</div>
              </button>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field group label={t("agents.tools")} hint={t("agents.toolsHint")}>
            <TagInput value={tools} onChange={setTools} placeholder="*" />
          </Field>
          <Field group label={t("agents.skills")} hint={t("agents.skillsHint")}>
            <TagInput value={skills} onChange={setSkills} placeholder="*" />
          </Field>
        </div>
        <Field label={t("agents.runs")} hint={t("agents.runsHint")}>
          <Input type="number" min={0} value={runs} onChange={(e) => setRuns(e.target.value)} className="sm:w-40" />
        </Field>
        <Field label={t("agents.prompt")} hint={t("agents.promptHint")}>
          <Textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="font-mono text-[13px]" placeholder={t("agents.promptPlaceholder")} />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}

function currentAgents(): AgentDef[] {
  return agents.get() ?? [];
}
