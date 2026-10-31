// The person's pointer in the demo: an arrow that glides to what the script presses and pulses on the press. It is
// drawn over the app (pointer-events: none) and fades out when the script has nothing to point at.

import type { Clock } from "./clock";

const ARROW = `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M4 2.5 18.2 12l-6.3 1.3 3.6 6.6-2.6 1.4-3.6-6.6L4.6 19z" fill="#1c1814" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

export class Cursor {
  private el: HTMLDivElement;
  private x = window.innerWidth * 0.62;
  private y = window.innerHeight * 0.8;
  private hideTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "demo-cursor";
    this.el.innerHTML = `${ARROW}<span class="demo-cursor-ring"></span>`;
    document.body.appendChild(this.el);
    this.place(0);
  }

  private place(ms: number): void {
    this.el.style.transition = `transform ${ms}ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms`;
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
  }

  /** Glides to the middle of `el` (or a point), at a pace that reads as a hand. */
  async moveTo(clock: Clock, target: Element | { x: number; y: number }): Promise<void> {
    clearTimeout(this.hideTimer);
    let x: number;
    let y: number;
    if (target instanceof Element) {
      target.scrollIntoView({ block: "nearest", behavior: clock.speed > 2 ? "auto" : "smooth" });
      const r = target.getBoundingClientRect();
      x = r.left + Math.min(r.width / 2, 40);
      y = r.top + r.height / 2;
    } else ({ x, y } = target);
    const d = Math.hypot(x - this.x, y - this.y);
    const ms = Math.min(900, 260 + d * 0.9) / clock.speed;
    this.x = x;
    this.y = y;
    this.el.style.opacity = "1";
    this.place(ms);
    await clock.wait(ms * clock.speed + 60);
  }

  async press(clock: Clock): Promise<void> {
    this.el.classList.remove("is-press");
    void this.el.offsetWidth;
    this.el.classList.add("is-press");
    await clock.wait(160);
    this.rest();
  }

  /** The person's words while showing something (their voice, written down): a bubble by the pointer. */
  caption(text: string, ms: number, clock: Clock): void {
    const b = document.createElement("div");
    b.className = "demo-caption";
    b.textContent = text;
    b.style.transform = `translate(${Math.min(this.x + 18, window.innerWidth - 300)}px, ${this.y + 22}px)`;
    document.body.appendChild(b);
    requestAnimationFrame(() => b.classList.add("is-in"));
    setTimeout(() => {
      b.classList.remove("is-in");
      setTimeout(() => b.remove(), 300);
    }, ms / clock.speed);
  }

  /** Where the pointer is now. */
  get at(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Fades out a moment after the last move. */
  rest(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => (this.el.style.opacity = "0"), 1600);
  }

  remove(): void {
    this.el.remove();
  }
}
