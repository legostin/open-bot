// The integrations library's cards: what each one's button does and how its status looks.

import type { IntegrationStatus, IntegrationView } from "@owlbot/shared";
import type { Tone } from "./format";

export type IntegrationAction = "connect" | "reconnect" | "setup" | "turnOn" | "disconnect";

/** The card's main button, if it has one. */
export function primaryAction(v: Pick<IntegrationView, "connect" | "status">): IntegrationAction | undefined {
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
