// What a phone needs to pair: the link the QR carries (owlbot://pair?…), the hub's addresses on the device port and
// the QR itself (SVG for the web UI, text for the terminal).

import { hostname, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import qrcode from "qrcode-generator";

export const PAIRING_LINK_VERSION = "1";

export function pairingLink(p: { code: string; hubName: string; fingerprint: string; urls: string[] }): string {
  const q = new URLSearchParams({ v: PAIRING_LINK_VERSION, c: p.code, n: p.hubName, fp: p.fingerprint });
  for (const u of p.urls) q.append("u", u);
  return `owlbot://pair?${q}`;
}

export function parsePairingLink(link: string): { code: string; hubName: string; fingerprint: string; urls: string[] } | undefined {
  try {
    const u = new URL(link);
    if (u.protocol !== "owlbot:" || u.hostname !== "pair") return undefined;
    const q = u.searchParams;
    return { code: q.get("c") ?? "", hubName: q.get("n") ?? "", fingerprint: q.get("fp") ?? "", urls: q.getAll("u") };
  } catch {
    return undefined;
  }
}

/** The hub's name on phones: the computer's name without ".local". */
export function hubName(): string {
  return hostname().replace(/\.local$/i, "").slice(0, 60) || "Owlbot";
}

const isPrivate = (ip: string) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
/** Tailscale and other CGNAT overlays: 100.64.0.0/10. */
const isTailnet = (ip: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
/** Wired and Wi-Fi interfaces first; VM bridges and the like after. */
const isPhysical = (name: string) => /^(en|eth|wlan|wl|Wi-?Fi|Ethernet)/i.test(name);

/**
 * Where a phone can reach the device port, best first: `extra` (OWLBOT_DEVICE_URLS, e.g. for Docker), the computer's
 * Wi-Fi/Ethernet addresses, other private addresses, the hub's link (`link`, remote.ts), then Tailscale.
 */
export function deviceUrls(port: number, extra: string[] = [], interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(), link?: string): string[] {
  const ranked: Array<{ url: string; rank: number }> = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      // VM and VPN bridges sometimes carry a network or broadcast address (x.x.x.0, x.x.x.255), and a cable with no
      // DHCP a self-assigned one (169.254.x.x): no phone reaches those.
      if (i.family !== "IPv4" || i.internal || /\.(0|255)$/.test(i.address) || i.address.startsWith("169.254.")) continue;
      const rank = isTailnet(i.address) ? 3 : isPrivate(i.address) ? (isPhysical(name) ? 1 : 2) : 4;
      ranked.push({ url: `https://${i.address}:${port}`, rank });
    }
  }
  if (link) ranked.push({ url: link, rank: 2.5 });
  ranked.sort((a, b) => a.rank - b.rank);
  return [...new Set([...extra, ...ranked.map((r) => r.url)])];
}

function qr(text: string) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q;
}

export function qrSvg(text: string): string {
  return qr(text).createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/** The QR in half-block characters for a terminal (two rows per line, dark modules as ink). */
export function qrText(text: string): string {
  const q = qr(text);
  const n = q.getModuleCount();
  const margin = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const lines: string[] = [];
  for (let r = -margin; r < n + margin; r += 2) {
    let line = "";
    for (let c = -margin; c < n + margin; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
