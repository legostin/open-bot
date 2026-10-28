// The owl from the app icon: two amber eyes and a beak on warm ink. It blinks now and then; its eyes show the
// connection when asked to: open when the hub answers, narrowed while connecting, closed while it is away (as on the
// phone, Theme.swift OwlMark).

import { useId } from "react";
import { cx } from "./ui";

export type OwlMood = "awake" | "sleepy" | "asleep";

export function OwlMark({ size = 28, mood = "awake", className }: { size?: number; mood?: OwlMood; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const eye = (cx: number) => (
    <g className="owl-eye">
      <circle cx={cx} cy="29.6" r="10.9" fill={`url(#e${uid})`} />
      <circle cx={cx} cy="29.6" r="6.6" fill="#0f0d0b" />
      <circle cx={cx + 2.75} cy="26.1" r="1.6" fill="#f6f1e8" />
    </g>
  );
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cx("owl-mark shrink-0", `is-${mood}`, className)} aria-hidden="true">
      <defs>
        <linearGradient id={`t${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f2a25" />
          <stop offset="1" stopColor="#11100e" />
        </linearGradient>
        <linearGradient id={`e${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd774" />
          <stop offset="1" stopColor="#f7ad2c" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#t${uid})`} />
      <rect x="0.5" y="0.5" width="63" height="63" rx="15.5" fill="none" stroke="#fff" strokeOpacity="0.07" />
      {eye(20.6)}
      {eye(43.4)}
      <rect x="27" y="42.4" width="10" height="2.9" rx="1.45" fill="#f6f1e8" />
    </svg>
  );
}
