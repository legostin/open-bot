// The setup card's choices, kept apart from React so they are tested on their own.

import type { Message, SetupBrain, SetupState } from "@piomio/shared";

/** The brain the card offers first: a CLI that only needs a sign-in, else one the hub can install. */
export function primaryRef(s: SetupState): string | undefined {
  const cli = s.brains.filter((b) => b.kind === "cli" && !b.signedIn);
  return (cli.find((b) => b.installed) ?? cli.find((b) => b.canInstall))?.ref;
}

/** The CLI brains as the card lists them: the one it offers first on top. */
export function cliRows(s: SetupState): SetupBrain[] {
  const first = primaryRef(s);
  const cli = s.brains.filter((b) => b.kind === "cli");
  return [...cli.filter((b) => b.ref === first), ...cli.filter((b) => b.ref !== first)];
}

/** The card at the end of a conversation: no brain works (the hub is not just starting), and no card from the hub waits there already. */
export function showGate(messages: Message[], s: SetupState | null): boolean {
  if (!s || s.usable || s.starting) return false;
  const card = messages.findLastIndex((m) => m.parts.some((p) => p.type === "brain_setup"));
  return card < 0 || card < messages.findLastIndex((m) => m.role === "assistant");
}

/** The moment to open a new hub's intro: a brain works, and the default agent's dialog (`main`) has nothing in it yet. */
export function introDue(messages: Message[], s: SetupState | null, main: boolean): boolean {
  return !!s && s.firstRun && s.usable && main && messages.length === 0;
}

/**
 * Tickets for requests whose answers may come back out of order: each call hands out a check that stays true only
 * until the next call, so an older answer arriving after a newer one is dropped.
 */
export function newest(): () => () => boolean {
  let n = 0;
  return () => {
    const mine = ++n;
    return () => mine === n;
  };
}
