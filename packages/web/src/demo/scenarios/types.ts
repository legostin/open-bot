import type { Content } from "../content/types";
import type { Agents } from "../director/agents";
import type { Clock } from "../director/clock";
import type { Person } from "../director/person";
import type { AgentId } from "../world";

export const CHAPTER_IDS = ["morning", "mail", "send", "security", "services", "team", "machines", "browser", "pages", "channels"] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

export interface ChapterContext {
  /** The person's side: open, say, press, choose, decide. */
  d: Person;
  /** The team's side: replies, tools, cards, tasks. */
  h: Agents;
  c: Content;
  clock: Clock;
}

export interface Chapter {
  id: ChapterId;
  /** The dialog the window shows when the chapter starts. */
  agent: AgentId;
  /** What had happened before the chapter starts: put into the world before the app loads. */
  setup?(ctx: { h: Agents; c: Content }): void;
  play(ctx: ChapterContext): Promise<void>;
}
