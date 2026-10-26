import { useState } from "react";
import { Ban, CheckCircle2, ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { api, errorText } from "../api.ts";
import type { Rule } from "../types.ts";
import { useAsync, useTools } from "../hooks.ts";
import { formatDate } from "../lib/format.ts";
import { Badge, Button, Card, EmptyState, ErrorText, IconButton, PageHeader, Segmented, Spinner } from "../ui/kit.tsx";
import { ConfirmDialog, Dialog, useToast } from "../ui/overlay.tsx";
import { ConditionChip, emptyRuleForm, formFromRule, RuleForm, ruleFromForm, type RuleFormValue } from "./RuleForm.tsx";
import { LoadError } from "./Approvals.tsx";

const VIA: Record<Rule["createdVia"], string> = {
  console: "в пульте",
  telegram: "в Telegram",
  approval: "из подтверждения",
};

export function RulesPage() {
  const rules = useAsync(() => api.rules(), []);
  const [editing, setEditing] = useState<Rule | "new">();
  const [removing, setRemoving] = useState<Rule>();
  const [filter, setFilter] = useState<"all" | "allow" | "deny">("all");
  const toast = useToast();

  const list = (rules.data ?? []).filter((r) => filter === "all" || r.decision === filter);

  return (
    <div>
      <PageHeader
        title="Правила"
        description="Правила решают за вас: «разрешать» пропускает похожие внешние действия без вопроса, «запрещать» блокирует любые вызовы. Создать правило можно только здесь или в Telegram."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            Новое правило
          </Button>
        }
      />

      {rules.data && rules.data.length > 0 && (
        <div className="mb-4">
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `Все · ${rules.data.length}` },
              { value: "allow", label: "Разрешают" },
              { value: "deny", label: "Запрещают" },
            ]}
          />
        </div>
      )}

      {!rules.data ? (
        rules.error ? (
          <LoadError error={rules.error} retry={rules.reload} />
        ) : (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        )
      ) : rules.data.length === 0 ? (
        <EmptyState icon={<ListChecks className="size-8" />} title="Правил пока нет">
          Каждое внешнее действие будет требовать подтверждения. Нажмите «Всегда разрешать такое…» на карточке подтверждения или создайте правило вручную.
        </EmptyState>
      ) : (
        <div className="space-y-2.5">
          {list.map((r) => (
            <RuleCard key={r.id} rule={r} onEdit={() => setEditing(r)} onRemove={() => setRemoving(r)} />
          ))}
          {list.length === 0 && <p className="py-6 text-center text-sm text-muted">Нет правил с таким решением.</p>}
        </div>
      )}

      {editing && (
        <RuleEditor
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(created) => {
            setEditing(undefined);
            toast(created ? "Правило создано" : "Правило сохранено");
            void rules.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(undefined)}
        title="Удалить правило?"
        confirmLabel="Удалить"
        onConfirm={async () => {
          if (!removing) return;
          await api.removeRule(removing.id);
          toast("Правило удалено");
          await rules.reload();
        }}
      >
        {removing && (
          <p>
            {removing.decision === "allow" ? "Похожие действия снова будут требовать подтверждения" : "Действия, которые запрещало правило, снова будут решаться общей политикой"}:{" "}
            <span className="font-mono text-fg">{removing.tool}</span>
            {removing.agentId ? ` для агента ${removing.agentId}` : ""}.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function RuleCard({ rule, onEdit, onRemove }: { rule: Rule; onEdit: () => void; onRemove: () => void }) {
  const allow = rule.decision === "allow";
  return (
    <Card className="p-3.5 sm:p-4">
      <div className="flex items-start gap-3">
        <span className={allow ? "mt-0.5 text-ok" : "mt-0.5 text-danger"} aria-hidden>
          {allow ? <CheckCircle2 className="size-5" /> : <Ban className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={allow ? "ok" : "danger"}>{allow ? "разрешать" : "запрещать"}</Badge>
            <span className="font-mono text-sm font-medium break-all text-fg">{rule.tool}</span>
            <span className="text-xs text-muted">· {rule.agentId ? <>агент <span className="font-mono text-fg">{rule.agentId}</span></> : "любой агент"}</span>
          </div>
          {rule.conditions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {rule.conditions.map((c, i) => (
                <ConditionChip key={i} c={c} />
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-muted">Без условий — любой вход</p>
          )}
          {rule.note && <p className="mt-2 text-sm text-fg">{rule.note}</p>}
          <p className="mt-1.5 text-xs text-faint">
            Создано {VIA[rule.createdVia] ?? rule.createdVia} · {formatDate(rule.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton label="Изменить правило" onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton label="Удалить правило" onClick={onRemove} className="hover:text-danger">
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </div>
    </Card>
  );
}

function RuleEditor({ rule, onClose, onSaved }: { rule?: Rule; onClose: () => void; onSaved: (created: boolean) => void }) {
  const tools = useTools();
  const [form, setForm] = useState<RuleFormValue>(() => (rule ? formFromRule(rule) : emptyRuleForm()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    const r = ruleFromForm(form);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (rule) {
        await api.updateRule(rule.id, { tool: r.rule.tool, agentId: r.rule.agentId ?? null, conditions: r.rule.conditions, decision: r.rule.decision, note: r.rule.note ?? null });
      } else {
        await api.createRule(r.rule);
      }
      onSaved(!rule);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={rule ? "Изменить правило" : "Новое правило"}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            {rule ? "Сохранить" : "Создать правило"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RuleForm value={form} onChange={setForm} tools={tools} />
        <ErrorText>{error}</ErrorText>
      </div>
    </Dialog>
  );
}
