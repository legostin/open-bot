// The settings panel beside the chat: open or closed, and which section it shows ("home" = the section list).

import { createStore } from "../lib/store";
import type { PanelSection } from "../components/nav";

/** A one-off request for the section to act on as it opens (the section clears it). */
export type PanelIntent = { kind: "agent.new" } | { kind: "agent.edit"; agentId: string };

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

/** "Add agent": the Agents section with its new-agent form open. */
export function addAgent(): void {
  openPanel("agents", { kind: "agent.new" });
}

/** An agent's settings: the Agents section with that agent's editor open. */
export function editAgent(agentId: string): void {
  openPanel("agents", { kind: "agent.edit", agentId });
}
