# Attachments: files, photos and voice messages to the agent

2026-10-27. The user's goal for this round: add what a person needs first. Today an agent cannot get a single file from
its user: the web composer takes text only and the Telegram bot answers anything but text with "text only". Sending a
photo of a receipt, a screenshot, a PDF or a voice note is the most ordinary thing to do with a personal assistant, so it
comes first. The message part `attachment` already exists and the web already renders it; nothing creates it.

Voice transcription is the next step (its own spec). Here a voice note arrives as an audio file the agent can see.

## Where the files live

- An attachment is saved in the conversation's workspace: `<data>/workspaces/<agentId>/<taskId or conversationId>/attachments/<name>`
  (for a group, the lead's). That is the folder the conversation's own brain session already works in, so Claude Code,
  Codex and the API loop open the file without any copying, and `/api/files` already serves it to the web.
- `<name>` is the original name made safe: no path separators, control characters or leading dots, at most 120
  characters, the extension kept; a taken name gets ` (2)`, ` (3)`… before the extension. Files without a name (Telegram
  photos, voice notes) get `photo-YYYYMMDD-HHMMSS.jpg`, `voice-YYYYMMDD-HHMMSS.ogg` and so on.
- The part gains an optional `size` (bytes): `{ type: "attachment", path, name, mimeType?, size? }`. `path` stays
  relative to the workspaces root.
- Limits: 25 MB per file and 10 files per message from the web; Telegram's Bot API hands bots files up to 20 MB, so
  larger ones get a polite refusal from the bot.

## The core (`packages/core/src/attachments.ts`)

- `safeName`, `uniqueName`, `mimeOf(name, given?)`, `formatSize`.
- `saveAttachment(root, conv, { name?, mimeType?, data, kind? })` writes the file and returns the part.
- `attachmentFromPath(root, conv, path)` checks that a path the web sends belongs to this conversation's
  `attachments/` folder and exists; anything else is refused (the web cannot point the agent at other files).
- `forSession(parts, root, workspace)` gives the brain its view: paths relative to the session's workspace, copying a
  file into `<workspace>/attachments/` when the session works elsewhere (a group member other than the lead).
- `attachmentNote(files, { remote })` is the English line appended to the prompt:

  ```
  [The user attached 2 files, saved in your working folder:
  - attachments/receipt.jpg (image/jpeg, 1.2 MB)
  - attachments/voice-20261027-091500.ogg (audio/ogg, 48 KB, voice message 0:12)
  Open them with your file tools when the request needs them.]
  ```

  A brain on another machine (`<brain>@<machine>`) cannot reach the hub's disk: its note says the files are on the hub
  and names them, and no paths go into the turn.

## The runner

- `userMessage(conversationId, text, { channel, attachments })`: the stored user message has the text part (when there
  is text) and one `attachment` part per file. A message may be files only.
- The attachments travel with the turn (`TurnOpts.attachments`, the setup guide's held messages, group rounds). Once
  `turn()` has the session, it adds the note to the text and passes `BrainTurn.attachments` (workspace-relative), which
  the API loop already turns into image parts for vision models. Claude Code and Codex read the files with their own
  tools.
- A mirrored web message (the quote under a reply in Telegram) names the files: `📎 receipt.jpg`.

## The hub API

- `POST /api/conversations/:id/attachments?name=<file name>` with the raw bytes (`application/octet-stream`, up to
  25 MB) saves one file and returns the part. Same auth, origin and CSRF checks as every other changing request.
- `POST /api/conversations/:id/messages` takes `{ text, attachments?: string[] }` (paths from the upload); text may be
  empty when there are attachments.
- `channels.inbound` (plugin RPC) takes `files?: { name?, mimeType?, data (base64), kind?, durationSec? }[]` next to
  `text`; the hub saves them and checks the same limits. A 20 MB file is a 27 MB NDJSON line in base64; the transport
  takes a 30 MB line in under a second (`packages/shared/test/rpc.test.ts`).

## The web

- A paperclip button in the composer opens the file picker (several files). Pasting files or screenshots and dropping
  files on the chat add them too; while dragging, the chat shows a drop overlay.
- Each file uploads at once and shows as a chip above the text: a thumbnail for pictures, the name and size, a spinner
  while uploading, a remove button. Send works with text, files or both, and waits for uploads to finish.
- Sent attachments render as today (image preview or file chip), with the size.

## Telegram

- Accepted: photos (the largest size), documents, voice notes, audio, video, round video notes and animations; the
  caption is the text. Locations and venues become text (`[Location: 43.2389, 76.8897]`) so "what is near me" works.
- An album (`media_group_id`) arrives as several updates: the bot collects them for 1.5 s and sends one message.
- The bot downloads with `getFile` (through the hub's egress proxy, as all its traffic) and passes the files inline.
- Too large: "This file is over 20 MB, Telegram does not let bots download it. Send it in the web chat." Stickers,
  polls, contacts: "I can read text, photos, files and voice messages." (replaces "text only").
- Context the agent would otherwise miss: a forwarded message starts with `[Forwarded from <name>]`, a reply to an
  earlier message starts with `[In reply to: "<first 300 characters>"]`.

## The current time on every turn

Found on the way and fixed with this work, because reminders depend on it: the system prompt states the local time
when the brain session opens, and an agent's main dialog keeps its session for days (resume). A day later "remind me in
two hours" is computed from yesterday's clock.

- The runner puts `[Now: Tuesday, 27 October 2026, 09:15 (Asia/Almaty)]` before a turn's text when the session has had
  no such line for 10 minutes (or never, e.g. after a hub restart). The system prompt says that the latest `[Now: …]`
  line is the current time.
- The system prompt's own time is formatted in English (`en-GB`), like all text for the model (it was `ru-RU`).

## Errors

- Upload too large → 413 with `attachment.tooLarge`; too many files → 400 `attachment.tooMany`; a path that is not this
  conversation's attachment → 400 `attachment.invalid`. All texts in the catalogs (en, ru).
- A file the brain cannot read (deleted meanwhile) is named in the note as missing; the turn goes on.

## Testing

- Unit: names, uniqueness, path checks, session view and copying, the note (local and remote), the NDJSON transport
  with a large line in small chunks, the time line (first turn, within 10 minutes, after 10 minutes).
- Hub: upload → message with attachments → the fake brain receives the note and the workspace-relative paths;
  files-only messages; refusals (size, count, foreign path).
- Telegram (mock Bot API): a photo with a caption, an album of three, a voice note, a 25 MB document refused, a
  location as text.
- Web: the composer's chip state (pure functions in `lib/attachments.ts`) and i18n parity.
