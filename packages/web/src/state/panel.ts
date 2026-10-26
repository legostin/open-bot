// The settings panel beside the chat: open or closed, and which section it shows ("home" = the section list).

import { navigate } from "wouter/use-browser-location";
import { createStore } from "../lib/store";
import { errorText } from "../lib/api";
import type { PanelSection } from "../components/nav";
import { sendMessage, session } from "./app";
import { toast } from "./toast";
import { t } from "../i18n";

/** A one-off request for the section to act on as it opens (the section clears it). */
export type PanelIntent = { kind: "agent.edit"; agentId: string };

export interface PanelState {
  open: boolean;
  section: PanelSection | "home";
  intent?: PanelIntent;
}

export const panel = createStore<PanelState>({ open: false, section: "home" });

export function openPanel(section: PanelSection | "home" = "home", intent?: PanelIntent): void {
  panel.set({ open: true, section, intent });
}

export function closePanel(): void {
  panel.set((p) => ({ ...p, open: false, intent: undefined }));
}

export function togglePanel(): void {
  panel.set((p) => (p.open ? { ...p, open: false, intent: undefined } : { open: true, section: "home" }));
}

export function clearPanelIntent(): void {
  panel.set((p) => (p.intent ? { ...p, intent: undefined } : p));
}

/**
 * "Add agent": no form. The default agent's dialog opens with the request, and the agent asks for a name, writes a
 * description and shows the newcomer as a card where the user picks the look.
 */
export function addAgent(): void {
  const s = session.get();
  if (!s) return;
  closePanel();
  navigate("/");
  sendMessage(s.mainConversationId, t("team.addPrompt")).catch((e) => toast(errorText(e), "error"));
}

/** An agent's settings: the Agents section with that agent's editor open. */
export function editAgent(agentId: string): void {
  openPanel("agents", { kind: "agent.edit", agentId });
}
