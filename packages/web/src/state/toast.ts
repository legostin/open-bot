import { createStore } from "../lib/store";

export type ToastKind = "info" | "success" | "error";
export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

export const toasts = createStore<ToastItem[]>([]);
let seq = 0;

export function toast(text: string, kind: ToastKind = "info"): void {
  const id = ++seq;
  toasts.set((list) => [...list.slice(-4), { id, text: String(text).slice(0, 500), kind }]);
  setTimeout(() => dismissToast(id), kind === "error" ? 7000 : 4000);
}

export function dismissToast(id: number): void {
  toasts.set((list) => list.filter((t) => t.id !== id));
}
