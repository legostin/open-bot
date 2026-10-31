import { describe, expect, it } from "vitest";
import { CONTENT } from "./index";

/** Keys, value types and list lengths: what the scripts rely on, without the words. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

function blanks(v: unknown, path = ""): string[] {
  if (typeof v === "string") return v.trim() ? [] : [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => blanks(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => blanks(x, path ? `${path}.${k}` : k));
  return [];
}

describe("demo content", () => {
  it("has the same shape in every locale", () => {
    const [first, ...rest] = Object.values(CONTENT);
    for (const c of rest) expect(shape({ ...c, locale: "" })).toEqual(shape({ ...first, locale: "" }));
  });

  it("has no empty lines", () => {
    for (const c of Object.values(CONTENT)) expect(blanks({ ...c, history: undefined })).toEqual([]);
  });
});
