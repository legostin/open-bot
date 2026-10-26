# In-chat setup guide

Approved 2026-10-26. Setup becomes a conversation: the hub leads until a brain works, then the agent leads.

## Problem

A fresh desktop install on a Mac where Claude Code and Codex are both installed and signed in. The user opens the chat,
writes "привет" and gets `chat.cannotStart` with every brain's reason joined into one error:

1. Claude Code runs with `HOME=<data>/home/agent`, so the user's own login is not there. That is by design and stays.
2. Codex lives in `~/.npm-global/bin` (and nvm). The hub runs under launchd with a short PATH, so it reports "Codex CLI
   is not installed".
3. With no usable brain the runner stores an `error` part with all candidates' reasons. The first-run checklist above
   the chat is a form the user does not notice; it does not answer the message they just wrote.

## Goal

From the first time the chat opens, setup happens in the chat. No step sends the user to another page, a terminal or
the security console. Secrets never pass through the model: they are typed into secure cards and the model sees only
`vault://<id>`.

## Decisions

- **Separate login.** CLI brains keep the hub's own HOME. The guide signs them in with one click (the existing
  `brain_login` flow); it never reads or shares `~/.claude` or `~/.codex`.
- **Two phases.** Phase 1 is hub-driven and needs no model. Phase 2 is the agent itself, using hub tools it already has.
- **Out of scope here:** the desktop app shell (Tauri 2) and joining an existing hub from a new computer belong to the
  desktop installers spec. This guide lives in the hub and the web UI, so the app window shows it as is.

## Setup state

`packages/core/src/setup.ts` computes one `SetupState`, used by the API, the phase 1 card and the prompt block:

```ts
interface SetupState {
  brains: Array<{
    ref: string;            // claude-code@local, codex@local, api:anthropic, api:openai
    kind: "cli" | "api";
    installed: boolean;     // CLI found on the brain PATH (always true for api)
    signedIn: boolean;      // probe.authenticated
    canInstall: boolean;    // CliTools can install it here (desktop, no user isolation)
    detail?: string;        // short localized status for the card
  }>;
  usable: boolean;          // some brain is usable right now
  vault: "absent" | "locked" | "open";
  telegram: boolean;        // the telegram channel is connected
  machines: number;         // paired computers
  profile: boolean;         // the default agent's profile was set up with the user
  skipped: SetupStep[];     // from settings: setup.skipped
}
type SetupStep = "telegram" | "backupBrain" | "machines" | "profile";
```

`GET /api/setup?agent=<id>` returns it (the default agent without `agent`). No new bus event: the web UI reloads it on
`brains.updated`, `plugins.updated`, `vault.state` and a finished sign-in.

## Phase 1: the hub leads (no model)

### Finding the CLIs

`userPath()` in `packages/core/src/cli-tools.ts` finds where the user's own CLIs live:

- macOS and Linux: the user's login shell once, `$SHELL -lic 'printf "\n__PATH__%s\n" "$PATH"'` with a 5 s timeout;
  only the marked line is read, so shell banners do not matter. Falls back to the current PATH.
- Windows: `Path` from `HKCU\Environment` and `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`,
  with `%VAR%` expanded, so a CLI installed after login is found without logging out.

Brain hosts get these directories after their own PATH and before `<data>/tools`, so a CLI the user installed wins over
one the hub installed (the existing rule in `cli-tools.ts`). It is read on desktop installs only (`OPENBOT_INSTALL_CLIS=1`:
a hub started from launchd or a tray app has a short PATH, a terminal's `npm start` does not), at hub start and again
on the card's **Check again**; when it changed, the brain plugins restart. Under user isolation (Docker) nothing
changes: the image brings the CLIs.

### The card

A new message part `{ type: "brain_setup" }` in `packages/shared/src/types.ts`, rendered by `BrainSetupCard` in the web
UI. The card reads `/api/setup` live; the stored part only marks where it sits in the conversation.

- Title: "To answer you, I need a brain".
- One row per CLI brain the agent may use: status ("installed, sign-in needed", "not installed", "signed in") and one
  button: **Sign in**, **Install and sign in** (when `canInstall`), or none. Sign-in reuses `BrainLoginCard`'s flow
  (install if missing, then the browser code or device code).
- **Use an API key** (collapsed): the existing `PluginSetupCard` for `brain-api` / `brain-claude-code` inside
  `VaultGate`, so the vault is created right there if it does not exist yet.
- The first installed CLI is the primary button; with none installed, Claude Code's **Install and sign in** is.
- Errors stay inside the card, short and localized (sign-in cancelled, no network, install failed), with **Retry**.
  **Check again** re-resolves the PATH and probes the brains.
- When a brain becomes usable the card turns into a one-line "Connected: Claude Code".

### When it shows

- **On open.** When the agent of the dialog shown has no usable brain and no stored card waits after its last answer,
  the web UI shows the card at the end of the dialog (not stored). This holds for every agent's dialog.
- **On a message.** In `runner.ts`, when no candidate is usable and the reasons are setup reasons (not installed, not
  signed in, no key) rather than limits or failures, the runner stores a system message with a `brain_setup` part
  instead of the `error` part, and does not add a second card while the last one is still there. All-limited and
  other failures keep their current messages.

### Answering the waiting message

The runner hands the waiting message to `SetupGuide.hold`; more messages before a brain works join it. After every
`brains.updated` the guide checks the held conversations and, once their agent has a usable brain, runs one turn with
the held messages (blank line between them). Holds live in memory for 24 hours: after a hub restart the user writes
again. "привет" gets its answer right after sign-in, with no resend.

## Phase 2: the agent leads

### Kickoff

When the default agent's first brain becomes usable after the hub had started without one, and no message was waiting,
the hub runs one turn in the default agent's own dialog (only if it has no answer in it yet) with a system note: the
hub has just connected its first brain; greet the user briefly and offer to continue setup. The settings key `setup`
(`kickoffDone`) makes it happen once; a hub that works from the start only sets the flag. When a message was waiting,
the agent answers it and the prompt block below makes it offer setup afterwards.

### Prompt block

`buildSystemPrompt` gets the `SetupState` for the hub's default agent in the owner's conversations. While a step is
neither done nor skipped, it adds a short English block "Hub setup" listing the remaining steps, the tool for each and
the rules: one step at a time; ask before starting one; "not now" records a skip; never ask for a secret in text. The
block is gone once nothing remains. Skipped steps get one line: offer them again only if the user asks ("let's
continue setup").

### Steps and tools

| Step | What the agent does | Tool |
| --- | --- | --- |
| Telegram | Links @BotFather, explains how to get the token; the card's secure field takes it (the vault is created inside this card when absent, with "open automatically"); then asks the user to message the bot and checks it is connected | `plugin_setup` (telegram), `plugins_list` |
| Backup brain (optional) | If a second CLI is installed but not signed in, offers it as the fallback for limits | `brain_login`, `brains_list` |
| Other computers (optional) | Gives a pairing code and the `openbot://pair?...` link for the desktop app on another computer | `machine_pairing_code` |
| Profile | Asks how to address the user, which language and what to help with, then updates itself | `profile_update` |

The vault is not a step of its own: it is created inside the first card that needs a secret, which `VaultGate`
already does. A user who never needs a secret never has to invent a passphrase.

Two new hub tools: `hub_setup_status` (read) returns the state, and `hub_setup_update { step, status }` records a step
as `done` (needed for `profile`; the others are detected), `skipped` ("not now") or `todo` (back on the list). Both live
in the settings key `setup`. The block is built when a session opens; the agent checks `hub_setup_status` before it
suggests the next step.

## Removed

- `FirstRunChecklist` (`packages/web/src/pages/chat/Checklist.tsx`) and its catalog keys: the card and phase 2 replace
  it.
- The joined-reasons error for setup cases (`chat.cannotStart` stays for the cases above that are not setup).

## i18n

Card and status text go through `packages/web/src/i18n/{en,ru}.ts`; hub texts through `packages/core/src/locales`.
The prompt block, system notes and tool descriptions are English. `packages/core/test/i18n.test.ts` covers parity.

## Testing

- Unit: `userPath()` (shell output with banners, timeout, Windows values with `%VAR%`); `setupState()` from fake
  brains, vault, channels and settings; the runner stores `brain_setup` (not `error`) for setup reasons, once per
  conversation, and keeps the limit messages; the waiting message runs once after `usable`; kickoff runs once; the
  prompt block appears; `hub_setup_update` and `hub_setup_status`.
- Web: the card's choices (`primaryRef`, `cliRows`, `showGate` in `packages/web/src/lib/setup.ts`).
- Manual, on this Mac with a fresh data dir and Claude Code and Codex installed: both show as installed; signing in
  from the card works; "привет" is answered after sign-in; the agent offers Telegram, the backup brain and the profile.
