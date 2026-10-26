// Removes known secret values from any text that leaves the trusted core
// (tool results going to models, transcripts, channel messages, logs).

const MIN_SECRET_LEN = 6;

export class Redactor {
  private patterns: Array<{ needle: string; label: string }> = [];

  setSecrets(secrets: Array<{ id: string; value: string }>): void {
    const list: Array<{ needle: string; label: string }> = [];
    for (const { id, value } of secrets) {
      if (!value || value.length < MIN_SECRET_LEN) continue;
      const label = `[redacted: vault://${id}]`;
      const variants = new Set<string>([value, Buffer.from(value).toString("base64"), encodeURIComponent(value)]);
      try {
        variants.add(Buffer.from(value).toString("base64url"));
      } catch {
        /* ignore */
      }
      for (const v of variants) if (v.length >= MIN_SECRET_LEN) list.push({ needle: v, label });
    }
    // Longest first so a secret containing another secret is replaced whole.
    list.sort((a, b) => b.needle.length - a.needle.length);
    this.patterns = list;
  }

  clear(): void {
    this.patterns = [];
  }

  get active(): boolean {
    return this.patterns.length > 0;
  }

  text(s: string): string {
    if (!s || this.patterns.length === 0) return s;
    let out = s;
    for (const { needle, label } of this.patterns) {
      if (out.includes(needle)) out = out.split(needle).join(label);
    }
    return out;
  }

  /** Deep-redact strings inside any JSON-like value. */
  value<T>(v: T): T {
    if (this.patterns.length === 0) return v;
    if (typeof v === "string") return this.text(v) as unknown as T;
    if (Array.isArray(v)) return v.map((x) => this.value(x)) as unknown as T;
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = this.value(x);
      return o as T;
    }
    return v;
  }
}
