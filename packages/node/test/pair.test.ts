// pair() against a stubbed fetch: the phones' address behind the hub's link, and what a self-signed hub says.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, nodeHome, parseInviteLink } from "../src/home.ts";
import { linkForPhoneAddress, pair } from "../src/pair.ts";

const LINK = "https://piomio.tail1234.ts.net";

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
    expect(linkForPhoneAddress("http://piomio.tail1234.ts.net:8443")).toBeUndefined();
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

  it("reads an invite link: the hub's page or the desktop app's link", () => {
    expect(parseInviteLink(`${LINK}/join/AB12CD34`)).toEqual({ hubUrl: LINK, code: "AB12CD34" });
    expect(parseInviteLink(" http://192.168.1.2:8080/join/ab12cd34/ ")).toEqual({ hubUrl: "http://192.168.1.2:8080", code: "ab12cd34" });
    expect(parseInviteLink("https://example.com/piomio/join/AB12CD34")).toEqual({ hubUrl: "https://example.com/piomio", code: "AB12CD34" });
    expect(parseInviteLink(`piomio://pair?hub=${encodeURIComponent(LINK)}&code=AB12CD34`)).toEqual({ hubUrl: LINK, code: "AB12CD34" });
    expect(parseInviteLink(LINK)).toBeUndefined();
    expect(parseInviteLink("piomio://pair?v=1&c=AB12CD34")).toBeUndefined();
    expect(parseInviteLink("not a link")).toBeUndefined();
  });

  it("keeps a machine's pairing from when Piomio was Owlbot", () => {
    const user = mkdtempSync(join(tmpdir(), "piomio-home-"));
    expect(nodeHome({}, user)).toBe(join(user, ".piomio-node"));
    mkdirSync(join(user, ".owlbot-node"));
    writeFileSync(join(user, ".owlbot-node", "key.json"), "{}");
    expect(nodeHome({}, user)).toBe(join(user, ".piomio-node"));
    expect([existsSync(join(user, ".piomio-node", "key.json")), existsSync(join(user, ".owlbot-node"))]).toEqual([true, false]);
    expect(nodeHome({ PIOMIO_NODE_HOME: join(user, "elsewhere") }, user)).toBe(join(user, "elsewhere"));
  });
});
