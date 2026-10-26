// The setup card's choices, kept apart from React so they are tested on their own.

import type { Message, SetupBrain, SetupState } from "@openbot/shared";

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

/** The card at the end of a conversation: no brain works, and no card from the hub waits there already. */
export function showGate(messages: Message[], s: SetupState | null): boolean {
  if (!s || s.usable) return false;
  const card = messages.findLastIndex((m) => m.parts.some((p) => p.type === "brain_setup"));
  return card < 0 || card < messages.findLastIndex((m) => m.role === "assistant");
}
