# Teach mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agents learn a browser task from the person's demonstration (steps, voice, highlights), save it as a
skill on the person's tap with pre-approved consequential clicks, learn from hints and repeats, and run it on a
schedule. Spec: `docs/superpowers/specs/2026-10-31-teach-mode-design.md`.

**Architecture:** three parts with fixed interfaces between them, built in parallel in one worktree:
A) core (contracts, policy, core methods, `hub_skill_save`), B) browser plugin server (recorder, journal, tools),
C) browser plugin UI (teach bar, highlight, voice). The UI ↔ server protocol and the core methods below are the
only coupling.

**Tech Stack:** Node ≥ 24 TypeScript (type stripping, `.ts` imports, `import type`), vitest, Playwright/CDP, React
(plugin UI, built by `npm run build`), node:sqlite migrations in `packages/core/src/db.ts`.

## Global Constraints

- Every user-facing string through a catalog (core: `packages/core/src/locales/{en,ru}.ts`; plugin:
  `plugins/browser/.piomio-plugin/locales/{en,ru}.json`); English source of truth; parity test
  `packages/core/test/i18n.test.ts`. Text for the model is English and not translated.
- Plugins only `import type` from `@piomio/plugin-sdk`. Tool names `browser_<name>` / `hub_<name>`.
- No page script in the page's main world: element info comes from our isolated world (`isolatedEval`).
- Secrets (password, one-time code, card fields) never enter a recording.
- Tests write temp files only under `tmpdir()`.
- Owners: A edits only `packages/shared`, `packages/core`, `plugins/triggers`; B edits only `plugins/browser/server`,
  `plugins/browser/test`, `plugins/browser/skills`, `plugins/browser/.piomio-plugin/plugin.json`; C edits only
  `plugins/browser/ui` and `plugins/browser/.piomio-plugin/locales`.

## Interfaces

**Core methods** (A implements, B calls; listed in `CORE_METHODS`, granted in the browser's `permissions.core`):
- `conversations.tell` `{ conversationId?: string; taskId?: string; text: string }` →
  `{ conversationId: string; delivered: "task" | "dialog" }`. A task that exists: `runner.wakeTask(task, text)`;
  otherwise `runner.tellAgent(conv, text)` on `conversationId`, or the default agent's dialog when none.
- `speech.transcribe` `{ data: string /* base64 */; mimeType: string }` → `{ text: string }`;
  `{ check: true }` → `{ available: boolean }`. Throws with the reason when it fails.
- `tasks.create` takes `skill?: string` (a taught skill's name).

**Contracts** (A): `RuleCondition` gains `{ field: string; op: "max"; value: number }` (a number ≤ value);
`Rule.createdVia` gains `"skill"`; `Task.skill?: string`; `Skill` (core `skills.ts`) gains `taught: boolean`,
`sites: string[]` from frontmatter `taught: true`, `sites: [..]`.

**Tools for agents:**
- A: `hub_skill_save { name, description, instructions, files?: string[], sites?: string[], allow?: Array<{ site:
  string; label: string; maxAmount?: number; currency?: string }>, replaces?: string }`, `hub_skill_delete { name }`.
- B: `browser_teach { goal: string; scope?: "task" | "step" }`, `browser_journal { action: "list" | "read" |
  "export" | "forget" | "dismiss"; id?: string; day?: "today" | "all" }`, `browser_submit` + `amount?: number`,
  `currency?: string`.

**UI ↔ plugin server** (B implements the server side, C the UI side):
- UI → server `send(...)`: `{ type: "teach", action: "start" | "done" | "cancel" }` ("start" = the ⋯ menu, for the
  default agent); `{ type: "highlight", x0, y0, x1, y1 }` (0..1 in the picture, like `input` x/y).
- UI → server HTTP: `POST teach/speech` `{ data: string /* base64 */, mimeType: string, durationMs: number }` →
  `{ text?: string; error?: string }` (the server places the words at `now - durationMs`).
- Server → UI: `state.teach: null | { id: string; goal: string; scope: "task" | "step"; startedAt: number; steps:
  number; speech: boolean }`; `activity.teach: boolean` (with `attention: true` while a teach session runs);
  event `"highlight"` `{ ok: boolean; text?: string }` after a frame was taken.
- Browser setting `rememberActions` (boolean, default true): title key `settings.rememberActions.title`,
  description key `settings.rememberActions.description` (C adds the strings).

---

### Task A: core contracts, core methods, skills on the person's tap, scheduled skill runs

**Files:** `packages/shared/src/types.ts`, `packages/shared/src/manifest.ts` (CORE_METHODS), `packages/core/src/
core-call.ts`, `packages/core/src/policy/engine.ts`, `packages/core/src/tools/gateway.ts`, `packages/core/src/
skills.ts`, `packages/core/src/tools/hub-tools.ts`, `packages/core/src/db.ts`, `packages/core/src/store.ts`,
`packages/core/src/runner.ts`, `packages/core/src/locales/{en,ru}.ts`, `plugins/triggers/server/*` (trigger `skill`),
the security console's rule rendering if it lists ops; tests next to the existing ones in `packages/core/test`.

- [ ] Rule op `max` in `conditionMatches` (finite number ≤ value; strings like "2400" count; missing → no match) and
  wherever rules are validated or shown. Test in the policy tests.
- [ ] `Task.skill`: migration `alter table tasks add column skill text`, store read/write, `createTask({ skill })`,
  `tasks.create` param. PolicyInput `skillRun: boolean` (gateway: the session's task has a skill that is `taught`).
  `decide`: the background read-only rule does not apply when `skillRun`; local-write is then allowed, external goes
  to rules or a card. Tests: background initiative 1 + skillRun allows browser_click, asks browser_submit, a matching
  rule allows it.
- [ ] `conversations.tell` and `speech.transcribe` in `core-call.ts` (temp file under `tmpdir()`, removed after).
  Tests with a fake runner / transcriber in the core-call tests.
- [ ] `Skill.taught` / `Skill.sites` from frontmatter.
- [ ] `hub_skill_save`: validates (name `^[a-z0-9][a-z0-9-]{0,39}$`, description ≤ 300, instructions ≤ 20 000,
  ≤ 20 files inside the session's workspace, ≤ 5 MB each; a built-in or plugin skill name is refused; an existing
  taught skill needs `replaces` = its name). Always asks on its own approval card (like `permission_always`; add to
  OWN_CARD) with the summary from core locales: save/update line + one line per `allow` ("«label» on site, up to
  amount"). On yes: writes `<dataDir>/skills/<name>/SKILL.md` (frontmatter name, description, `taught: true`, sites,
  agent, created/updated; then the instructions), copies the files (basenames, numbered on collision; a replace
  clears the old folder), removes rules noted `skill:<name>`, adds one rule per allow — tool `browser_submit`,
  conditions `url` domain site, `label` eq (or glob with digit runs as `*`), `amount` max, `currency` eq (upper
  case), decision allow, `createdVia: "skill"`, note `skill:<name>` — adds the sites to known targets, reloads
  skills, audits. `hub_skill_delete` removes a taught skill's folder and its rules. Tests: card text, refused
  without yes, files and rules after yes, replaces, delete, names of other skills refused.
- [ ] Triggers: optional `skill` on a trigger (types, validation, the create/update tool's schema with a one-line
  description, engine passes it to `tasks.create`). Test in the triggers tests.
- [ ] `npm run typecheck` (errors in files of B/C may be theirs), the core + triggers tests, commit.

### Task B: browser plugin server — recorder, journal, teach sessions, hints, repeats, tools

**Files:** create `plugins/browser/server/recorder.ts`, `plugins/browser/server/journal.ts`,
`plugins/browser/skills/teach-by-demo/SKILL.md`, `plugins/browser/test/recorder.test.ts`,
`plugins/browser/test/journal.test.ts`; modify `plugins/browser/server/page-script.ts` (ops `at`, `area`, `field`),
`manager.ts`, `tools.ts`, `index.ts`, `util.ts` (setting), `.piomio-plugin/plugin.json` (setting, core permissions),
`test/browser.test.ts` (teach flow, submit amount).

- [ ] Recorder (pure): `new Recorder({ kind: "teach" | "takeover", goal?, now })`, `pointer(info, at)`,
  `text(chars, field, at)`, `key(key, field, at)`, `page(url, title, at)`, `tab(action, at)`, `scroll(at)`,
  `highlight(area, crop?, at)`, `say(text, at)`, `finish(at): Recording`; `toMarkdown(rec)`; `hintText(rec)`.
  Tests first: click merge, typing merge + Backspace, secret fields, page steps deduped, speech placed by time,
  markdown shape.
- [ ] Page-script ops in the isolated world: `at {x, y}` (the interactive ancestor's role/name/href/editable/
  secret/submit-like, or `{ frame: host }` for another site's frame), `area {x0, y0, x1, y1}` (text inside ≤ 1 500
  chars and up to 15 controls), `field` (the focused field's info and value; no value for secret fields). Test the
  names against `snapshot` on a real page in `browser.test.ts`.
- [ ] Journal: `<dataDir>/journal/<id>.json` + `<id>-<n>.jpg`, prune after 30 days / beyond 500, `list`, `get`,
  `forget({ id } | { day: "today" | "all" })`, `findRepeats(all, rec)` (same origin, ≥ 3 steps, Jaccard of
  step keys ≥ 0.6 and same order of the shared keys; ≥ 2 earlier sessions on other days or ≥ 3 in all; dismissed
  signatures skipped). Tests first.
- [ ] Manager: teach session state, recorder on takeover, input capture (await `at` ≤ 300 ms before dispatching a
  mouse down; `field` on the first key of a field), highlight (crop via `Page.captureScreenshot` clip), speech HTTP
  route, Done/Cancel/end on leaving the view (2 min without watchers), `state.teach` / `activity.teach`, files +
  `conversations.tell` at Done, hint notes after a takeover while an agent used the browser in the last 10 min,
  journal + repeats for free use when `rememberActions`.
- [ ] Tools `browser_teach`, `browser_journal`, `browser_submit` amount (refused unless the number is on the page in
  any common format: `2400`, `2 400`, `2 400`, `2,400`, `2.400`, with decimals). Tool descriptions say when to use
  them and point to the `teach-by-demo` skill.
- [ ] `skills/teach-by-demo/SKILL.md`.
- [ ] Plugin tests + typecheck, commit.

### Task C: browser plugin UI — teach bar, highlight, voice, menu

**Files:** create `plugins/browser/ui/src/teach.tsx` (bar + voice), `plugins/browser/ui/src/highlight.tsx`
(frame overlay); modify `view.tsx`, `screen.tsx`, `chrome.tsx` (⋯ menu "Teach", Highlight button), `host.ts`
(`BrowserState.teach`, `Activity.teach`), `index.tsx` (attention while teaching), `styles.ts`, plugin locales.

- [ ] Teach bar (desktop: above the page; phone: under the address): red dot, "Showing: {goal}" (or "Showing the
  agent" without one), steps count, mic toggle with a level ring, Highlight toggle, Done (primary), Cancel. The view
  calls `expand()` when `state.teach` appears in the mini mode.
- [ ] Highlight mode: an overlay over the picture takes mouse/touch drags (stopPropagation so nothing reaches the
  page), draws the frame, sends `{type:"highlight", ...}` with coordinates relative to the image box (the zoom
  included, as `pos()` does), flashes on the `"highlight"` event, leaves the mode after one frame. The Highlight
  button also shows whenever the person is in control.
- [ ] Voice: while teaching and `state.teach.speech`, getUserMedia audio; AudioContext analyser for the level and
  silence; MediaRecorder segments (end after 0.8 s silence or 20 s; drop segments without speech); POST
  `teach/speech`; on `error` show it once and turn the mic off. Mic off by tap. Stops on Done/Cancel/unmount.
- [ ] ⋯ menu item "Teach" → `send({type:"teach", action:"start"})` (also takes control).
- [ ] Locale keys (en + ru) for everything above and `settings.rememberActions.*`.
- [ ] `npm run build` (UI plugins) and typecheck, commit.

### Task D: integration, review, live check, merge

- [ ] Review A and C diffs against this plan; full `npm run typecheck`, `npm test`, `npm run build`.
- [ ] Live check on a throwaway hub with a scripted brain or a real one: teach start → steps → highlight → Done →
  note + files in the workspace → `hub_skill_save` card → skill folder + rules; hint after a takeover; repeat offer.
  Stop the hub and delete its data dir afterwards.
- [ ] Merge into main, remove the worktree.
