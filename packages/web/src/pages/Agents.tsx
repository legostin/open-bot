// Agents: list, create (name + avatar first) / edit, delete.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import type { AgentAvatar as AgentAvatarValue, AgentDef } from "@openbot/shared";
import { AVATAR_COLORS, AVATAR_SHAPES, defaultAvatar } from "@openbot/shared/avatar";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { slugify } from "../lib/format";
import { agentForPath, agentPath } from "../lib/team";
import { agents, refreshAgents, session } from "../state/app";
import { activeBrain, brainName, brainReady, brains, brainStatus, ensureBrains, findBrain, normalizeBrainRef } from "../state/brains";
import { clearPanelIntent, closePanel, panel } from "../state/panel";
import { toast } from "../state/toast";
import { t, tRich, type MessageKey } from "../i18n";
import { AgentAvatar, AVATAR_HEX } from "../components/AgentAvatar";
import { Badge, Button, cx, EmptyState, ErrorNote, Field, IconButton, Input, Loading, Modal, Page, TagInput, Textarea } from "../components/ui";

const INITIATIVE: Array<{ value: 0 | 1 | 2; title: MessageKey; text: MessageKey }> = [
  { value: 0, title: "agents.initiative0", text: "agents.initiative0Text" },
  { value: 1, title: "agents.initiative1", text: "agents.initiative1Text" },
  { value: 2, title: "agents.initiative2", text: "agents.initiative2Text" },
];

const SOURCE: Record<string, MessageKey> = { builtin: "agents.source.builtin", user: "agents.source.user" };

export function AgentsPage() {
  const list = useStore(agents);
  const brainList = useStore(brains);
  useEffect(() => ensureBrains(), []);
  const p = useStore(panel);
  const s = useStore(session);
  const [loc, navigate] = useLocation();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<AgentDef | "new" | null>(null);
  // Opened by "Add agent": once created, the new team member's dialog opens.
  const [openDialog, setOpenDialog] = useState(false);
  const [deleting, setDeleting] = useState<AgentDef | null>(null);

  const load = () => {
    setError(undefined);
    refreshAgents().catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  // Requests from outside the panel: "Add agent" (sidebar, palette) and an agent's settings (dialog header).
  useEffect(() => {
    const intent = p.intent;
    if (!intent) return;
    if (intent.kind === "agent.new") {
      setEditing("new");
      setOpenDialog(true);
    } else {
      if (!list) return;
      const a = list.find((x) => x.id === intent.agentId);
      if (a) setEditing(a);
    }
    clearPanelIntent();
  }, [p.intent, list]);

  const closeEditor = () => {
    setEditing(null);
    setOpenDialog(false);
  };

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
              <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={40} />
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
              {(() => {
                const on = activeBrain(a.brains, brainList);
                return <Badge tone={on ? "success" : "warning"}>{on ? on.label : t("brainPicker.none")}</Badge>;
              })()}
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

      {editing && (
        <AgentEditor
          agent={editing === "new" ? undefined : editing}
          onClose={closeEditor}
          onSaved={(a) => {
            if (editing !== "new" || !openDialog) return;
            navigate(agentPath(a.id, s?.defaultAgent));
            closePanel();
          }}
        />
      )}
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
                  // Its dialog stays on the hub, but it is no longer on the team: leave it.
                  if (agentForPath(loc, s?.defaultAgent) === a.id) navigate("/");
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

function BrainsEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const list = useStore(brains);
  useEffect(() => ensureBrains(), []);
  const suggestions = (list ?? []).map((b) => b.ref);
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
            <span className="min-w-0 flex-1 truncate text-sm" title={b}>
              {brainName(b, list)}
            </span>
            {(() => {
              const row = findBrain(list, b);
              if (!row) return <Badge>{t("brains.status.notConnected")}</Badge>;
              if (brainReady(row)) return null;
              const st = brainStatus(row);
              return <Badge tone={st.tone}>{st.label}</Badge>;
            })()}
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
            <button key={s} type="button" onClick={() => add(s)} title={s} className="rounded-lg border border-dashed border-border px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-accent-text">
              + {brainName(s, list)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Colour swatches and shape tiles; the big preview shows the result with the agent's initial. */
export function AvatarPicker({ value, onChange, name }: { value: AgentAvatarValue; onChange: (v: AgentAvatarValue) => void; name: string }) {
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
      <div className="flex size-32 shrink-0 items-center justify-center rounded-3xl bg-surface-2/70">
        <AgentAvatar avatar={value} name={name || "?"} size={96} />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-4">
        <div>
          <div className="mb-2 text-sm font-medium">{t("agents.avatarColor")}</div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("agents.avatarColor")}>
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={value.color === c}
                aria-label={t(`avatar.color.${c}` as MessageKey)}
                title={t(`avatar.color.${c}` as MessageKey)}
                onClick={() => onChange({ ...value, color: c })}
                className={cx("size-8 rounded-full transition", value.color === c ? "ring-2 ring-fg ring-offset-2 ring-offset-surface" : "hover:scale-110")}
                style={{ background: AVATAR_HEX[c] }}
              />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">{t("agents.avatarShape")}</div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("agents.avatarShape")}>
            {AVATAR_SHAPES.map((sh) => (
              <button
                key={sh}
                type="button"
                role="radio"
                aria-checked={value.shape === sh}
                aria-label={t(`avatar.shape.${sh}` as MessageKey)}
                title={t(`avatar.shape.${sh}` as MessageKey)}
                onClick={() => onChange({ ...value, shape: sh })}
                className={cx(
                  "flex size-11 items-center justify-center rounded-xl border transition",
                  value.shape === sh ? "border-accent bg-accent-soft/60 ring-2 ring-accent/20" : "border-border hover:bg-surface-2",
                )}
              >
                <AgentAvatar avatar={{ color: value.color, shape: sh }} size={28} initial={false} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function randomAvatar(): AgentAvatarValue {
  return { color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)], shape: AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)] };
}

/**
 * Create or edit an agent. Creating starts with who the agent is (name + avatar), then what it does;
 * the technical knobs sit under "More settings".
 */
export function AgentEditor({ agent, onClose, onSaved }: { agent?: AgentDef; onClose: () => void; onSaved?: (a: AgentDef) => void }) {
  const isNew = !agent;
  const [step, setStep] = useState<0 | 1>(isNew ? 0 : 1);
  const [id, setId] = useState(agent?.id ?? "");
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState(agent?.name ?? "");
  const [avatar, setAvatar] = useState<AgentAvatarValue>(() => agent?.avatar ?? (agent ? defaultAvatar(agent.id) : randomAvatar()));
  const [description, setDescription] = useState(agent?.description ?? "");
  // A new agent thinks with what the main agent was switched to, so it works on a hub with one brain signed in.
  const [brains, setBrains] = useState<string[]>(
    () => agent?.brains ?? agents.get()?.find((a) => a.id === session.get()?.defaultAgent)?.brains ?? ["claude-code@local", "codex@local", "api:anthropic"],
  );
  const [model, setModel] = useState(agent?.model ?? "");
  const [initiative, setInitiative] = useState<0 | 1 | 2>(agent?.initiative ?? 1);
  const [tools, setTools] = useState<string[]>(agent?.tools ?? ["*"]);
  const [skills, setSkills] = useState<string[]>(agent?.skills ?? ["*"]);
  const [policyProfile, setPolicyProfile] = useState(agent?.policyProfile ?? "default");
  const [runs, setRuns] = useState(String(agent?.budget.backgroundRunsPerDay ?? 30));
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const effectiveId = isNew ? (idTouched ? id : slugify(name)) : agent.id;

  const next = () => {
    setError(undefined);
    if (!name.trim()) return setError(t("agents.errorName"));
    setStep(1);
  };

  const save = async () => {
    setError(undefined);
    if (!name.trim()) return setError(t("agents.errorName"));
    if (!/^[a-z0-9_-]{1,40}$/.test(effectiveId)) {
      setMore(true);
      return setError(t("agents.errorId"));
    }
    const n = Number(runs);
    if (!Number.isInteger(n) || n < 0) {
      setMore(true);
      return setError(t("agents.errorRuns"));
    }
    if (isNew && currentAgents().some((a) => a.id === effectiveId)) {
      setMore(true);
      return setError(t("agents.errorExists", { id: effectiveId }));
    }
    setBusy(true);
    try {
      const saved = await api.put<AgentDef>(`/api/agents/${encodeURIComponent(effectiveId)}`, {
        name: name.trim(),
        avatar,
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
      const list = await refreshAgents();
      onSaved?.(list.find((a) => a.id === effectiveId) ?? saved);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const identity = (
    <div className="flex flex-col gap-5">
      <Field label={t("agents.name")}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("agents.namePlaceholder")}
          autoFocus={isNew}
          maxLength={60}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isNew && step === 0) {
              e.preventDefault();
              next();
            }
          }}
        />
      </Field>
      <AvatarPicker value={avatar} onChange={setAvatar} name={name} />
    </div>
  );

  const details = (
    <div className="flex flex-col gap-5">
      {isNew ? (
        <div className="flex items-center gap-3 rounded-2xl bg-surface-2/60 px-3 py-2.5">
          <AgentAvatar avatar={avatar} name={name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{name}</div>
            <button type="button" onClick={() => setStep(0)} className="text-xs text-accent-text hover:underline">
              {t("agents.changeLook")}
            </button>
          </div>
        </div>
      ) : (
        identity
      )}
      <Field label={t("agents.description")} hint={t("agents.descriptionHint")}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label={t("agents.prompt")} hint={t("agents.promptHint")}>
        <Textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-[14px]" placeholder={t("agents.promptPlaceholder")} />
      </Field>
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
      <div className="rounded-2xl border border-border">
        <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium">
          {more ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
          {t("agents.more")}
          <span className="min-w-0 flex-1 truncate text-right text-xs font-normal text-muted">{t("agents.moreHint")}</span>
        </button>
        {more && (
          <div className="flex flex-col gap-5 border-t border-border p-3">
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
            <Field group label={t("agents.brains")} hint={t("agents.brainsHint")}>
              <BrainsEditor value={brains} onChange={setBrains} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("agents.model")} hint={t("agents.modelHint")}>
                <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
              </Field>
              <Field label={t("agents.policy")}>
                <Input value={policyProfile} onChange={(e) => setPolicyProfile(e.target.value)} className="font-mono" />
              </Field>
            </div>
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
          </div>
        )}
      </div>
    </div>
  );

  const footer =
    isNew && step === 0 ? (
      <>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={next} disabled={!name.trim()} icon={<ArrowRight className="size-4" />}>
          {t("agents.next")}
        </Button>
      </>
    ) : (
      <>
        {isNew ? (
          <Button onClick={() => setStep(0)} icon={<ArrowLeft className="size-4" />}>
            {t("common.back")}
          </Button>
        ) : (
          <Button onClick={onClose}>{t("common.cancel")}</Button>
        )}
        <Button variant="primary" onClick={() => void save()} loading={busy}>
          {isNew ? t("agents.create") : t("common.save")}
        </Button>
      </>
    );

  return (
    <Modal
      open
      wide={step === 1}
      onClose={onClose}
      title={isNew ? (step === 0 ? t("agents.stepIdentity") : t("agents.stepRole")) : t("agents.editTitle", { name: agent.name })}
      footer={footer}
    >
      {isNew && (
        <div className="mb-4 flex items-center gap-2 text-xs text-muted">
          <span className={cx("h-1 flex-1 rounded-full", "bg-accent")} />
          <span className={cx("h-1 flex-1 rounded-full", step === 1 ? "bg-accent" : "bg-surface-2")} />
          <span className="shrink-0">{t("agents.stepOf", { step: step + 1, total: 2 })}</span>
        </div>
      )}
      {isNew && step === 0 ? identity : details}
      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Modal>
  );
}

function currentAgents(): AgentDef[] {
  return agents.get() ?? [];
}
