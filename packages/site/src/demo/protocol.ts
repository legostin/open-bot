// The site's side of the demo's protocol (packages/web/src/demo/protocol.ts): the frame is loaded with
// ?lang=…&chapter=…&autoplay=1 and answers with postMessage. Kept as a copy so the site builds on its own;
// locales.test.ts checks the chapter list against the demo's.

export const CHAPTERS = ["morning", "mail", "send", "security", "services", "team", "machines", "browser", "pages", "channels"] as const;
export type ChapterId = (typeof CHAPTERS)[number];

export type ToDemo = { source: "piomio-site"; type: "play" | "pause" | "resume" };

export type FromDemo =
  | { source: "piomio-demo"; type: "ready"; chapter: ChapterId }
  | { source: "piomio-demo"; type: "playing"; chapter: ChapterId }
  | { source: "piomio-demo"; type: "ended"; chapter: ChapterId }
  | { source: "piomio-demo"; type: "failed"; chapter: ChapterId; message: string };

export function demoSrc(base: string, lang: string, chapter: ChapterId, autoplay = true): string {
  return `${base}demo/demo.html?lang=${lang}&chapter=${chapter}&autoplay=${autoplay ? 1 : 0}`;
}
