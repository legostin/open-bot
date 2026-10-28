# Teammates write to each other: a message, not a task

An agent that wants something from a teammate used to start a whole task (`task_delegate`). Now it writes to them,
the way a person writes to a colleague: "ask the Researcher to check X". Underneath it is a small task, so it reuses
everything tasks already have (their own thread and brain session, live status, the line both ways, the nesting
limit, budgets, recovery after a restart). On the surface it reads like a message and its answer.

## How it feels

- In the sender's dialog: "I'll ask the Researcher." and a message line "→ (avatar) Researcher: «…»" with a live
  status (answering… / waiting for an answer / answered). The answer appears right under the question (three lines,
  more on a click). The line opens the thread.
- The answer goes back to the sender by itself: into its running turn if it still works (steer), else it starts a
  turn, and the sender tells the user the outcome.
- Writing to the same teammate again continues the same thread (open, or answered within the last hour), so the
  teammate keeps the context of a follow-up.
- The thread page reads as a conversation between the two agents: the sender's messages under its name and avatar,
  the teammate's replies. The user can write there, or stop it.
- The user: "@" in a dialog's composer suggests teammates; "@Researcher …" or "ask the Researcher…" becomes a
  `team_message`.
- Service details (tool calls, the `[System]` notes carrying replies) show only in detailed mode.

## Contracts

- `Task.kind?: "message"`: a thread started by `team_message`; `Task.from?`: the teammate who wrote (`agentId` is the
  one answering). `Task.tainted?: boolean`: started (or messaged) from a session that had read outside content.
  Columns `tasks.kind`, `tasks.from_agent`, `tasks.tainted`.
- The `task` message part gets optional `text` (what the sender wrote) and `reply` (the answer to it, filled in when
  it comes). Without `text` it is the task line as before.
- A user-role message with `agentId` is written by that agent (a thread's opening message and its follow-ups).

## Hub

- `team_message {to, text}` (core tool, `local-write`, like `task_delegate`): `to` is an agent id or name, never the
  sender. Continues the latest thread from this conversation to that teammate when it is open or was answered within
  the last hour (its next turn, or steered into the running one); else starts a thread (a task of kind "message",
  background when the sender is). Adds the message line to the sender's reply.
- The teammate gets "Message from your teammate <name> (agent "<id>"). Your reply goes back to them automatically."
  and the text; its system prompt says it is answering a teammate in a thread. Its reply (the final answer, without
  the narration around tools) is the thread's result: it fills the line(s) still waiting in the sender's
  conversation and reaches the sender as `[System] <name> replied …` through the existing starter line. A thread
  that cannot answer (no brain) tells the sender so instead of notifying the user.
- Limits: a new thread counts in the nesting limit of 3 (shared with tasks); at most 6 teammate messages from one
  conversation since the user last wrote there (the refusal says to report to the user first). Nothing waits on
  anything, so there is no deadlock: replies steer or queue.
- Taint, both ways, for threads and tasks alike: a task or thread started or messaged from a tainted session starts
  tainted (its sessions are marked before its first step); a tainted task's or thread's result or question marks the
  session that receives it (steered or as a turn).
- Telegram: threads are never mirrored (task conversations are not). A turn nobody typed in the main agent's dialog
  that only wrote to a teammate again is not mirrored either; its outcome turn is, as task results are today.

## Prompt

- Dialogs ("How you work"): a question or small request for a teammate, including "ask X" and "@id" from the user,
  goes to them with `team_message`; anything with steps is still a task. The team list names `to` and `agent`.
- Tasks and threads: "need something from a teammate? `team_message` them". `task_delegate` and `task_agents`
  descriptions point quick asks to `team_message`. The Researcher's tools get `team_*`.

## Clients

- Web: the message line (both avatars, status, the answer inline), the thread page header "A ↔ B" and agents'
  messages under their names, "@" teammate suggestions in dialogs.

## Tests

Fake brain: a thread and its line, a reply that steers into a running turn and one that starts a turn, continuing a
thread, the depth limit and the 6-message limit, taint both ways (threads and `task_delegate`), no mirroring of a
turn that only wrote to a teammate, the prompt. A browser check against a test hub on spare ports.
