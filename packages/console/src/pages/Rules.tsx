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
import { t, type MessageKey } from "../i18n/index.ts";

const viaLabel = (via: string): string => (["console", "telegram", "approval"].includes(via) ? t(`rules.via.${via}` as MessageKey) : via);

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
        title={t("rules.title")}
        description={t("rules.description")}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            {t("rules.new")}
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
              { value: "all", label: t("rules.filter.all", { count: rules.data.length }) },
              { value: "allow", label: t("rules.filter.allow") },
              { value: "deny", label: t("rules.filter.deny") },
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
        <EmptyState icon={<ListChecks className="size-8" />} title={t("rules.empty.title")}>
          {t("rules.empty.body")}
        </EmptyState>
      ) : (
        <div className="space-y-2.5">
          {list.map((r) => (
            <RuleCard key={r.id} rule={r} onEdit={() => setEditing(r)} onRemove={() => setRemoving(r)} />
          ))}
          {list.length === 0 && <p className="py-6 text-center text-sm text-muted">{t("rules.filterEmpty")}</p>}
        </div>
      )}

      {editing && (
        <RuleEditor
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(created) => {
            setEditing(undefined);
            toast(created ? t("rules.created") : t("rules.saved"));
            void rules.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(undefined)}
        title={t("rules.remove.title")}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          if (!removing) return;
          await api.removeRule(removing.id);
          toast(t("rules.removed"));
          await rules.reload();
        }}
      >
        {removing && (
          <p>
            {removing.decision === "allow" ? t("rules.remove.allow") : t("rules.remove.deny")}:{" "}
            <span className="font-mono text-fg">{removing.tool}</span>
            {removing.agentId ? t("rules.remove.forAgent", { agent: removing.agentId }) : ""}.
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
            <Badge tone={allow ? "ok" : "danger"}>{allow ? t("rules.badge.allow") : t("rules.badge.deny")}</Badge>
            <span className="font-mono text-sm font-medium break-all text-fg">{rule.tool}</span>
            <span className="text-xs text-muted">· {rule.agentId ? <>{t("rules.agent")} <span className="font-mono text-fg">{rule.agentId}</span></> : t("rules.anyAgent")}</span>
          </div>
          {rule.conditions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {rule.conditions.map((c, i) => (
                <ConditionChip key={i} c={c} />
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-muted">{t("rules.noConditions")}</p>
          )}
          {rule.note && <p className="mt-2 text-sm text-fg">{rule.note}</p>}
          <p className="mt-1.5 text-xs text-faint">
            {t("rules.createdLine", { via: viaLabel(rule.createdVia), date: formatDate(rule.createdAt) })}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton label={t("rules.edit")} onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton label={t("rules.delete")} onClick={onRemove} className="hover:text-danger">
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
      title={rule ? t("rules.edit") : t("rules.new")}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            {rule ? t("common.save") : t("rules.create")}
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
