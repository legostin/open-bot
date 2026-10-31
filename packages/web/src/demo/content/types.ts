// The words of the demo: one Content per locale, the same shape in each (content.test.ts checks it). Scripts read only
// from here, so a new language is a new file, not new code. Each locale tells its own story (person, city, currency,
// letters), not a translation of the other.

import type { IntegrationView, Locale } from "@piomio/shared";
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
  /** After "Always allow": the letter went and the narrow rule exists. */
  sentAlways: string;
}

export interface MorningText {
  digestTitle: string;
  digest: string;
  nudge: string;
  choices: [string, string];
  reminderSet: string;
  dentistAsk: string;
  clinic: string;
  dentistSummary: string;
  dentistBooked: string;
}

export interface SecurityText {
  ask: string;
  letter: string;
  verdict: string;
  choices: [string, string];
  tryIntro: string;
  summary: string;
  blocked: string;
  keyAsk: string;
  keyIntro: string;
  keyTitle: string;
  keyHint: string;
  /** The vault item's id: the only thing the agent ever sees of the key. */
  keyVault: string;
  /** What the script types into the secret card (an obviously made-up key). */
  keyValue: string;
  keySaved: string;
}

export interface ServicesText {
  ask: string;
  cardIntro: string;
  account: string;
  connected: string;
  bookAsk: string;
  eventSummary: string;
  booked: string;
}

export interface TeamText {
  ask: string;
  laptopsTask: string;
  laptopsGoal: string;
  reply: string;
  reviewing: string[];
  laptopsResult: string;
  trains: string;
  trainsSites: string[];
  pick: string;
}

export interface MachinesText {
  ask: string;
  steps: Array<{ step: "command" | "reading" | "editing"; detail: string }>;
  fixed: string;
  choices: [string, string];
  pushCommand: string;
  pushReason: string;
  limit: string;
  prAsk: string;
  prSteps: Array<{ step: "command" | "reading" | "editing"; detail: string }>;
  prDone: string;
}

export interface BrowserText {
  ask: string;
  watching: string;
  goal: string;
  /** What the person says while showing: after the catalogue, at the quantity, at the total. */
  voice: [string, string, string];
  retell: string;
  choices: [string, string];
  skillSummary: string;
  saved: string;
  orderAsk: string;
  ordering: string;
  ordered: string;
  scheduleAsk: string;
  scheduled: string;
}

export interface PagesText {
  ask: string;
  searching: string[];
  title: string;
  summary: string;
  intro: string;
}

export interface ChannelsText {
  ask: string;
  question: string;
  choices: [string, string];
  feedTitle: string;
  brief: string;
  sources: string[];
  created: string;
  gathering: string;
  posts: Array<{ title: string; text: string; source: string; image: string }>;
  issueIntro: string;
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
    catalogTitle: string;
  };
  /** The catalog as the demo hub lists it (logos are added by the world). */
  integrations: IntegrationView[];
  chapters: {
    morning: MorningText;
    mail: MailText;
    send: SendText;
    security: SecurityText;
    services: ServicesText;
    team: TeamText;
    machines: MachinesText;
    browser: BrowserText;
    pages: PagesText;
    channels: ChannelsText;
  };
}
