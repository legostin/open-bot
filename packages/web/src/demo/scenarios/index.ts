import { mail } from "./mail";
import { send } from "./send";
import type { Chapter } from "./types";

export const CHAPTERS: Chapter[] = [mail, send];

export function chapterById(id: string | null | undefined): Chapter {
  return CHAPTERS.find((c) => c.id === id) ?? CHAPTERS[0];
}
