// The person's side of a chapter: what Alex or Саша does in the app. The script types into the real composer, presses
// the real buttons and waits for the hub, so what the visitor sees is the app's own behaviour.

import type { Message } from "@piomio/shared";
import { agentPath } from "../../lib/team";
import { t } from "../../i18n";
import type { DemoHub } from "../hub/hub";
import { dialogOf, type AgentId } from "../world";
import type { Clock } from "./clock";
import type { Cursor } from "./cursor";
import { buttonByText, composer, setFieldValue, waitFor, type Finder } from "./dom";

export interface Navigator {
  path(): string;
  go(path: string): void;
}

export class Person {
  private hub: DemoHub;
  private clock: Clock;
  private cursor: Cursor;
  private nav: Navigator;

  constructor(hub: DemoHub, clock: Clock, cursor: Cursor, nav: Navigator) {
    this.hub = hub;
    this.clock = clock;
    this.cursor = cursor;
    this.nav = nav;
  }

  wait(ms: number): Promise<void> {
    return this.clock.wait(ms);
  }

  /** Opens an agent's dialog (as a tap on it in the team list would). */
  async open(agent: AgentId): Promise<void> {
    const path = agentPath(agent, this.hub.world.defaultAgent);
    if (this.nav.path() !== path) this.nav.go(path);
    await waitFor(this.clock, composer, "the composer");
    await this.clock.wait(350);
  }

  /** Types a message letter by letter into the composer and sends it with the send button; resolves with what the hub got. */
  async say(text: string, agent?: AgentId): Promise<Message> {
    if (agent) await this.open(agent);
    const field = await waitFor(this.clock, composer, "the composer");
    await this.cursor.moveTo(this.clock, field);
    field.focus({ preventScroll: true });
    let typed = "";
    for (const ch of text) {
      typed += ch;
      setFieldValue(field as HTMLTextAreaElement, typed);
      await this.clock.wait(ch === " " ? 55 : 28 + Math.random() * 38);
    }
    await this.clock.wait(260);
    const send = await waitFor(this.clock, () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.send")}"]`), "the send button");
    const arrived = this.hub.nextUserMessage();
    await this.cursor.moveTo(this.clock, send);
    await this.cursor.press(this.clock);
    send.click();
    const m = await this.clock.until(arrived);
    field.blur();
    return m;
  }

  /** Points at an element and presses it. */
  async press(find: Finder, what: string): Promise<void> {
    const el = await waitFor(this.clock, find, what);
    await this.cursor.moveTo(this.clock, el);
    await this.clock.wait(220);
    await this.cursor.press(this.clock);
    if (el.isConnected && !(el as HTMLButtonElement).disabled) el.click();
  }

  /** Taps a quick reply under the agent's message; the hub turns it into the person's message. */
  async choose(option: string): Promise<Message> {
    const arrived = this.hub.nextUserMessage();
    await this.press(() => buttonByText(option), `the quick reply “${option}”`);
    return this.clock.until(arrived);
  }

  /**
   * Answers an approval card. The visitor may have pressed it already: then the script only waits for the answer.
   * Resolves with what was decided.
   */
  async decide(approvalId: string, decision: "approve" | "deny", pause = 1400): Promise<"approved" | "denied"> {
    const answered = this.hub.waitApproval(approvalId);
    const early = await Promise.race([answered.then(() => true), this.clock.wait(pause).then(() => false)]);
    if (!early) {
      const label = t(decision === "approve" ? "message.approval.approve" : "message.approval.deny");
      await this.press(() => buttonByText(label), `the approval button “${label}”`);
    }
    return (await this.clock.until(answered)).status;
  }

  /** The dialog an agent's reply goes to. */
  dialog(agent: AgentId): string {
    return dialogOf(agent);
  }
}
