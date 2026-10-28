// First-run setup in the chat. Until one of an agent's brains works, the hub itself answers with a setup card (sign in,
// install the CLI, or a key) and keeps what the user wrote; as soon as a brain works it hands those messages to the
// agent, or, on a fresh hub, lets the default agent greet the user. From then on the default agent leads the rest of
// the setup (Telegram, a backup brain, other computers, getting to know the user) from a short block in its system
// prompt and two hub tools. Nothing here needs a model.

import type { SetupBrain, SetupState, SetupStep, VaultState } from "@owlbot/shared";
import { formatBrainRef, parseBrainRef } from "@owlbot/shared";
import type { AgentRegistry } from "./agents.ts";
import type { AttachmentPart } from "./attachments.ts";
import type { BrainRegistry } from "./brains.ts";
import type { EventBus } from "./bus.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { CliTools } from "./cli-tools.ts";
import type { Settings } from "./settings.ts";
import type { Store } from "./store.ts";

/** The order the agent offers the steps in. */
export const SETUP_STEPS: readonly SetupStep[] = ["telegram", "backupBrain", "machines", "profile"];

/** Messages written while no brain worked are answered only this long afterwards. */
const HOLD_MS = 24 * 3600_000;
const CHECK_DELAY_MS = 300;

export const KICKOFF_NOTE =
  "[System] The hub has just connected its first brain. Greet the user in one or two short sentences in their language, say you are ready, " +
  "and offer to finish setting up the hub together (see Hub setup in your instructions). Do not start a step until they agree.";

interface Saved {
  kickoffDone?: boolean;
  done?: SetupStep[];
  skipped?: SetupStep[];
}

interface ReplyOpts {
  replyChannel?: string;
  quote?: string;
  attachments?: AttachmentPart[];
  speech?: Record<string, string>;
}

interface Held {
  agentId: string;
  prompts: string[];
  opts: ReplyOpts;
  at: number;
}

export interface SetupDeps {
  brains: BrainRegistry;
  agents: AgentRegistry;
  settings: Settings;
  store: Store;
  vault: { state(): VaultState };
  channels: ChannelRegistry;
  machines: { list(): unknown[] };
  cliTools: CliTools;
  bus: EventBus;
  /** Runs a turn in a conversation with these words from the user. */
  resume: (conversationId: string, prompt: string, opts: ReplyOpts) => void;
  /** A system note for the agent of a conversation, and a turn. */
  tellAgent: (conversationId: string, note: string) => void;
}

export function isSetupStep(v: unknown): v is SetupStep {
  return typeof v === "string" && (SETUP_STEPS as readonly string[]).includes(v);
}

export class SetupGuide {
  private d: SetupDeps;
  private held = new Map<string, Held>();
  /** Plugins have started: from now on "no brain works" means the hub really has none, not that it is booting. */
  private ready = false;
  /** The default agent had no working brain after startup, so its first working brain is the user's doing. */
  private sawUnusable = false;
  private timer?: NodeJS.Timeout;
  private checking?: Promise<void>;
  private again = false;

  constructor(d: SetupDeps) {
    this.d = d;
    d.bus.on("brains.updated", () => this.schedule());
  }

  /** Called once the plugins have started. */
  start(): void {
    this.ready = true;
    this.schedule();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private saved(): Saved {
    return this.d.settings.getKey<Saved>("setup", {});
  }

  private save(patch: Saved): void {
    this.d.settings.setKey("setup", { ...this.saved(), ...patch });
    this.d.bus.emit("settings.updated", { keys: ["setup"] });
  }

  private defaultAgent(): string {
    return this.d.settings.get().defaultAgent;
  }

  /** The agent's brains on this hub, as the setup card shows them. */
  private async brains(agentId: string): Promise<SetupBrain[]> {
    const agent = this.d.agents.get(agentId);
    if (!agent) return [];
    const listed = new Map(this.d.brains.list().map((b) => [b.ref, b]));
    const out: SetupBrain[] = [];
    for (const raw of agent.brains) {
      const parsed = parseBrainRef(raw);
      if (parsed.machineId !== "local") continue;
      const ref = formatBrainRef(parsed);
      const listing = listed.get(ref);
      const connected = this.d.brains.has(ref);
      const probe = connected ? await this.d.brains.probe(ref) : undefined;
      const kind = listing?.login ? "cli" : "api";
      out.push({
        ref,
        label: listing?.label ?? ref,
        kind,
        installed: kind === "api" ? true : !!probe?.available,
        signedIn: !!probe?.authenticated,
        canInstall: kind === "cli" && !!this.d.cliTools.forBrain(parsed.brainId),
        ...(probe?.detail ? { detail: probe.detail } : {}),
      });
    }
    return out;
  }

  /** Some brain of the agent works now; rate limits and busy brains do not count against it. */
  async usable(agentId: string = this.defaultAgent()): Promise<boolean> {
    const agent = this.d.agents.get(agentId);
    if (!agent) return false;
    for (const ref of agent.brains) {
      if (this.d.brains.has(ref) && (await this.d.brains.probe(ref)).authenticated) return true;
    }
    return false;
  }

  private async telegram(): Promise<boolean> {
    const c = this.d.channels.list().find((ch) => ch.id === "telegram" || ch.pluginId === "telegram");
    return c ? (await this.d.channels.status(c.id)).connected : false;
  }

  async state(agentId: string = this.defaultAgent()): Promise<SetupState> {
    const [brains, usable, telegram] = [await this.brains(agentId), await this.usable(agentId), await this.telegram()];
    const vaultState = this.d.vault.state();
    const machines = this.d.machines.list().length;
    const saved = this.saved();
    const cli = brains.filter((b) => b.kind === "cli");
    // A backup is only worth offering when a second CLI could still be signed in.
    const backupOffer = cli.filter((b) => b.signedIn).length < 2 && cli.some((b) => !b.signedIn && (b.installed || b.canInstall));
    const auto: Record<SetupStep, boolean> = { telegram, backupBrain: !backupOffer, machines: machines > 0, profile: false };
    const done = SETUP_STEPS.filter((s) => auto[s] || saved.done?.includes(s));
    const skipped = SETUP_STEPS.filter((s) => !done.includes(s) && saved.skipped?.includes(s));
    return {
      agentId,
      brains,
      usable,
      vault: vaultState === "uninitialized" ? "absent" : vaultState === "sealed" ? "locked" : "open",
      telegram,
      machines,
      done,
      skipped,
      remaining: SETUP_STEPS.filter((s) => !done.includes(s) && !skipped.includes(s)),
    };
  }

  /** The agent finished a step with the user, the user put it off ("skipped"), or wants it back ("todo"). */
  setStep(step: SetupStep, status: "done" | "skipped" | "todo"): void {
    const saved = this.saved();
    const without = (list: SetupStep[] | undefined) => (list ?? []).filter((s) => s !== step);
    this.save({
      done: status === "done" ? [...without(saved.done), step] : without(saved.done),
      skipped: status === "skipped" ? [...without(saved.skipped), step] : without(saved.skipped),
    });
  }

  /** The user wrote while no brain of the agent worked: answer it once one does. */
  hold(conversationId: string, agentId: string, prompt: string, opts: ReplyOpts): void {
    const prev = this.held.get(conversationId);
    const fresh = prev && Date.now() - prev.at < HOLD_MS ? prev : undefined;
    // The files of every waiting message go with the one turn that answers them.
    const attachments = [...(fresh?.opts.attachments ?? []), ...(opts.attachments ?? [])];
    const speech = { ...fresh?.opts.speech, ...opts.speech };
    const kept = { ...(fresh?.opts ?? opts), ...(attachments.length ? { attachments } : {}), ...(Object.keys(speech).length ? { speech } : {}) };
    this.held.set(conversationId, { agentId, prompts: [...(fresh?.prompts ?? []), prompt], opts: kept, at: Date.now() });
  }

  isHeld(conversationId: string): boolean {
    return this.held.has(conversationId);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), CHECK_DELAY_MS);
    this.timer.unref?.();
  }

  /** One check at a time; a change during a check runs another one after it. */
  private check(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = this.runCheck()
      .catch((e) => console.error("[setup] check failed", e))
      .finally(() => {
        this.checking = undefined;
        if (this.again) {
          this.again = false;
          this.schedule();
        }
      });
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    const resumedFor = new Set<string>();
    for (const [conversationId, h] of [...this.held]) {
      if (Date.now() - h.at > HOLD_MS) {
        this.held.delete(conversationId);
        continue;
      }
      if (!(await this.usable(h.agentId))) continue;
      this.held.delete(conversationId);
      resumedFor.add(h.agentId);
      this.d.resume(conversationId, h.prompts.join("\n\n"), h.opts);
    }
    if (!this.ready || this.saved().kickoffDone) return;
    const agentId = this.defaultAgent();
    if (!(await this.usable(agentId))) {
      this.sawUnusable = true;
      return;
    }
    this.save({ kickoffDone: true });
    // A hub that worked from the start, or an answer already on its way: no greeting.
    if (!this.sawUnusable || resumedFor.has(agentId)) return;
    const conv = this.d.store.agentConversation(agentId);
    if (this.d.store.listMessages(conv.id, { limit: 50 }).some((m) => m.role === "assistant")) return;
    this.d.tellAgent(conv.id, KICKOFF_NOTE);
  }

  /** The "Hub setup" section of the default agent's system prompt while steps remain; English, for the model. */
  async promptBlock(agentId: string): Promise<string | undefined> {
    if (agentId !== this.defaultAgent()) return undefined;
    const s = await this.state(agentId);
    if (!s.remaining.length) return undefined;
    const backup = s.brains.find((b) => b.kind === "cli" && !b.signedIn && (b.installed || b.canInstall));
    const steps: Record<SetupStep, string> = {
      telegram:
        'telegram: Telegram for messages and approvals on the phone. The user creates a bot with @BotFather (https://t.me/BotFather, /newbot) and gets its token; then call `hub_plugin_setup` with id "telegram": its card takes the token (and creates the vault first if there is none). Afterwards ask them to message the bot.',
      backupBrain: `backupBrain: ${backup ? `${backup.label} (${backup.ref}) ${backup.installed ? "is installed but not signed in" : "can be installed and signed in"}` : "a second brain"}, a backup for when the current brain hits its limits: \`hub_brain_login\`${backup ? ` with ref "${backup.ref}"` : ""}.`,
      machines: "machines: other computers can join this hub, and their Claude Code and Codex become brains here: `hub_connect_device` shows a card with a one-time link the user opens on that computer.",
      profile:
        'profile: get to know the user: how to address them, their language, what they want help with. Keep each fact with `memory_remember`, change the hub language with `hub_settings_update` if needed and your own name or instructions with `profile_update` if they want; then call `hub_setup_update` with step "profile" and status "done".',
    };
    const lines = [
      "## Hub setup",
      "This hub is new and some setup is left. Offer it when it fits (after answering what the user asked, never instead of it), one step at a time, and start a step only after the user agrees. " +
        'When they say "not now", call `hub_setup_update` with status "skipped" and do not bring that step up again unless they ask to continue the setup. ' +
        "Secrets (tokens, keys, passwords) go only into the cards the tools show, never into the chat. Call `hub_setup_status` for what is left before suggesting the next step.",
      "Steps left:",
      ...s.remaining.map((step) => `- ${steps[step]}`),
    ];
    if (s.skipped.length) lines.push(`Skipped by the user (offer only if they ask to continue the setup): ${s.skipped.join(", ")}.`);
    return lines.join("\n");
  }
}
