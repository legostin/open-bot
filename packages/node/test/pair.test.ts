// pair() against a stubbed fetch: the phones' address behind the hub's link, and what a self-signed hub says.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/home.ts";
import { linkForPhoneAddress, pair } from "../src/pair.ts";

const LINK = "https://owlbot.tail1234.ts.net";

/** What fetch() throws for the hub's own certificate on the phones' port. */
function selfSigned(): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
  });
}

describe("pairing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("knows the phones' address behind the link", () => {
    expect(linkForPhoneAddress(`${LINK}:8443`)).toBe(LINK);
    expect(linkForPhoneAddress(LINK)).toBeUndefined();
    expect(linkForPhoneAddress("https://192.168.1.2:8443")).toBeUndefined();
    expect(linkForPhoneAddress("http://owlbot.tail1234.ts.net:8443")).toBeUndefined();
  });

  it("pairs through the link when given the phones' address", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.startsWith(`${LINK}:8443/`)) throw selfSigned();
      return new Response(JSON.stringify({ machineId: "m1", name: "pc" }), { status: 200 });
    });
    const home = mkdtempSync(join(tmpdir(), "owl-pair-"));
    const r = await pair({ home, hubUrl: `${LINK}:8443`, code: "AB12CD34", name: "pc" });
    expect(urls).toEqual([`${LINK}:8443/api/node/pair`, `${LINK}/api/node/pair`]);
    expect(r.hubUrl).toBe(LINK);
    expect(loadConfig(home).hubUrl).toBe(LINK);
  });

  it("says a self-signed hub address is the phones' one", async () => {
    vi.stubGlobal("fetch", async () => {
      throw selfSigned();
    });
    const home = mkdtempSync(join(tmpdir(), "owl-pair-"));
    await expect(pair({ home, hubUrl: "https://192.168.1.2:8082", code: "AB12CD34" })).rejects.toThrow(/own certificate.*phones/s);
  });
});
