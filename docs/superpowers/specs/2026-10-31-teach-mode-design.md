# Teach mode: agents learn a task by watching the person in their browser

Approved by the person on 2026-10-31 (like Grok Bot's "teach a task"). The person shows a task in the agents'
browser (the live view, `plugins/browser`), talks while doing it and points at what matters; the agent turns the
demonstration into a skill and does the task by itself from then on, on request or on a schedule. Choices made:
the agents' own browser (not the person's Chrome, not the whole screen); voice while showing; learning also from
hints during a task and from any takeover; a skill of instructions the agent follows with understanding (a replay
"fast path" may come later on top of the same recording); consequential clicks approved ahead of time.

## How it feels

1. **Start in the chat.** "Смотри, как я заказываю воду на 5vodi.kz". The agent answers in a sentence and calls
   `browser_teach`: the live view pops up expanded with control already the person's, and a thin bar on top:
   "● Showing: ordering water · say what you do" — microphone, Highlight, Done, Cancel. A "Teach" item in the
   browser's ⋯ menu is the second way: it starts showing at once, and at Done the recording goes to the default
   agent's chat, which asks what it was for when that is not clear.
2. **Showing.** Clicks, typing and pages become steps in words ("clicked link «Каталог» → button «Вода 19 л» → typed
   «2» into «Количество»"). Speech is transcribed and lands between the steps where it was said. Passwords,
   one-time codes and card fields are never recorded ("typed the password").
3. **Highlight.** The Highlight button (any time the person is in control) turns the next drag into a frame: what is
   inside (its text, the controls) becomes a "look here" step with a crop of the picture and the words said near it.
   In the skill it becomes a check: "read «Итого» and compare with the amount", "report the status from «Доставка»".
4. **Done.** Control goes back to the agent and the recording arrives in its chat (a note and files in its
   workspace). The agent retells the steps in a few lines, asks only what is unclear (what changes each time), asks
   about every consequential step with quick replies ("Нажимать «Оформить заказ» без тебя, если сумма до 3 000 ₸?"),
   then saves the skill with `hub_skill_save`: an approval card "Save skill … · without asking: «Оформить заказ» on
   5vodi.kz up to 3 000 ₸". One tap saves the skill and its pre-approvals; nothing is saved without it, so text from
   a web page can never settle in a skill or a rule by itself.
5. **Later.** "Закажи воду": the agent loads the skill and does it. "Каждую пятницу": a trigger that runs the skill.
   Every agent of the team can use it.

## Learning without "let me show you"

- **Hints during a task.** Whenever the person takes control while an agent works in the browser (a captcha, a
  changed site, "покажи где"), what they did reaches the agent with its next browser result: "While you waited, the
  person did: 1) … 2) …". An agent following a taught skill offers to update it at the end (`hub_skill_save` with
  `replaces`: the same card). `browser_teach` with `scope: "step"` asks the person to show one step.
- **Free use.** Each takeover with no agent waiting is a session in the browser's journal (steps, no secrets, 30
  days, only on the hub). When a session ends, a cheap check without a model looks for the same routine before
  (same site, mostly the same controls in the same order: three sessions in all, or two on different days; offered
  at most once a week). A match tells the default agent in its chat (`conversations.tell`), which offers in one message with
  quick replies "Заметил, ты уже третий раз … Хочешь, буду делать сам?" — yes makes a skill from those sessions,
  no is remembered for that routine.
- **Control.** Browser setting "Remember what I do in the browser" (on by default) for free use; "забудь, что я
  делал в браузере сегодня" in the chat → `browser_journal forget`. No journal screen.

## Hub side

**Browser plugin**
- `server/recorder.ts` (pure): turns the live view's input and page events into steps: `click` (role, name, href,
  submit-like or not), `type` (field, value or `secret`), `key` (Enter, Escape…), `select`, `page` (landed on a
  title/URL), `tab`, `scroll` (merged), `highlight` (text, controls, crop file), `say` (speech). Mouse down+up on the
  same element is a click; text and keys in one field are one `type`. Markdown for the model, JSON for later.
- What is under the pointer comes from new page-script ops (`at`, `area`) run in our isolated world (as `probe`
  does): role and name exactly as `browser_snapshot` names them, so the skill's names match what the agent sees.
- `server/journal.ts`: recordings in `<dataDir>/journal/<id>.json` (+ crops), 30 days, at most 500; list, read,
  forget (one, a day, all); `findRepeats()` (pure) and dismissed routines.
- Manager: a teach session (goal, agent, conversation, task, scope) or a takeover session runs the recorder; Done /
  Cancel / highlight / speech come from the UI; a finished teach session writes `recording.md`, `recording.json`
  and crops into the agent's workspace (`files.deliver`) and wakes it (`conversations.tell`). A takeover ending
  while an agent used the browser in the last 10 minutes leaves the hint note for its next tool result.
- Tools: `browser_teach` {goal, scope: task|step} (returns at once; the recording arrives as a message),
  `browser_journal` {action: list|read|export|forget, id?, day?}; `browser_submit` takes `amount` (and `currency`):
  refused unless that amount is on the page.
- Voice: the UI records while teaching (AudioContext level → a segment ends after 0.8 s of silence or 20 s), posts
  each segment to the plugin's HTTP handler, which transcribes it (`speech.transcribe`) and places it by time. No
  speech-to-text set up: the mic stays off with a hint, the agent asks afterwards.
- `skills/teach-by-demo/SKILL.md`: how to start a demonstration, write a taught skill from a recording (goal,
  inputs that change, steps with exact names, checks from highlights, consequential steps), run one, and repair it.

**Core**
- Core methods `conversations.tell` {conversationId?, taskId?, text} (a note and a turn: the task is woken, else
  the dialog; default agent's dialog when none) and `speech.transcribe` {data, mimeType} / {check: true}.
- `hub_skill_save` {name, description, instructions, files?, allow?: [{site, label, maxAmount?, currency?}],
  replaces?}: its own approval card (never by words alone); on yes writes `<dataDir>/skills/<name>/SKILL.md`
  (frontmatter `taught: true`, `sites`), copies the files from the agent's workspace, reloads skills, adds the
  sites to known targets and one rule per `allow`: `browser_submit` with `url` domain, `label` (digits as `*`), and
  `amount` max (new rule op `max`), created via `"skill"`, note `skill:<name>`. `hub_skill_delete` removes a taught
  skill and its rules.
- Runs on a schedule: a trigger may name a `skill`; its tasks carry `skill` (new column). A background task whose
  skill is a taught one may click and type (local-write) though its agent only suggests (initiative 1); anything
  external still needs a rule (the pre-approvals) or a card.

**Live view (browser UI)**
- Teach bar on top (phone: under the address): dot, goal, mic (level ring; tap mutes), Highlight, Done, Cancel; the
  view expands itself when a teach session starts. Highlight mode draws a frame over the picture instead of sending
  input; the frame flashes when the hub has taken it. The Highlight button also shows while in control.

## Errors and limits

- Speech-to-text missing or failing: the bar says so once; the recording goes on without speech.
- A frame of another site (cross-origin iframe): "clicked inside an embedded frame of <site>".
- The person closes the view or leaves for 2 minutes during a teach session: the session ends as Cancel and the agent
  hears it was cancelled. A second `browser_teach` while one runs is refused.
- Skills are not run by a replayer: a changed site is handled by the agent, and its fix comes back as a skill update.
- Not on a CLI brain's remote machine: `files.deliver` only reaches workspaces on the hub; the note then carries the
  recording's text only.

## Tests

recorder (steps, merging, secrets, markdown), journal (prune, forget, findRepeats), page-script ops in a real page
(names match the snapshot's), manager teach flow (start → input → done → files + tell, cancel, hints in the next tool
result), `browser_submit` amount, policy `max` and the skill-run exception, `hub_skill_save` (card, files, rules,
replaces) and `hub_skill_delete`, core methods, i18n parity. Checked live on a throwaway hub.
