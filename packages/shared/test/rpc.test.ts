import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { ndjsonTransport } from "../src/rpc.ts";

describe("ndjsonTransport", () => {
  it("splits lines that arrive together and lines split across chunks", () => {
    const input = new PassThrough();
    const got: string[] = [];
    ndjsonTransport(input, new PassThrough()).onMessage((m) => got.push(m));
    input.write('{"a":1}\n{"b"');
    input.write(':2}\n\n{"c":3}\n');
    expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("takes a 30 MB line in small chunks quickly (a file passed inline)", () => {
    const input = new PassThrough();
    const got: string[] = [];
    ndjsonTransport(input, new PassThrough()).onMessage((m) => got.push(m));
    const line = `{"data":"${"x".repeat(30 * 1024 * 1024)}"}`;
    const started = Date.now();
    for (let i = 0; i < line.length; i += 64 * 1024) input.write(line.slice(i, i + 64 * 1024));
    input.write("\n");
    expect(got).toHaveLength(1);
    expect(got[0].length).toBe(line.length);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
