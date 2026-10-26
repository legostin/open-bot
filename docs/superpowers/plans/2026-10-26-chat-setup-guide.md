# In-chat setup guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setup happens in the chat: the hub shows a brain sign-in card instead of an error until a brain works, then the
default agent leads the rest of the setup.

**Architecture:** A new `SetupGuide` service in core computes the setup state from the brain registry, the vault, the
channels, the machines and settings, keeps the user's messages that arrived while no brain worked, and starts the
agent once a brain becomes usable. The runner stores a `brain_setup` part instead of the joined-reasons error. The
prompt gets a short "Hub setup" block for the default agent; two hub tools read and update the state. The web UI renders
`BrainSetupCard` (reusing `BrainLoginCard`) and drops the first-run checklist. CLIs installed in the user's own shell
PATH are found through `user-path.ts`.

**Tech Stack:** Node 24 TypeScript (type stripping, `.ts` imports), Fastify, vitest, React + Vite web UI.

Spec: `docs/superpowers/specs/2026-10-26-chat-setup-guide-design.md`.

## Global Constraints

- Node ≥ 24 runs TypeScript directly: import local files with `.ts`, erasable syntax only, `import type` for types.
- Every user-facing string goes through a catalog (`packages/web/src/i18n/{en,ru}.ts`, `packages/core/src/locales/{en,ru}.ts`); English is the source of truth; parity is tested.
- Text for the model (prompt block, system notes, tool descriptions and results), code and comments is English.
- Secrets never pass through the model: cards only (`VaultGate`, `PluginSetupCard`, `BrainLoginCard`).
- CLI brains keep the hub's own HOME (`<data>/home/agent`); the user's `~/.claude` and `~/.codex` are never read.
- Under user isolation (Docker, `OPENBOT_ISOLATION=users`) nothing about CLI lookup changes.
- Hub tools are `hub_<name>`, owner `core`, visible to the default agent only.
- Commands: `npm run typecheck`, `npx vitest run <file>`, `npm test`, `npm run build`.

## File map

| File | Change |
| --- | --- |
| `packages/core/src/user-path.ts` | new: the user's shell / registry PATH, parsed and cached |
| `packages/core/src/app.ts` | wire `UserPath`, `SetupGuide`; brain hosts get user dirs; refresh restarts brain hosts |
| `packages/core/src/setup.ts` | new: `SetupGuide` (state, pending messages, resume, kickoff, prompt block) |
| `packages/shared/src/types.ts` | `SetupState`, `SetupBrain`, `SetupStep`; `MessagePart` gets `{ type: "brain_setup" }` |
| `packages/core/src/runner.ts` | setup case → `brain_setup` part + `SetupGuide.hold`; prompt block in `openSession` |
| `packages/core/src/prompt.ts` | `setup?: string` appended as its own section |
| `packages/core/src/server/main-app.ts` | `GET /api/setup`, `POST /api/setup/refresh` |
| `packages/core/src/tools/hub-tools.ts` | `hub_setup_status`, `hub_setup_update` |
| `packages/core/test/user-path.test.ts` | new |
| `packages/core/test/setup.test.ts` | new, integration on fixtures |
| `packages/core/test/fixtures/plugins/fakegated/` | new: a brain signed in by a file in its HOME |
| `packages/core/test/fixtures/setup-agents/assistant.md` | new: an assistant on `gated@local` and `codex@local` |
| `packages/web/src/components/BrainSetupCard.tsx` | new |
| `packages/web/src/components/BrainLoginCard.tsx` | install label when the CLI is missing |
| `packages/web/src/lib/setup.ts` + `setup.test.ts` | new: pure helpers (primary brain, card visibility) |
| `packages/web/src/pages/chat/{MessageView,ChatView,ChatPage,AgentPage}.tsx` | render the part; gate at the end; checklist gone |
| `packages/web/src/pages/chat/Checklist.tsx` | deleted |
| `packages/web/src/i18n/{en,ru}.ts` | `setup.*` keys in, `checklist.*` keys out |
| `README.md`, `README.ru.md` | first-run text |

---

### Task 1: Find the user's CLIs (`user-path.ts`)

**Files:** Create `packages/core/src/user-path.ts`, `packages/core/test/user-path.test.ts`; modify `packages/core/src/app.ts`.

**Interfaces — produces:**
```ts
export const PATH_MARK = "__OPENBOT_PATH__";
export function parseShellPath(out: string): string[] | undefined;           // the marked line, split on ":"
export function parseRegPath(out: string): string | undefined;               // `reg query … /v Path` output
export function expandWinVars(s: string, env: Record<string, string | undefined>): string; // %VAR%, case-insensitive
export function mergeDirs(current: string | undefined, extra: string[], sep: string): string[]; // extra minus current, unique, non-empty
export type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>; // stdout, rejects on failure
export async function readUserPath(o: { platform: NodeJS.Platform; env: Record<string, string | undefined>; run: Run }): Promise<string[]>;
export class UserPath { constructor(o?: Partial<{ platform; env; run }>); dirs(): string[]; refresh(): Promise<boolean /* changed */>; }
```

- [ ] **Step 1:** tests for `parseShellPath` (banner lines before and after the mark; no mark → undefined), `parseRegPath` (REG_SZ and REG_EXPAND_SZ lines), `expandWinVars` (`%USERPROFILE%\x`, unknown var kept), `mergeDirs` (drops dirs already in PATH and duplicates), `readUserPath` with a fake `run` for darwin (`$SHELL -lic`, falls back to `/bin/zsh` when SHELL is unset) and win32 (HKCU + HKLM joined), and a run that rejects → `[]`.
- [ ] **Step 2:** run `npx vitest run packages/core/test/user-path.test.ts` → fails (module missing).
- [ ] **Step 3:** implement. darwin/linux: `run(shell, ["-l", "-i", "-c", `printf '\n${PATH_MARK}%s\n' "$PATH"`], 5000)`; win32: `run("reg", ["query", "HKCU\\Environment", "/v", "Path"])` and the HKLM Session Manager key, expand, split on `;`. Errors and timeouts give `[]`. `UserPath.refresh()` compares the joined list. Under isolation the hub never calls it.
- [ ] **Step 4:** tests pass.
- [ ] **Step 5:** `app.ts`: `userPath = new UserPath()`; `cliBinDirs: () => (this.config.isolation.users ? [] : [...this.userPath.dirs(), ...this.cliTools.binDirs()])`; in `start()` `await this.userPath.refresh()` before `plugins.startAll` unless isolated. Commit.

### Task 2: Setup state and API

**Files:** Create `packages/core/src/setup.ts`, `packages/core/test/setup.test.ts`, `packages/core/test/fixtures/plugins/fakegated/{.openbot-plugin/plugin.json,server/index.ts}`, `packages/core/test/fixtures/setup-agents/assistant.md`; modify `packages/shared/src/types.ts`, `packages/core/src/app.ts`, `packages/core/src/server/main-app.ts`.

**Interfaces — produces (shared):**
```ts
export type SetupStep = "telegram" | "backupBrain" | "machines" | "profile";
export interface SetupBrain { ref: string; label: string; kind: "cli" | "api"; installed: boolean; signedIn: boolean; canInstall: boolean; detail?: string }
export interface SetupState {
  agentId: string; brains: SetupBrain[]; usable: boolean;
  vault: "absent" | "locked" | "open"; telegram: boolean; machines: number;
  done: SetupStep[]; skipped: SetupStep[]; remaining: SetupStep[];
}
```
**Core:** `class SetupGuide { constructor(d: SetupDeps); state(agentId?: string): Promise<SetupState>; usable(agentId?: string): Promise<boolean>; refresh(): Promise<void>; setStep(step: SetupStep, status: "done" | "skipped" | "todo"): void }`.
Settings key `setup` holds `{ kickoffDone?: boolean; done?: SetupStep[]; skipped?: SetupStep[] }`.

Rules: brains = the agent's local refs (`machineId === "local"`), `kind: "cli"` when the registry lists it with `login: true`; `installed = probe.available`, `signedIn = probe.authenticated`, `canInstall = !!cliTools.forBrain(brainId)`; `usable` = any of the agent's refs (local or remote) connected and authenticated (limits are not setup). `telegram` = the `telegram` channel's status is connected. Done: telegram when connected; backupBrain when two CLI brains are signed in or no second CLI is installed; machines when ≥ 1 paired; profile when marked done. `remaining` = all steps minus done minus skipped.

- [ ] **Step 1:** fixture `fakegated`: brain `gated` whose probe is `{ available: true, authenticated: existsSync(join(process.env.HOME!, ".gated-ok")), detail }` and whose session echoes `gated heard: <last line>`, and answers `SETUP?` with whether the system prompt has `## Hub setup`. Agent fixture: `brains: [gated@local, codex@local]`, `tools: ["*"]`.
- [ ] **Step 2:** test: `GET /api/setup` → `usable: false`, gated and codex listed (codex `kind: "cli"`, `installed: true`, `signedIn: false`), `remaining` contains `telegram`, `profile`. After writing `.gated-ok` and `POST /api/setup/refresh` → `usable: true`.
- [ ] **Step 3:** implement `setup.ts` state + routes (`GET /api/setup?agent=`, `POST /api/setup/refresh` → `userPath.refresh()`; if changed restart builtin brain plugins; `brains.invalidateAll()`; emit `brains.updated`; return state).
- [ ] **Step 4:** tests pass. Commit.

### Task 3: The card instead of the error, and the waiting message

**Files:** modify `packages/shared/src/types.ts` (`| { type: "brain_setup" }`), `packages/core/src/runner.ts`, `packages/core/src/setup.ts`, `packages/core/src/app.ts`; test in `setup.test.ts`.

**Interfaces:** `SetupGuide.hold(conversationId: string, prompt: string, opts: { replyChannel?: string; quote?: string }): void`; `SetupGuide.onUsable` runs `runner.resume(conversationId, prompt, opts)`; runner gets `setup?: { hold(...): void }` in deps (optional, set by the hub after construction) and a public `resume(conversationId, prompt, opts)` that enqueues `runTurn`.

Runner: `candidates()` also returns `setup: number` (skips for not connected / not available / not signed in). In `turn()`, when there is no ref, `tried.size === 0`, `usable.length === 0` and `setup === ordered.length` and the turn is not a task: hold the prompt; add a system message `{ type: "brain_setup" }` unless one of the last 10 messages already has one with no assistant message after it; return `{ text: "", error: "setup", awaitingApproval: false }` without the error part.

SetupGuide listens to `brains.updated` (debounced 300 ms): for each held conversation whose agent is now usable, drop the hold and resume once with the held prompts joined by a blank line. Holds older than 24 h are dropped.

- [ ] **Step 1:** test: say "привет" → a system message with a `brain_setup` part, no `error` part; say "ещё" → still one card; write `.gated-ok`, emit `brains.updated` → an assistant message `gated heard: ещё` (both prompts, last line) arrives once.
- [ ] **Step 2:** fails. **Step 3:** implement. **Step 4:** passes; existing `hub.test.ts` limit tests still pass. Commit.

### Task 4: The agent leads: kickoff, prompt block, tools

**Files:** modify `packages/core/src/setup.ts`, `packages/core/src/prompt.ts`, `packages/core/src/runner.ts`, `packages/core/src/tools/hub-tools.ts`, `packages/core/src/app.ts`; tests in `setup.test.ts`.

**Interfaces:** `SetupGuide.promptBlock(agentId: string): Promise<string | undefined>` (undefined unless default agent and something remains); `PromptContext.setup?: string`; runner deps `setupBlock?: (agentId: string) => Promise<string | undefined>` used in `openSession` when not background and no task.

Kickoff: SetupGuide remembers `sawUnusable` once the hub is started and the default agent was found not usable; when it turns usable and `setup.kickoffDone` is unset, it sets the flag and — unless held messages were resumed — calls `runner.tellAgent(mainConversation, KICKOFF_NOTE)`. A hub that is usable the first time it is checked just sets the flag.

Prompt block (English): heading `## Hub setup`, one line per remaining step with its tool (`hub_plugin_setup` with id `telegram`; `hub_brain_login`; `hub_machine_pairing_code`; profile via `memory_write`, `hub_settings_update` language and `hub_profile_update`), rules (one step at a time, ask first, "not now" → `hub_setup_update` skipped, secrets only through cards, check `hub_setup_status` before suggesting the next step), skipped steps on one line.

Tools: `hub_setup_status` (read) returns the state as JSON; `hub_setup_update { step, status }` (local-write) calls `setStep`.

- [ ] **Step 1:** tests: `SETUP?` → block present while steps remain; `CALL hub_setup_update {"step":"telegram","status":"skipped"}` updates `/api/setup` `skipped`; kickoff: fresh guide with nothing held, sign in → one assistant message in the main conversation, and not again after the next `brains.updated`.
- [ ] **Step 2–4:** fail, implement, pass. Commit.

### Task 5: Web card, checklist out

**Files:** create `packages/web/src/components/BrainSetupCard.tsx`, `packages/web/src/lib/setup.ts`, `packages/web/src/lib/setup.test.ts`; modify `BrainLoginCard.tsx`, `MessageView.tsx`, `ChatView.tsx` (`bottom?: ReactNode`), `ChatPage.tsx`, `AgentPage.tsx`, `packages/web/src/i18n/{en,ru}.ts`; delete `pages/chat/Checklist.tsx`.

**Interfaces:** `primaryRef(s: SetupState): string | undefined` (first installed unsigned CLI, else first CLI that can install); `showGate(messages: Message[], s: SetupState | null): boolean` (not usable and no `brain_setup` part after the last assistant message). `BrainLoginCard` prop `install?: boolean` → button `setup.installAndSignIn`.

Card: title `setup.title`, intro `setup.intro`, a compact `BrainLoginCard` per CLI brain (primary one first), a `details` "Use an API key" with `VaultGate` + `PluginSetupCard` `brain-claude-code` and `brain-api`, **Check again** (`POST /api/setup/refresh`). When usable: one line `setup.connected` with the signed-in brain's label. It loads `/api/setup?agent=` and reloads on `brains.updated`, `plugins.updated`, `vault.state`, `brain.login`.

- [ ] **Step 1:** `lib/setup.test.ts` for `primaryRef` and `showGate`. **Step 2:** fails. **Step 3:** implement helpers, card, wiring, i18n keys (en + ru), remove checklist keys and file. **Step 4:** `npx vitest run packages/web` and `npm run typecheck` pass. Commit.

### Task 6: Docs, full checks, manual run

- [ ] README.md / README.ru.md: the first-run paragraph says the chat shows the sign-in card and the assistant then guides the rest.
- [ ] Spec: note `hub_setup_status` / `hub_setup_update`, no new bus event (the web reloads on existing ones), kickoff in the default agent's main dialog, held messages kept in memory.
- [ ] `npm run typecheck`, `npm test`, `npm run build`.
- [ ] Manual: `OPENBOT_DATA_DIR=<fresh> OPENBOT_INSTALL_CLIS=1 npm start` on alternate ports; set up the owner; the card lists Claude Code and Codex as installed and not signed in; say "привет" → card, no error. Commit.
