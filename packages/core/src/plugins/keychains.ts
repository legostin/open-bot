// macOS keeps some CLI logins (Claude Code's) in the user's login keychain, which the Security framework finds through
// HOME. Brain hosts get a HOME of their own (<data>/home/agent), where no keychain exists: a sign-in from the chat then
// fails with "Couldn't save your login", and the user's existing login is not seen. Outside the Unix-user sandbox
// (desktop installs, development) the brain host runs as the user, so its HOME links the user's keychains in.

import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Links `<home>/Library/Keychains` to the user's own keychains on macOS; returns whether the link is there. */
export function linkUserKeychains(home: string, userHome = homedir(), platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const real = join(userHome, "Library", "Keychains");
  const link = join(home, "Library", "Keychains");
  if (!existsSync(real)) return false;
  try {
    lstatSync(link);
    return true;
  } catch {
    /* not there yet */
  }
  mkdirSync(join(home, "Library"), { recursive: true });
  symlinkSync(real, link);
  return true;
}
