// Messages between the site's page and the demo frame (window.postMessage, same origin). The page picks a chapter by
// loading the frame with ?chapter=…&lang=…&autoplay=1; these only steer what is loaded.

import type { ChapterId } from "./scenarios/types";

export type ToDemo = { source: "piomio-site"; type: "play" | "pause" | "resume" };

export type FromDemo =
  | { source: "piomio-demo"; type: "ready"; chapter: ChapterId }
  | { source: "piomio-demo"; type: "playing"; chapter: ChapterId }
  | { source: "piomio-demo"; type: "ended"; chapter: ChapterId }
  | { source: "piomio-demo"; type: "failed"; chapter: ChapterId; message: string };

export interface DemoParams {
  lang: string;
  chapter: ChapterId;
  /** Start playing as soon as the app is up. */
  autoplay: boolean;
  /** The checks play fast. */
  speed: number;
}

export function readParams(search: string): DemoParams {
  const q = new URLSearchParams(search);
  return {
    lang: q.get("lang") ?? "en",
    chapter: (q.get("chapter") ?? "morning") as ChapterId,
    autoplay: q.get("autoplay") !== "0",
    speed: Math.max(0.25, Math.min(50, Number(q.get("speed") ?? 1) || 1)),
  };
}
