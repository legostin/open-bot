// The integrations library's cards: what each one's button does and how its status looks.

import type { IntegrationStatus, IntegrationView, RemoteView } from "@piomio/shared";
import type { Tone } from "./format";

export type IntegrationAction = "connect" | "reconnect" | "setup" | "turnOn" | "disconnect";

/** The card's main button, if it has one (access from anywhere draws its own steps). */
export function primaryAction(v: Pick<IntegrationView, "connect" | "status">): IntegrationAction | undefined {
  if (v.connect === "remote") return undefined;
  if (v.status === "off") return "turnOn";
  if (v.status === "unavailable") return undefined;
  if (v.connect === "setup") return "setup";
  if (v.connect === "google") return v.status === "broken" ? "reconnect" : v.status === "connected" ? "disconnect" : "connect";
  return undefined;
}

export const STATUS_TONE: Record<IntegrationStatus, Tone> = {
  connected: "success",
  "needs-setup": "warning",
  broken: "danger",
  off: "neutral",
  unavailable: "neutral",
};

export type RemoteStep = "unavailable" | "off" | "starting" | "login" | "funnel" | "running" | "error";

/** Where access from anywhere is: the step its card shows. */
export function remoteStep(v: Pick<RemoteView, "available" | "enabled" | "state">): RemoteStep {
  if (!v.available) return "unavailable";
  if (!v.enabled) return "off";
  switch (v.state) {
    case "needs-login":
      return "login";
    case "needs-funnel":
      return "funnel";
    case "running":
      return "running";
    case "error":
      return "error";
    default:
      return "starting";
  }
}

/** Tailscale asks to sign in again when the node's key expires: warn two weeks ahead. */
export function keyExpiresSoon(keyExpiry: string | undefined, now = Date.now()): boolean {
  if (!keyExpiry) return false;
  const at = Date.parse(keyExpiry);
  return Number.isFinite(at) && at - now < 14 * 24 * 3600_000;
}

/** This page itself came through the link: turning the link off closes it too. */
export function openedThroughLink(url: string | undefined, host: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}
