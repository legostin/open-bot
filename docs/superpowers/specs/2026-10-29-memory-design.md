# Memory: how the team remembers, and how the person sees it

2026-10-29. The memory plugin (`plugins/memory`) becomes structured, time-aware and self-maintaining, and the person gets
a memory manager on the web and on the phone. Markdown files with git history stay the record: people can read them,
edit them and roll them back without Owlbot.

## What the best systems do, and what we take

| System | Idea | Taken here |
|---|---|---|
| Letta / MemGPT | Tiers: core memory always in context, recall and archival memory searched on demand; "sleep-time" agents tidy memory in the background. | A small **core** block at session start (who the user is, strongest preferences); everything else is **recalled per turn** within a budget; a nightly **tidy** pass plus an optional **reflection** task on the agent's own brain. |
| mem0 | Extract → update loop: new facts are compared with similar ones and the model chooses ADD / UPDATE / DELETE / NOOP. | `memory_remember` does the comparison on the hub (duplicates, slots, `replaces`) and shows the agent related facts so its own brain decides; no extra model call per turn. |
| Zep / Graphiti | Temporal knowledge graph: facts link entities and carry validity intervals; a newer fact invalidates an older one instead of deleting it. | Facts name their **entities** (`about`), carry **valid_from / valid_until**, and a superseded fact is archived with `superseded_by`, so history and "what was true when" survive. Entity pages are derived from `about`. |
| ChatGPT / Claude memory | The model saves memories with a tool, the chat shows "Memory updated", the person can see, edit and delete everything. | A quiet **"Remembered: … · Undo"** line under the agent's message; the memory manager lists everything grouped by meaning; forget goes to a trash with undo and stays in git. |
| Generative agents | Retrieval score = recency + importance + relevance; reflection turns observations into higher-level insights. | Hybrid recall score = lexical (FTS5 bm25) + entity overlap + importance + recency + confidence, with a relevance gate. Reflection runs as a background task over the day's messages. |

Embeddings are not required: lexical + entities + time works offline on every hub. `recall.ts` has a seam
(`Embedder`) for a local embedding model later; none ships tonight.

## The fact

One fact per markdown file. New frontmatter fields are optional, so v1 files load unchanged ("lazy migration"):
missing fields are derived when a file is read and written only when the fact is next saved. Unknown keys a person
added by hand are kept.

```yaml
---
title: Lives in Perm
kind: self            # self | person | place | preference | project | event | howto | note
about: [Perm]         # entities the fact mentions
slot: home city       # a changeable attribute: a newer fact with the same subject + slot supersedes this one
tags: []
importance: 4         # 1..5
confidence: 0.9       # 0..1
valid_from: 2026-10-20
valid_until: ""       # set when it stopped being true (superseded, expired)
superseded_by: ""     # the fact that replaced it
supersedes: []        # facts this one replaced (undo restores them)
scope: team           # team | agent:<id> (private to one agent)
sensitive: false
created: …
updated: …
source: assistant/s_1 # v1 provenance, kept
sources: [{agent: assistant, conversation: c_1, session: s_1, at: …, quote: "I moved to Perm"}]
status: active        # active | review | archived
---

The user moved from Kazan to Perm in October 2026.
```

Folders by kind for new facts: `you/`, `people/`, `places/`, `preferences/`, `projects/`, `timeline/`, `howto/`,
`notes/`. Existing files keep their paths; their kind comes from the folder (`profile.md` → self, importance 5).

Derived, not stored in files: usage (times recalled, last recalled) lives in `state.db` next to the search index, so
recall never makes a git commit.

## Capture

1. **In the turn, by the agent** (`memory_remember`). The system prompt asks agents to save durable facts the moment
   they learn them: one self-contained fact per call, in the third person, with kind, entities and a slot for
   changeable attributes. The hub then:
   - refuses secrets (passwords, tokens, keys, card numbers, private keys): they belong in the vault (`vault://id`);
   - finds a **duplicate** (token overlap ≥ 0.8): adds the new source, raises confidence, "Already known";
   - **supersedes** facts named in `replaces`, or with the same subject + slot: they are archived with
     `valid_until` and `superseded_by`, the new fact lists them in `supersedes`;
   - sends **sensitive** facts (health, money, beliefs, intimate life, documents; or `sensitive: true`) to the review
     queue: not recalled until the person says yes, right in the chat line or in the manager;
   - after untrusted content the existing approval card applies (`askWhenTainted`).
   - returns related facts so the agent can correct itself (`replaces`) in the next call.
2. **After the day, by reflection.** The plugin keeps a short journal of the person's own messages (from the
   `turn.context` hook, secrets already replaced by vault references). Once a day, when there are new messages, it
   starts a background task for the default agent: read these messages, remember what is durable and missing, fix
   what changed. The journal is emptied after the task is created (setting `reflect`, on by default).

## Recall

- **Session start** (`session.start`): instructions plus the core block: the strongest facts about the user and their
  preferences (importance ≥ 4) and the v1 `profile.md`, within `promptMaxChars`. No more whole-index dumps.
- **Every turn** (new hook `turn.context`): the person's message is scored against active facts the agent may see
  (team facts and its own private ones). Facts above the gate, not shown to this session in its last turns, go before
  the message as a `[Memory]` block within `recallMaxChars`. Nothing relevant → nothing added.
- `memory_search` uses the same ranking; archived facts appear only when asked (`include_archived`).

## Consolidation ("sleep")

Hourly check, runs when the last pass is older than 20 hours, or on demand ("Tidy up"):
- expire facts whose `valid_until` passed;
- merge near-duplicates (overlap ≥ 0.85, same scope): keep the newer, move sources, tags and entities into it,
  archive the other with `superseded_by`;
- archive stale low-value facts (importance ≤ 2, untouched for 180 days, not recalled for 90);
- regenerate `MEMORY.md` (grouped by kind) — the profile is the "You" group, always current;
- start the reflection task (above).
Every change is one git commit, so a pass can be rolled back.

## Control and privacy

- Everything is visible and editable in the manager; edits by the person get confidence 1 and source "user".
- **Forget** moves the file to `.trash/` (hidden, kept 30 days) and commits; **Undo** puts it back (and restores what it
  had superseded). Git keeps every version: the detail shows the history and can restore a version.
- **Export**: one JSON file with every fact and its raw markdown.
- Secrets never enter memory; sensitive facts wait for a yes.

## Contract changes

- Hook `turn.context` (plugin-sdk `HookName`, `HookPayloads`, `HookResults`; core `hooks.ts`):
  payload `{ sessionId, agentId, conversationId, taskId?, background, text, fromUser }`, result `{ context?: string }`.
  The runner puts the returned blocks before the turn's input (after the time and `[You now]` lines).
- UI SDK: `SlotContribution.inline?: boolean` for `chat.toolResult` — the renderer is shown in the chat without the
  details mode (a line meant for the person), and a message holding only such a call is not hidden.

## HTTP API (`/api/plugins/memory/http`, web port and device port)

Fact JSON (`FactView`):

```json
{
  "path": "you/lives-in-perm.md", "title": "Lives in Perm", "text": "The user moved …",
  "kind": "self", "about": ["Perm"], "slot": "home city", "tags": [],
  "importance": 4, "confidence": 0.9, "validFrom": "2026-10-20", "validUntil": "",
  "supersededBy": "", "supersedes": [], "scope": "team", "sensitive": false,
  "status": "active", "created": "…", "updated": "…",
  "source": { "agentId": "assistant", "conversationId": "c_1", "at": "…", "quote": "…" }
}
```
`source` is the latest provenance or null; `scope` is "team" or "agent:<id>".

| Route | Result |
|---|---|
| `GET /facts?q=&kind=&status=active\|archived\|all&limit=` | `{ facts: FactView[], review: n, counts: {kind: n} }` (ranked by relevance with `q`, else importance and recency) |
| `GET /fact?path=` | `{ fact: FactView & {sources: Source[]}, before: FactView[], history: [{rev, at, message}] }` |
| `PATCH /fact` `{path, text?, title?, kind?, importance?, validUntil?, scope?, about?}` | `{ fact }` |
| `POST /forget` `{path}` | `{ path, title }` (moved to trash) |
| `POST /restore` `{path}` | `{ fact }` (back from trash, superseded facts restored) |
| `POST /undo` `{path}` | undo of a remember: forget the fact, restore what it superseded |
| `GET /trash` | `{ facts: FactView[] }` (recently forgotten) |
| `GET /review` | `{ items }` (as before, items are FactView + `current`) |
| `POST /review/approve` / `POST /review/reject` `{path}` | as before |
| `GET /history?path=` / `POST /revert {path, rev}` | git versions of a fact / restore one |
| `POST /tidy` | `{ expired, merged, archived, reflection }` |
| `GET /export` | `{ exportedAt, facts: [FactView & {raw}] }` |

v1 routes (`/tree`, `/file`, `/search`) stay for compatibility.
Events: `ctx.ui.emit("changed", {path, action})` after every change.

## Interfaces

- **Web** (`/memory`, the plugin's UI module): "What the team knows about you" — groups You, People, Places,
  Preferences, Projects, Timeline, How-to, Notes; search on top; the review queue first when it has items; a fact
  opens inline with its source ("from your message in the chat with Ada, 29 Oct"), entities, dates, what it replaced
  and its history; edit in place; Forget leaves an "Forgotten · Undo" row. No dialogs.
- **Chat**: under an agent's message, "Remembered: <fact> · Undo"; sensitive ones "Remember this? · Yes · No".
- **Phone**: a Memory screen from the Hub tab with the same groups, search, review (approve / reject), swipe to forget
  with undo, and the fact's detail.

## Later

Local embeddings behind the `Embedder` seam; entity pages with summaries; per-person importance learned from what is
recalled and used; memory of the team about itself (each agent's own notes); conflicts shown side by side in review;
"why did you say that" — the memories a reply used, under the message.
