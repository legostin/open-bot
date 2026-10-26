// Rule editor shared by the Rules page and the "always allow" flow of an approval card.

import { useId, useMemo } from "react";
import { CheckCircle2, Plus, Trash2, XCircle } from "lucide-react";
import type { Rule, RuleCondition, RuleDraft, ToolInfo } from "../types.ts";
import { fieldPaths, getField, globToRegExp, ruleMatchesInput } from "../lib/match.ts";
import { Button, Callout, cx, Field, IconButton, Input, Segmented, Select, Switch } from "../ui/kit.tsx";

export interface RuleFormValue {
  tool: string;
  agentId: string;
  conditions: Array<{ field: string; op: RuleCondition["op"]; value: string }>;
  decision: "allow" | "deny";
  note: string;
}

export const OP_LABELS: Record<RuleCondition["op"], string> = {
  eq: "равно",
  glob: "шаблон",
  domain: "домен",
};

export const OP_HINTS: Record<RuleCondition["op"], string> = {
  eq: "точное совпадение",
  glob: "* — любые символы, ? — один символ",
  domain: "домен ссылки или email, включая поддомены",
};

export function formFromRule(r: RuleDraft | Rule): RuleFormValue {
  return {
    tool: r.tool,
    agentId: r.agentId ?? "",
    conditions: r.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
    decision: r.decision,
    note: r.note ?? "",
  };
}

export function emptyRuleForm(): RuleFormValue {
  return { tool: "", agentId: "", conditions: [], decision: "allow", note: "" };
}

export type RuleFormResult = { ok: true; rule: RuleDraft } | { ok: false; error: string };

export function ruleFromForm(v: RuleFormValue): RuleFormResult {
  const tool = v.tool.trim();
  if (!tool) return { ok: false, error: "Укажите инструмент или шаблон" };
  if (!/^[a-zA-Z0-9_\-*?]+$/.test(tool)) return { ok: false, error: "Имя инструмента: латиница, цифры, «_», «-»; для шаблона — «*» и «?»" };
  const conditions: RuleCondition[] = [];
  for (const c of v.conditions) {
    const field = c.field.trim();
    const value = c.value.trim();
    if (!field && !value) continue;
    if (!field) return { ok: false, error: "У условия не указано поле" };
    if (!value) return { ok: false, error: `У условия «${field}» не указано значение` };
    conditions.push({ field, op: c.op, value });
  }
  const rule: RuleDraft = { tool, conditions, decision: v.decision };
  if (v.agentId.trim()) rule.agentId = v.agentId.trim();
  if (v.note.trim()) rule.note = v.note.trim();
  return { ok: true, rule };
}

export function ConditionChip({ c }: { c: RuleCondition }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-inset px-1.5 py-0.5 font-mono text-xs ring-1 ring-line">
      <span className="text-fg">{c.field}</span>
      <span className="font-sans text-faint">{OP_LABELS[c.op]}</span>
      <span className="truncate font-medium text-brand-fg">{c.value}</span>
    </span>
  );
}

export function RuleForm({
  value,
  onChange,
  tools,
  sample,
}: {
  value: RuleFormValue;
  onChange: (v: RuleFormValue) => void;
  tools: ToolInfo[];
  /** When the rule comes from an approval: preview against that exact call, decision fixed to allow. */
  sample?: { tool: string; agentId: string; agentName?: string; input: unknown };
}) {
  const toolListId = useId();
  const fieldListId = useId();
  const set = (patch: Partial<RuleFormValue>) => onChange({ ...value, ...patch });
  const setCond = (i: number, patch: Partial<RuleFormValue["conditions"][number]>) => {
    const next = value.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c));
    set({ conditions: next });
  };

  const tool = value.tool.trim();
  const exact = tools.find((t) => t.name === tool);
  const isGlob = /[*?]/.test(tool);
  const globCount = useMemo(() => {
    if (!isGlob) return 0;
    try {
      const re = globToRegExp(tool);
      return tools.filter((t) => re.test(t.name)).length;
    } catch {
      return 0;
    }
  }, [isGlob, tool, tools]);

  const fields = useMemo(() => (sample ? fieldPaths(sample.input) : []), [sample]);
  const parsed = ruleFromForm(value);
  const matches = sample && parsed.ok ? ruleMatchesInput(parsed.rule, sample.tool, sample.agentId, sample.input) : undefined;
  const effectiveConditions = parsed.ok ? parsed.rule.conditions.length : value.conditions.length;

  return (
    <div className="space-y-5">
      <Field
        label="Инструмент"
        htmlFor="rule-tool"
        hint={
          exact ? (
            <span>
              {exact.description || "Без описания"} <span className="text-faint">· {effectLabel(exact.effect)} · {exact.owner}</span>
            </span>
          ) : isGlob ? (
            `Шаблон: подходит инструментов сейчас — ${globCount}`
          ) : tool ? (
            "Такого инструмента сейчас нет — правило сработает, когда он появится"
          ) : (
            "Точное имя или шаблон, например browser_*"
          )
        }
      >
        <Input id="rule-tool" mono list={toolListId} value={value.tool} onChange={(e) => set({ tool: e.target.value })} placeholder="mail_send" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <datalist id={toolListId}>
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.description}
            </option>
          ))}
        </datalist>
      </Field>

      {sample ? (
        <Switch
          checked={!!value.agentId}
          onChange={(on) => set({ agentId: on ? sample.agentId : "" })}
          label={`Только для агента «${sample.agentName ?? sample.agentId}»`}
          description="Если выключить, правило будет действовать для всех агентов."
        />
      ) : (
        <Field label="Агент" htmlFor="rule-agent" hint="id агента; пусто — правило действует для всех агентов">
          <Input id="rule-agent" mono value={value.agentId} onChange={(e) => set({ agentId: e.target.value })} placeholder="любой агент" autoCapitalize="off" spellCheck={false} />
        </Field>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-fg">Условия на вход</span>
          <span className="text-xs text-muted">все условия должны выполняться</span>
        </div>
        {value.conditions.length === 0 && <p className="mb-2 text-sm text-muted">Условий нет — правило подходит для любого входа.</p>}
        <div className="space-y-2">
          {value.conditions.map((c, i) => (
            <div key={i} className="rounded-lg border border-line bg-inset/60 p-2 sm:p-2.5">
              <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] gap-2 sm:grid-cols-[minmax(0,10rem)_8.5rem_minmax(0,1fr)_auto]">
                <Input
                  mono
                  aria-label="Поле"
                  placeholder="поле, напр. to"
                  list={fields.length ? fieldListId : undefined}
                  value={c.field}
                  onChange={(e) => {
                    const field = e.target.value;
                    const patch: Partial<RuleFormValue["conditions"][number]> = { field };
                    if (sample && !c.value) {
                      const v = getField(sample.input, field);
                      if (typeof v === "string" || typeof v === "number") patch.value = String(v);
                    }
                    setCond(i, patch);
                  }}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <Select aria-label="Сравнение" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as RuleCondition["op"] })}>
                  {(Object.keys(OP_LABELS) as Array<RuleCondition["op"]>).map((op) => (
                    <option key={op} value={op}>
                      {OP_LABELS[op]}
                    </option>
                  ))}
                </Select>
                <Input
                  mono
                  aria-label="Значение"
                  placeholder={c.op === "domain" ? "example.com" : c.op === "glob" ? "*@example.com" : "значение"}
                  value={c.value}
                  onChange={(e) => setCond(i, { value: e.target.value })}
                  className="order-last col-span-3 sm:order-none sm:col-span-1"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <IconButton label="Удалить условие" onClick={() => set({ conditions: value.conditions.filter((_, j) => j !== i) })} className="size-10">
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
              <p className="mt-1.5 px-0.5 text-xs text-muted">{OP_HINTS[c.op]}</p>
            </div>
          ))}
        </div>
        {fields.length > 0 && (
          <datalist id={fieldListId}>
            {fields.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        )}
        <Button size="sm" className="mt-2" icon={<Plus className="size-4" />} onClick={() => set({ conditions: [...value.conditions, { field: "", op: "eq", value: "" }] })}>
          Добавить условие
        </Button>
        <p className="mt-2 text-xs text-muted">Вложенные поля — через точку: options.cc. Для списков условие должно выполняться для каждого элемента.</p>
      </div>

      {!sample && (
        <Field label="Решение">
          <Segmented
            value={value.decision}
            onChange={(d) => set({ decision: d })}
            options={[
              { value: "allow", label: "Разрешать без вопроса" },
              { value: "deny", label: "Всегда запрещать" },
            ]}
          />
        </Field>
      )}

      <Field label="Заметка" htmlFor="rule-note" hint="Необязательно: зачем это правило">
        <Input id="rule-note" value={value.note} onChange={(e) => set({ note: e.target.value })} placeholder="например: рассылка коллегам" />
      </Field>

      {value.decision === "allow" && tool === "*" && (
        <Callout tone="danger" title="Шаблон «*» разрешит все внешние действия">
          Любой агент сможет отправлять письма, сообщения и запросы без подтверждения. Сузьте правило.
        </Callout>
      )}
      {value.decision === "allow" && tool !== "*" && effectiveConditions === 0 && (
        <Callout tone="warn" title="Правило без условий">
          Оно разрешит любые вызовы {tool ? <span className="font-mono">{tool}</span> : "инструмента"}
          {value.agentId.trim() ? " для этого агента" : " для всех агентов"} — с любыми адресатами и содержимым.
        </Callout>
      )}
      {value.decision === "allow" && (
        <p className="text-xs leading-relaxed text-muted">
          Правила «разрешать» действуют только на внешние действия. Если сессия читала внешний контент, правило не сработает для адресатов и доменов, которые вы ещё ни разу не одобряли.
        </p>
      )}
      {sample && matches !== undefined && (
        <div className={cx("flex items-center gap-2 text-sm", matches ? "text-ok" : "text-warn")}>
          {matches ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
          {matches ? "Правило подходит к текущему запросу" : "Правило не подходит к текущему запросу — проверьте условия"}
        </div>
      )}
    </div>
  );
}

export function effectLabel(e: string): string {
  return e === "external" ? "внешнее действие" : e === "local-write" ? "локальное изменение" : e === "read" ? "чтение" : e;
}
