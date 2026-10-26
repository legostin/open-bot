// Minimal class override for form controls: Tailwind gives no ordering guarantee between
// two utilities on the same property (h-8 vs h-10), so a caller's override must replace the default.

const GROUPS = ["min-w", "max-w", "w", "min-h", "max-h", "h", "rounded", "px", "py", "pl", "pr"];

function groupOf(cls: string): string | undefined {
  if (cls.includes(":")) return undefined; // variants (sm:w-40) never conflict with the base
  const c = cls.replace(/^!|!$/g, "");
  return GROUPS.find((g) => c === g || c.startsWith(g + "-"));
}

/** Join base and extra classes, dropping base utilities whose group the extra classes override. */
export function mergeClasses(base: string, extra?: string): string {
  if (!extra) return base;
  const overridden = new Set(extra.split(/\s+/).map(groupOf).filter(Boolean));
  const kept = base.split(/\s+/).filter((c) => {
    const g = groupOf(c);
    return !g || !overridden.has(g);
  });
  return [...kept, extra].join(" ");
}
