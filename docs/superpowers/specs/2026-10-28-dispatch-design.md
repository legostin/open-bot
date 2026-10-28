# Agents as entry points: tasks on the side, a live line both ways

The user talks to an agent (usually the assistant) in its dialog: "check this, check that", two requests in one
message, more while the first ones run. The agent stays responsive and routes the work: it answers quick things
itself and starts a task for everything that takes steps, picking who does it and on which computer, asking only
when the choice matters and is unclear. The user does not watch the work; they get results. A task can ask the
agent who started it a question, and the agent can send a task more details while it runs.

## What the brains can do (checked 2026-10-28)

Every brain kind can take more input while a turn runs ("steering"):

| Brain | How | When the input lands |
| --- | --- | --- |
| Claude Code 2.1 | `claude -p --input-format stream-json --replay-user-messages`, more `user` lines on stdin | at the next step (after the tool that is running); during the final answer the turn ends and the CLI answers the new input right after, in the same process |
| Codex 0.153 | `codex app-server` (JSON-RPC on stdio): `turn/start`, then `turn/steer {threadId, expectedTurnId, input}` | at the next step, inside the same turn, also during the final answer |
| API brains (Anthropic, OpenAI-compatible) | the plugin runs the loop itself | before the next model call: after the tool results, or as a new user message when the model stopped |
| Remote machines | the node daemon runs the same Claude Code / Codex adapters | as above; a node without `brain.steer` gets the input as the next turn |

Older CLIs keep working: Codex without `app-server`/`turn/steer` falls back to `codex exec`; a brain that cannot
steer (or a turn that just ended) gets the input as its next turn, as today.

## Contracts

- `BrainSessionImpl.steer?(turn): boolean | Promise<boolean>`: add the input to the turn in progress; false when
  there is none to join. RPC `brain.steer {sessionId, turn} → {accepted}` (plugins and the node daemon).
  `BrainHandle.steer(turn)` on the hub: false on any error (old plugin or node).
- `Task.question?: string`: an open question the task asked whoever started it. Status `waiting_input` (declared,
  now used): the task's turn ended while the question is open.
- `MessagePart { type: "task"; taskId }`: the task line in the chat that started it.

## Hub

- **Steering a dialog.** A user message in a dialog (not a group) while the agent's turn runs is steered into it.
  The reply so far is closed and the turn goes on in a new assistant message, so the answer follows the message it
  answers. The channel it came from gets the reply too. Messages with voice notes are transcribed first.
  Accepted → no queued turn; refused → queued as today.
- **`inject(conversation, note)`**: the one way the hub tells an agent something while it may be working: steer
  into its turn, else start one. Task results, a task's question, answers and clarifications all go through it.
  Into a task's conversation it goes through the task (status, result, report).
- **Tasks.**
  - `task_delegate {goal, title, agent?, machine?}`: `machine` (id or name) pins the task's brain to that computer
    (the agent's brain kind there); a computer without one runs the task on the agent's brain with a note to work
    there through `machine_*` tools; an offline one is refused. A pinned task does not fall back to other brains.
    Depth limit 3. The tool adds the task line to the reply.
  - `task_message {taskId, text}` (the starter, a parent task or the task's own agent): steers into the running
    task, or wakes a finished/waiting one for another turn; a queued task gets it with its goal. Clears the open
    question.
  - `task_ask {question}` (inside a task): records the question and injects it into whoever started the task (the
    parent dialog or task; a task the user started asks in its agent's dialog). The task goes on with what does
    not depend on the answer; if its turn ends with the question open, it waits (`waiting_input`).
  - `task_cancel {taskId}`.
  - A finished task reports to its starter through `inject` (it may steer the starter's running turn).
- **Dialog turns** carry `[Open tasks]` lines (id, title, agent, computer, status, open question) when the dialog
  has started tasks that are not finished.
- **Prompt.** Dialogs get "How you work": answer quick things directly; anything with steps goes to a task, one per
  independent request; reply in a line; route by role and computer, ask one short question only when unclear and it
  matters; new input during work goes to the right task; a task's question is answered with `task_message` or asked
  of the user. Plus the team (agents, their roles and where their brains run) and the computers. Tasks get "do the
  work yourself; `task_ask` when only the starter knows".

## Clients

- Web chat: the task line (agent avatar, title, computer, status; waiting is highlighted) opens the task. The
  iPhone chat is the same page. System notes between agent and task stay hidden as before.

## Tests

Fake CLIs speak stream-json input / app-server; the core fake brain steers in a `SLOW` turn; flows: steering a
dialog, fallback when a brain cannot steer, `task_ask` → answer → resume → result, clarification into a running
task, machine pinning, depth limit. Live: Claude Code and Codex adapters steered for real.
