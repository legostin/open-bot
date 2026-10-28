import { describe, expect, it } from "vitest";
import { desktopPairLink, deviceUrls, inviteUrl, machineHubUrl, pairingLink, parsePairingLink, qrSvg, qrText } from "../src/pairing.ts";

describe("pairing link", () => {
  it("carries the code, name, fingerprint and every address, and parses back", () => {
    const p = { code: "K7QF2M9X", hubName: "MacBook & co", fingerprint: "abc_-123", urls: ["https://192.168.1.2:8082", "https://100.83.162.114:8082"] };
    const link = pairingLink(p);
    expect(link.startsWith("owlbot://pair?v=1&")).toBe(true);
    expect(parsePairingLink(link)).toEqual(p);
    expect(parsePairingLink("https://example.com/pair?c=1")).toBeUndefined();
  });

  it("ranks Wi-Fi first, then other private addresses, then Tailscale; skips loopback, link-local and IPv6", () => {
    const iface = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as any;
    const urls = deviceUrls(8082, ["https://nas.example:8082"], {
      lo0: [iface("127.0.0.1", "IPv4", true)],
      utun4: [iface("100.83.162.114")],
      bridge100: [iface("192.168.215.1")],
      bridge101: [iface("192.168.216.0")],
      en0: [iface("192.168.1.2"), iface("fe80::1", "IPv6")],
      en5: [iface("169.254.189.6")],
    });
    expect(urls).toEqual(["https://nas.example:8082", "https://192.168.1.2:8082", "https://192.168.215.1:8082", "https://100.83.162.114:8082"]);
  });

  it("draws the QR as SVG and as terminal text", () => {
    const link = pairingLink({ code: "ABCDEFGH", hubName: "hub", fingerprint: "f".repeat(43), urls: ["https://10.0.0.2:8082"] });
    expect(qrSvg(link)).toMatch(/^<svg[\s\S]*<\/svg>$/);
    const text = qrText(link);
    expect(text.split("\n").length).toBeGreaterThan(10);
    expect(text).toMatch(/[█▀▄]/);
  });
});

describe("machine pairing address", () => {
  it("is the link when the hub's own address works only on this computer, never the phones' port", () => {
    const link = "https://owlbot.tail1234.ts.net";
    expect(machineHubUrl("http://localhost:8080", link)).toBe(link);
    expect(machineHubUrl("http://127.0.0.1:8080", link)).toBe(link);
    expect(machineHubUrl("https://bot.example.com", link)).toBe("https://bot.example.com");
    expect(machineHubUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("makes an invite link only where other devices can open it, and the desktop app's link", () => {
    expect(inviteUrl("https://owlbot.tail1234.ts.net", "AB12CD34")).toBe("https://owlbot.tail1234.ts.net/join/AB12CD34");
    expect(inviteUrl("http://localhost:8080", "AB12CD34")).toBeUndefined();
    expect(desktopPairLink("https://owlbot.tail1234.ts.net", "AB12CD34")).toBe("owlbot://pair?hub=https%3A%2F%2Fowlbot.tail1234.ts.net&code=AB12CD34");
  });
});
