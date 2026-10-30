# Front desk: a quick answer at once, heavy work on the side, the right brain for each job

Asked 2026-10-29. On each message the agent judges whether the job is small. Coding, analysis and anything long
start a task at once; the dialog never waits for it. The task's results, questions and permission requests come back
to the dialog's agent, which decides what the person sees. The system picks the brain and how deeply it thinks for
every job, across all brains (Claude Code, Codex, API), not only Claude Code. The first reply must come much sooner,
and the person always sees what is happening now.

## Measured (this Mac, Claude Code 2.1.310)

| | first text after the message |
| --- | --- |
| `claude -p`, cold process (today: one per turn), Sonnet | ~7 s (3.0–3.4 s of it is start-up) |
| same, Haiku | ~4.3 s |
| process started earlier, waiting on stdin, Sonnet | ~2.0 s |
| second turn in the same live process | ~2.7 s |

The process does its start-up work before the first input arrives, so a process started when the chat opens answers
like a warm one.

## Design

### 1. Warm brains

- The Claude Code session keeps its process after a turn: stdin stays open, the next turn is one more `user` line in
  the same process. The turn ends at its `result` (once every input of the turn was replayed), as today.
- An idle process closes after 10 minutes. At most 3 idle processes stay warm per brain plugin; the oldest idle one
  closes first. A process that dies is started again with `--resume` on the next turn.
- `BrainSessionImpl.warm?()`: start the process ahead of the first input (no input sent). RPC `brain.warm
  {sessionId}` (plugins, node daemon); `BrainHandle.warm()` on the hub, which never fails.
- The hub warms a dialog when the person opens it or starts typing: `POST /api/conversations/:id/warm` (at most once
  a minute per conversation from the web). It opens the session the next turn would use and calls `warm()`.
- Codex keeps one `app-server` per turn for now: it mostly runs tasks, where start-up is not what the person waits
  for.

### 2. The dialog thinks on "auto"

- New preset `auto`. For dialogs (kind `chat`) it means: think fast, on the quickest brain that can take the turn now.
  Brains are ordered API first (no process to start), then Claude Code, then Codex, the hub's own computer before
  others; the usual checks (signed in, not over a limit, not busy) pick the first usable one. On each brain `auto`
  means its `fast` preset.
- `auto` is the default for dialogs of agents with no choice of their own. Another kind (task, feed, schedule) that
  follows an `auto` dialog thinks `balanced`.
- The dialog's prompt makes it a front desk: answer in a moment what takes a moment; anything with steps or deep
  thought goes to a task at once, with one short line to the person; never do long work in the dialog.
- The front desk's own tools only look (`BrainSessionOptions.frontDesk`): Claude Code runs without Bash, Write,
  Edit, MultiEdit and NotebookEdit; Codex gets a read-only sandbox and asks for nothing. A prompt alone did not hold
  (checked live: a "fast" Claude Code wrote and ran a script in the dialog itself); without the tools it delegates.
- `task_delegate` refuses a call without a goal, and takes `task`/`instructions` as the goal: Claude Code loads MCP
  schemas lazily and its first call may guess the names.

### 2a. Routing under the hood (added 2026-10-29: "a smart, extensible choice across providers")

- Every request is routed (`core/src/model-router.ts`): it has a need (light: a word in passing or a simple errand;
  quick: the dialog's front desk; standard: everyday work; deep: hard problems) and may have a skill (code,
  reasoning, writing). The router scores every model of every brain the agent may use and orders the brains, each
  with its best model and the effort that fits (light/quick: low, standard: medium, deep: xhigh or the nearest).
- Brains describe their models (`ProbeResult.catalog`, `shared/models.ts`): tier 1–5, speed, cost, what they are
  good at, strongest first. Known families of every provider are in a table (Claude, GPT, Gemini, Kimi, DeepSeek, GLM,
  Qwen, Grok, Mistral, Llama…); a brain's own catalog wins; a model nobody describes takes the role its brain gives it
  in its presets. The router reads profiles only: a new provider counts as soon as its brain lists its models.
- Needs: a dialog message is light when it is a word in passing ("thanks", "ok", an emoji), else quick; a task's need
  is the `depth` its starter gave (fast → light, balanced → standard, deep → deep), its skill the `about`
  (code, analysis, writing, research, errand) or its goal's words; channel runs are light, other work standard. A
  preset the person chose for a kind is its need; an exact model and effort skip the router.
- Code tasks need hands: brains without a shell of their own (API) are left out for them.
- A dialog stays with the agent's own brain (the one chosen for its dialogs, else its first): the router picks the
  model and effort on it, and another brain takes over only when that one cannot. Moving a dialog between brains
  loses its native history, and the person's choice of brain is theirs. A brain chosen for the kind also comes
  before the brain the conversation fell back to. Work on the side is routed across brains.
- Presets that name one model for every role (Codex: its default model, only the effort changes) say nothing about
  that model: found live, when Codex's unknown GPT-6 Astra looked the strongest, quickest and cheapest at once and
  answered a weather question. The table knows GPT-6 Astra and the GPT-5.6 line (Sol, Terra, Luna).
- Models switch per turn without starting over: Claude Code takes `set_model` and `apply_flag_settings
  {effortLevel}` control requests on stdin (checked live: Sonnet → Haiku → Opus, low → high in one process); Codex
  and the API brain take the turn's model and effort (`BrainTurn.model`, `effort`).
- Claude Code records a switch as a `/model` command whose output "goes straight to the user", and a light model
  then remarks on it ("model switched to Haiku"). The rules say what that trace is, and a turn whose model changed
  starts with a one-line note not to mention it (checked live: the remark is gone).
- Providers: the API brain's OpenAI-compatible providers are one table (`plugins/brain-api/server/settings.ts`
  PROVIDERS): Kimi (Moonshot), DeepSeek, GLM (Z.ai), Qwen, Gemini, Grok (xAI), Mistral, Groq, besides Anthropic,
  OpenAI and OpenRouter. Each has its key in the vault (a setup card), its host, and its main models; `extraModels`
  adds newer ones. Agents list `api:*` for every provider that is set up.

### 3. The right brain for each task

- `task_delegate` takes `depth` (`fast` | `balanced` | `deep`) and `brain` (a brain id the agent has: `claude-code`,
  `codex`, `api:anthropic`, …). Both optional; `machine` still picks the computer. Stored as `Task.thinking`
  (`ThinkingChoice`), it comes before the task kind's own choice.
- Dialogs get "Brains here": each brain the team can use, what it is best at, and its models (from probes). Codex:
  code (changes, refactors, tests, scripts). Claude Code: analysis, research, writing, the browser, everyday work. API
  brains: quick answers, no shell.
- A brain over its limit or not signed in falls back to the next of the agent's brains, as today; a task pinned to a
  computer stays there.

### 4. What is happening now

- `MachineWork` (machines.activity) gains `detail`: the file name, the search query or site, the command's first
  words, or the hub tool's name.
- The chat shows a live line instead of the three dots while a reply has no text yet: "Thinking…", "Reading
  plan.md…", "Searching the web: …", "Running: npm test…", "Starting a task…", "Waiting for your permission".
- A task's line in the chat shows its current step while it runs.
- The iPhone chat is the same page and gets both.

### 5. Tasks report to the dialog's agent

- Results and questions already reach the dialog's agent (`inject`), which tells the person in its own words.
- A permission a task asks for also appears in the dialog that started it: a message with the task's line and the
  approval card. Answering it anywhere updates both.

## Tests

- brains-cli: the fake Claude CLI keeps one process for two turns; `warm()` starts it before input; idle close;
  a dead process resumes; steering still joins the turn.
- core: `auto` orders brains fastest first and resolves to `fast`; other kinds follow as `balanced`; `task_delegate`
  `depth`/`brain` reach the task's session (model and effort); the warm route opens the session and calls `warm`;
  a task's approval card shows in the starter dialog and updates there; `detail` in machine activity.
- web: the live line's text for each step.
- Measured end to end on a throwaway hub with the real Claude Code: message to first text, before and after.

## Measured after (throwaway hub, real Claude Code, same three messages)

| | message 1 | message 2 | message 3 |
| --- | --- | --- | --- |
| before (one process per turn, brain's default model) | 10.4 s | 5.7 s | 3.4 s |
| after, chat opened first (warm), "auto" | 3.1–3.4 s | 2.7 s (one run 7.7 s) | 0.9–4.7 s |
| after, no warm-up | 7.6 s | 2.6 s | 1.7 s |

Routed (front desk Sonnet low, "thanks" on Haiku, back to Sonnet, one warm process): 2.5–4.8 s, 2.8–4.0 s, 3.0–4.9 s;
the router and the brain checks take under a millisecond. The model's own latency varies by several seconds between runs; the process start (3+ s) is gone from every message
but the very first one after the chat has been closed for 10 minutes.
