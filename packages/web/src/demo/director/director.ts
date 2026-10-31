// Plays one chapter: both sides of its script against the running app, with a clock the page can pause, and tells the
// page how it went.

import type { Content } from "../content/types";
import type { DemoHub } from "../hub/hub";
import type { FromDemo } from "../protocol";
import type { Chapter } from "../scenarios/types";
import { Agents } from "./agents";
import { Clock, Stopped } from "./clock";
import { Cursor } from "./cursor";
import { Person, type Navigator } from "./person";

export class Director {
  private hub: DemoHub;
  private content: Content;
  private nav: Navigator;
  private report: (m: FromDemo) => void;
  private clock?: Clock;
  private abort?: AbortController;
  private cursor?: Cursor;

  constructor(hub: DemoHub, content: Content, nav: Navigator, report: (m: FromDemo) => void) {
    this.hub = hub;
    this.content = content;
    this.nav = nav;
    this.report = report;
  }

  get playing(): boolean {
    return !!this.abort && !this.abort.signal.aborted;
  }

  async play(chapter: Chapter, speed: number): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    const clock = new Clock(abort.signal, speed);
    this.clock = clock;
    this.cursor ??= new Cursor();
    const ctx = { d: new Person(this.hub, clock, this.cursor, this.nav), h: new Agents(this.hub, clock), c: this.content, clock };
    this.report({ source: "piomio-demo", type: "playing", chapter: chapter.id });
    try {
      await chapter.play(ctx);
      this.report({ source: "piomio-demo", type: "ended", chapter: chapter.id });
    } catch (e) {
      if (e instanceof Stopped) return;
      console.error("[demo] chapter failed", chapter.id, e);
      this.report({ source: "piomio-demo", type: "failed", chapter: chapter.id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.abort === abort) this.abort = undefined;
      this.cursor?.rest();
    }
  }

  pause(): void {
    this.clock?.pause();
  }

  resume(): void {
    this.clock?.resume();
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }
}
