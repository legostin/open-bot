// Finding the app's own elements and acting on them the way a person would, so the app's own handlers run.

import type { Clock } from "./clock";

/** A step whose element never appeared: the checks report it with what was looked for. */
export class StepError extends Error {}

export type Finder = () => Element | null | undefined;

export async function waitFor(clock: Clock, find: Finder, what: string, timeoutMs = 8000): Promise<HTMLElement> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    clock.check();
    const el = find();
    if (el instanceof HTMLElement && el.isConnected) return el;
    if (Date.now() > end) throw new StepError(`never appeared: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The last visible button whose own text is `label` (the newest card's button when several cards have one). */
export function buttonByText(label: string, root: ParentNode = document): HTMLButtonElement | undefined {
  const all = [...root.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label && !b.disabled && b.offsetParent !== null);
  return all.at(-1);
}

export function composer(): HTMLTextAreaElement | null {
  return document.querySelector("textarea");
}

/** Sets a field's value through the element's own setter and fires input, so React's onChange sees it. */
export function setFieldValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
