// Form generated from a JSON Schema (plugin contributes.settings).

import { useMemo, useState } from "react";
import { coerceFormValues, initialFormValues, schemaFields, type FormField } from "../lib/schema-form";
import { Button, ErrorNote, Field, Input, Select, Textarea, Toggle } from "./ui";

export function SchemaForm({
  schema,
  value,
  onSubmit,
  submitLabel = "Сохранить",
}: {
  schema: unknown;
  value: Record<string, unknown> | undefined;
  onSubmit: (v: Record<string, unknown>) => Promise<void>;
  submitLabel?: string;
}) {
  const fields = useMemo(() => schemaFields(schema), [schema]);
  const [form, setForm] = useState(() => initialFormValues(fields, value));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!fields.length) return <div className="text-sm text-muted">У плагина нет настроек.</div>;

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const r = coerceFormValues(fields, form);
    setErrors(r.errors);
    setError(undefined);
    if (Object.keys(r.errors).length) return;
    setBusy(true);
    try {
      // Keep unknown keys the schema does not describe.
      await onSubmit({ ...(value ?? {}), ...Object.fromEntries(fields.map((f) => [f.key, undefined])), ...r.values });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {fields.map((f) => (
        <FieldControl key={f.key} field={f} value={form[f.key]} error={errors[f.key]} onChange={(v) => set(f.key, v)} />
      ))}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function FieldControl({ field: f, value, error, onChange }: { field: FormField; value: string | boolean; error?: string; onChange: (v: string | boolean) => void }) {
  const label = (
    <>
      {f.label}
      {f.required && <span className="text-danger"> *</span>}
    </>
  );
  if (f.kind === "boolean") {
    return (
      <div>
        <Toggle checked={value === true} onChange={onChange} label={<span className="font-medium">{label}</span>} />
        {f.description && <div className="mt-1 pl-12 text-xs text-muted">{f.description}</div>}
      </div>
    );
  }
  const str = typeof value === "string" ? value : "";
  const hint =
    f.kind === "string-list"
      ? `${f.description ? f.description + " · " : ""}по одному значению на строку`
      : f.kind === "secret"
        ? `${f.description ? f.description + " · " : ""}секреты храните в vault и указывайте ссылку vault://<id>`
        : f.description;
  return (
    <Field label={label} hint={hint} error={error}>
      {f.kind === "enum" ? (
        <Select value={str} onChange={(e) => onChange(e.target.value)}>
          {!f.required && <option value="">—</option>}
          {f.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : f.kind === "text" || f.kind === "string-list" || f.kind === "json" ? (
        <Textarea rows={f.kind === "json" ? 6 : 3} value={str} onChange={(e) => onChange(e.target.value)} className={f.kind !== "text" ? "font-mono text-[13px]" : ""} placeholder={f.placeholder} />
      ) : (
        <Input
          type={f.kind === "number" || f.kind === "integer" ? "number" : "text"}
          step={f.kind === "integer" ? 1 : "any"}
          min={f.min}
          max={f.max}
          value={str}
          placeholder={f.placeholder ?? (f.kind === "secret" ? "vault://…" : undefined)}
          onChange={(e) => onChange(e.target.value)}
          className={f.kind === "secret" ? "font-mono" : undefined}
          autoComplete="off"
        />
      )}
    </Field>
  );
}
