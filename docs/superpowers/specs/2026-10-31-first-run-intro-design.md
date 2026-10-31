# First run: a brain first, then getting acquainted

2026-10-31. Decided with the user: on a new hub the person connects a brain before anything else; one working API key
(or any signed-in CLI) means the hub has a brain, and nothing asks for one again; then the assistant itself asks what
to call it, lets the person pick its look and proactivity, and asks who else to add to the team.

## What was wrong

`SetupGuide.usable()` walked the agent's brain list as written, and `api:*` (every API provider the hub has) is not a
brain the registry knows, so an agent on an API key counted as having no brain: the setup card came back at the end
of every dialog although the agent answered, and the greeting after the first brain never came.

## Rules

- **The hub has a brain** when any brain it lists works (any API provider with a key, a signed-in Claude Code or
  Codex here or on a connected machine). That is what `SetupState.usable` says, for every agent; the setup card shows
  only when it is false.
- **An agent whose own brains are not set up** thinks with the hub's working brains instead (fastest first) rather
  than holding the message for a setup card. A task pinned to a machine still runs there or not at all.
- **First run** is a hub that has not yet started talking with the person (`setup.kickoffDone` unset; every hub that
  was already used has it). `firstRun` comes with `/api/bootstrap`, so other hubs pay nothing for it.

## What the person sees

1. **No brain yet, first run.** After the password, the app (web, desktop, the phone page) shows only the assistant:
   its avatar, a greeting line ("first connect a brain for me") and the setup card (sign in to Claude Code or Codex,
   or an API key). No sidebar, composer, header pills.
2. **A brain works.** The normal app opens on the assistant's dialog. The dialog is empty, so the page asks the hub to
   start the intro (`POST /api/setup/intro`, once: it sets `kickoffDone` and `intro`), and the assistant speaks first.
   The same happens on a hub that worked from the start (Claude Code already signed in on the Mac): the intro starts
   the first time the assistant's dialog is opened.
3. **Getting acquainted**, one question per message, led by two new setup steps at the front of the list:
   - `identity`: "What should I be called?" with 3–4 names as quick replies; `profile_update` saves the name; then
     `profile_show` puts a live card of its profile in the chat (avatar shape and colour pickers, proactivity), saved
     on tap; then, if the person wants, how it talks (address, length, character) into its instructions.
   - `team`: "Who else should join the team?" with quick replies of roles that would help (and "nobody for now");
     each one is put together with the existing `hub_agent_draft` card.
   After these the rest of the setup (Telegram, a backup brain, other computers, getting to know the person) is
   offered as before, only after the person agrees.
4. If the person wrote before a brain worked (another channel), that message is answered first and the intro steps
   follow from the setup section of the prompt.

`identity` and `team` exist only on hubs that went through this intro (`setup.intro`); hubs set up earlier never see
them.
