import { browser } from "./browser";
import { channels } from "./channels";
import { mail } from "./mail";
import { machines } from "./machines";
import { morning } from "./morning";
import { pages } from "./pages";
import { security } from "./security";
import { send } from "./send";
import { services } from "./services";
import { team } from "./team";
import type { Chapter } from "./types";

export const CHAPTERS: Chapter[] = [morning, mail, send, security, services, team, machines, browser, pages, channels];

export function chapterById(id: string | null | undefined): Chapter {
  return CHAPTERS.find((c) => c.id === id) ?? CHAPTERS[0];
}
