// The settings panel beside the chat: open or closed, and which section it shows ("home" = the section list).

import { createStore } from "../lib/store";
import type { PanelSection } from "../components/nav";

export interface PanelState {
  open: boolean;
  section: PanelSection | "home";
}

export const panel = createStore<PanelState>({ open: false, section: "home" });

export function openPanel(section: PanelSection | "home" = "home"): void {
  panel.set({ open: true, section });
}

export function closePanel(): void {
  panel.set((p) => ({ ...p, open: false }));
}

export function togglePanel(): void {
  panel.set((p) => (p.open ? { ...p, open: false } : { open: true, section: "home" }));
}
