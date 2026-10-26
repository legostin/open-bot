// Turn a plugin's contributes.settings JSON Schema into form fields, and form values back into settings.
// Supported: string (with enum → select, multiline via format "textarea"), number/integer, boolean,
// array of strings. Anything else is edited as JSON.

import { t } from "../i18n";

export type FieldKind = "string" | "text" | "secret" | "number" | "integer" | "boolean" | "enum" | "string-list" | "json";

export interface FormField {
  key: string;
  kind: FieldKind;
  label: string;
  description?: string;
  required: boolean;
  options?: Array<{ value: string; label: string; raw: unknown }>;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
}

type Schema = Record<string, any>;

function typeOf(s: Schema): string | undefined {
  if (Array.isArray(s.type)) return s.type.find((t: string) => t !== "null");
  return s.type;
}

export function schemaFields(schema: unknown): FormField[] {
  const s = (schema ?? {}) as Schema;
  // Accept both a full object schema and a bare {key: schema} map.
  const props: Record<string, Schema> = s.properties && typeof s.properties === "object" ? s.properties : s.type ? {} : (s as Record<string, Schema>);
  const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
  const out: FormField[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Schema;
    const base = {
      key,
      label: String(p.title ?? key),
      description: typeof p.description === "string" ? p.description : undefined,
      required: required.has(key),
      defaultValue: p.default,
      placeholder: typeof p.examples?.[0] === "string" ? p.examples[0] : undefined,
    };
    const t = typeOf(p);
    if (Array.isArray(p.enum)) {
      out.push({ ...base, kind: "enum", options: p.enum.map((v: unknown, i: number) => ({ value: String(v), label: String(p.enumNames?.[i] ?? v), raw: v })) });
    } else if (t === "boolean") out.push({ ...base, kind: "boolean" });
    else if (t === "number" || t === "integer") out.push({ ...base, kind: t, min: p.minimum, max: p.maximum });
    else if (t === "string") {
      const multiline = p.format === "textarea" || p["x-multiline"] === true || (typeof p.maxLength === "number" && p.maxLength > 200);
      out.push({ ...base, kind: p.format === "password" || p.writeOnly ? "secret" : multiline ? "text" : "string" });
    } else if (t === "array" && (!p.items || typeOf(p.items) === "string" || Array.isArray(p.items?.enum))) out.push({ ...base, kind: "string-list" });
    else out.push({ ...base, kind: "json" });
  }
  return out;
}

/** Form state (strings/booleans) from current settings, falling back to schema defaults. */
export function initialFormValues(fields: FormField[], current: Record<string, unknown> | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = current && f.key in current ? current[f.key] : f.defaultValue;
    switch (f.kind) {
      case "boolean":
        out[f.key] = v === true;
        break;
      case "string-list":
        out[f.key] = Array.isArray(v) ? v.map(String).join("\n") : "";
        break;
      case "json":
        out[f.key] = v === undefined ? "" : JSON.stringify(v, null, 2);
        break;
      default:
        out[f.key] = v === undefined || v === null ? "" : String(v);
    }
  }
  return out;
}

export interface CoerceResult {
  values: Record<string, unknown>;
  errors: Record<string, string>;
}

/** Convert form state back into typed settings. Empty optional fields are omitted. */
export function coerceFormValues(fields: FormField[], form: Record<string, string | boolean>): CoerceResult {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = form[f.key];
    if (f.kind === "boolean") {
      values[f.key] = raw === true;
      continue;
    }
    const str = typeof raw === "string" ? raw : "";
    if (str.trim() === "") {
      if (f.required) errors[f.key] = t("form.required");
      continue;
    }
    switch (f.kind) {
      case "number":
      case "integer": {
        const n = Number(str.replace(",", "."));
        if (!Number.isFinite(n)) errors[f.key] = t("form.number");
        else if (f.kind === "integer" && !Number.isInteger(n)) errors[f.key] = t("form.integer");
        else if (f.min !== undefined && n < f.min) errors[f.key] = t("form.min", { min: f.min });
        else if (f.max !== undefined && n > f.max) errors[f.key] = t("form.max", { max: f.max });
        else values[f.key] = n;
        break;
      }
      case "string-list":
        values[f.key] = str
          .split(/\r?\n|,/)
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "json":
        try {
          values[f.key] = JSON.parse(str);
        } catch {
          errors[f.key] = t("form.badJson");
        }
        break;
      case "enum":
        values[f.key] = f.options?.find((o) => o.value === str)?.raw ?? str;
        break;
      default:
        values[f.key] = str;
    }
  }
  return { values, errors };
}
