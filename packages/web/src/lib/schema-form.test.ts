import { describe, expect, it } from "vitest";
import { coerceFormValues, initialFormValues, schemaFields } from "./schema-form";

const schema = {
  type: "object",
  required: ["token"],
  properties: {
    token: { type: "string", title: "Token", format: "password" },
    chatName: { type: "string", default: "bot" },
    interval: { type: "integer", minimum: 1, maximum: 60, default: 5 },
    ratio: { type: "number" },
    enabled: { type: "boolean", default: true },
    mode: { type: "string", enum: ["fast", "slow"] },
    level: { enum: [1, 2, 3], default: 2 },
    hosts: { type: "array", items: { type: "string" } },
    extra: { type: "object" },
  },
};

describe("schemaFields", () => {
  it("maps JSON schema types to field kinds", () => {
    const f = Object.fromEntries(schemaFields(schema).map((x) => [x.key, x]));
    expect(f.token.kind).toBe("secret");
    expect(f.token.label).toBe("Token");
    expect(f.token.required).toBe(true);
    expect(f.chatName.kind).toBe("string");
    expect(f.interval.kind).toBe("integer");
    expect(f.ratio.kind).toBe("number");
    expect(f.enabled.kind).toBe("boolean");
    expect(f.mode.kind).toBe("enum");
    expect(f.mode.options?.map((o) => o.value)).toEqual(["fast", "slow"]);
    expect(f.hosts.kind).toBe("string-list");
    expect(f.extra.kind).toBe("json");
  });
  it("accepts a bare properties map", () => {
    expect(schemaFields({ a: { type: "string" } }).map((f) => f.key)).toEqual(["a"]);
  });
});

describe("form values", () => {
  const fields = schemaFields(schema);
  it("initialises from current settings and defaults", () => {
    const v = initialFormValues(fields, { hosts: ["a.com", "b.com"], chatName: "x" });
    expect(v.chatName).toBe("x");
    expect(v.interval).toBe("5");
    expect(v.enabled).toBe(true);
    expect(v.hosts).toBe("a.com\nb.com");
    expect(v.token).toBe("");
  });
  it("coerces back to typed values and validates", () => {
    const form = { ...initialFormValues(fields, {}), token: "vault://tg", interval: "10", ratio: "0,5", hosts: "a.com, b.com\nc.com", mode: "slow", level: "3" };
    const r = coerceFormValues(fields, form);
    expect(r.errors).toEqual({});
    expect(r.values).toMatchObject({ token: "vault://tg", interval: 10, ratio: 0.5, enabled: true, hosts: ["a.com", "b.com", "c.com"], mode: "slow", level: 3 });
    expect("extra" in r.values).toBe(false);
  });
  it("reports errors", () => {
    const form = { ...initialFormValues(fields, {}), interval: "100", extra: "{bad" };
    const r = coerceFormValues(fields, form);
    expect(r.errors.token).toBeTruthy();
    expect(r.errors.interval).toMatch(/60/);
    expect(r.errors.extra).toMatch(/JSON/);
  });
});
