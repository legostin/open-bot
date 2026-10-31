// The words of the demo: one Content per locale, the same shape in each (content.test.ts checks it). Scripts read only
// from here, so a new language is a new file, not new code. Each locale tells its own story (person, city, currency,
// letters), not a translation of the other.

import type { Locale } from "@piomio/shared";
import type { AgentId } from "../world";

export interface Line {
  role: "user" | "assistant";
  text: string;
  hoursAgo: number;
}

export interface Cast {
  person: string;
  team: Record<AgentId, { name: string; description: string }>;
  machines: { home: string; laptop: string };
}

export interface MailText {
  ask: string;
  query: string;
  found: string;
  reading: string[];
  summary: string;
  choices: [string, string];
}

export interface SendText {
  draftIntro: string;
  draft: string;
  subject: string;
  to: string;
  summary: string;
  sent: string;
  always: string;
  alwaysDone: string;
}

export interface Content {
  locale: Locale;
  cast: Cast;
  /** Yesterday in each dialog. */
  history: Record<AgentId, Line[]>;
  ui: {
    /** Over the composer: the visitor cannot type. */
    demoNote: string;
    /** What the hub answers when the visitor reaches something the demo does not act out. */
    notInDemo: string;
  };
  chapters: {
    mail: MailText;
    send: SendText;
  };
}
