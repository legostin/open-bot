// Glob matching for tool names (same semantics as @piomio/shared globToRegExp: * = any chars, ? = one char,
// case-insensitive). Kept local because @piomio/shared's runtime pulls in Node modules.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    re = new RegExp(`^${esc}$`, "i");
    cache.set(glob, re);
  }
  return re;
}

export function matchesGlob(name: string, glob: string): boolean {
  return globToRegExp(glob).test(name);
}

/** Accepts a single glob or a list (plugins sometimes pass a string). */
export function matchesAny(name: string, globs: string | string[] | undefined): boolean {
  if (!globs) return false;
  const list = Array.isArray(globs) ? globs : [globs];
  return list.some((g) => matchesGlob(name, g));
}

/** How specific a glob is: more literal characters = more specific. Used to break ties. */
export function globSpecificity(glob: string): number {
  return glob.replace(/[*?]/g, "").length;
}
