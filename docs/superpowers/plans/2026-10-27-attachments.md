# Attachments and Time-Aware Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can send files, photos and voice notes to an agent from the web chat and Telegram, and every turn
carries the current time.

**Architecture:** Files are saved in the conversation's workspace (`attachments/`), stored as `attachment` message
parts and handed to the brain as workspace-relative paths plus an English note. A new core module
(`attachments.ts`) owns names, paths and the note; the runner carries attachments through every turn path; the web
uploads raw bytes first and sends the paths with the message; Telegram downloads with `getFile` and passes base64.

**Tech Stack:** Node 24 TypeScript (type stripping), Fastify, React 19, vitest, Telegram Bot API.

## Global Constraints

- Imports of local files end in `.ts`; only erasable syntax; `import type` for types.
- Every user-facing string goes through the catalogs (core `packages/core/src/locales/{en,ru}.ts`, web
  `packages/web/src/i18n/{en,ru}.ts`, Telegram `plugins/telegram/.owlbot-plugin/locales/{en,ru}.json`); parity is tested.
- Text for the model (notes, tool text) is English and not translated.
- Limits: 25 MB per file and 10 files per message (web); 20 MB per file (Telegram `getFile`).
- Attachments live in `<data>/workspaces/<agentId>/<taskId or conversationId>/attachments/`; part paths are relative
  to `<data>/workspaces`.

---

### Task 1: Linear NDJSON framing

**Files:** Modify `packages/shared/src/rpc.ts` (`ndjsonTransport`); Test `packages/shared/test/rpc.test.ts` (create
if missing, else add a case).

- [ ] Test: feed a 30 MB line in 64 KB chunks through a `PassThrough`, expect one message equal to the line, in under
  2 s; and two lines in one chunk still arrive as two messages.
- [ ] Implement: remember where the last scan stopped.

```ts
input.on("data", (chunk: string) => {
  let from = buffer.length;
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n", from)) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    from = 0;
    if (line) for (const cb of messageCbs) cb(line);
  }
});
```

- [ ] Run `npx vitest run packages/shared`, commit "RPC: NDJSON framing scans only the new data".

### Task 2: Core attachments module

**Files:** Create `packages/core/src/attachments.ts`; Test `packages/core/test/attachments.test.ts`; Modify
`packages/shared/src/types.ts` (attachment part gains `size?: number`, `kind?: "voice" | "audio" | "video" | "photo" | "file"`,
`durationSec?: number`).

**Produces:**

```ts
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export type AttachmentPart = Extract<MessagePart, { type: "attachment" }>;
export interface IncomingFile { name?: string; mimeType?: string; data: Buffer; kind?: AttachmentPart["kind"]; durationSec?: number }
export function attachmentsDir(root: string, conv: { agentId: string; taskId?: string; id: string }): string; // abs
export function mimeOf(name: string, given?: string): string;            // given if it looks like a type, else by extension, else application/octet-stream
export function defaultName(kind: AttachmentPart["kind"], mimeType: string, now?: Date): string; // photo-20261027-091500.jpg
export function saveAttachment(root: string, conv: {...}, f: IncomingFile, now?: Date): AttachmentPart;
export function attachmentFromPath(root: string, conv: {...}, path: string): AttachmentPart | undefined; // only <conv dir>/attachments/<plain name>, existing file
export function forSession(parts: AttachmentPart[], root: string, workspace: string): { paths: string[]; missing: string[] }; // copies into <workspace>/attachments when outside
export function attachmentNote(parts: AttachmentPart[], view: { paths?: string[]; missing?: string[]; remote?: boolean }): string;
export function formatSize(bytes: number): string; // "48 KB", "1.2 MB"
```

- Names reuse `safeFileName` from `core-call.ts` (move it to `attachments.ts` and re-export from `core-call.ts`);
  uniqueness: `name (2).ext`, `name (3).ext`… Name capped at 120 characters before the extension.
- Note (local):

```
[The user attached 2 files, saved in your working folder:
- attachments/receipt.jpg (image/jpeg, 1.2 MB)
- attachments/voice-20261027-091500.ogg (audio/ogg, 48 KB, voice message 0:12)
Open them with your file tools when the request needs them.]
```

  One file: "[The user attached a file, saved in your working folder: …]". Remote: "[The user attached N files.
  They are stored on the hub, not on this machine: receipt.jpg (image/jpeg, 1.2 MB); …]". Missing files:
  "- attachments/x.pdf (no longer available)".
- [ ] Tests: names (separators, dots, long, Cyrillic kept), uniqueness, mime, default names, `attachmentFromPath`
  refuses `../`, other conversations, nested paths, missing files; `forSession` copies for another workspace and not
  for the same one; notes (one, several, voice, remote, missing).
- [ ] Implement, run `npx vitest run packages/core/test/attachments.test.ts`, typecheck, commit.

### Task 3: The current time on every turn

**Files:** Modify `packages/core/src/prompt.ts` (format `en-GB`, rule line), `packages/core/src/runner.ts`
(`timeLine` before `streamTurn`); Create `packages/core/src/clock.ts`; Test `packages/core/test/clock.test.ts`; adjust
`packages/core/test/fixtures/plugins/fakebrain/server/index.ts` (ECHO? ignores `[Now:` lines).

**Produces:** `export function nowLine(timezone: string, at?: Date): string` → `[Now: Tuesday, 27 October 2026, 09:15 (Asia/Almaty)]`;
`export class TurnClock { line(sessionId: string, timezone: string, at?: Date): string | undefined }` — a line when
the session had none for 10 minutes; `forget(sessionId)`.

- System prompt: `Current local time when this session started: … The latest [Now: …] line before a message is the current time.`
- Runner: `text = [clock.line(row.id, tz), text].filter(Boolean).join("\n")` right before `streamTurn`; `closeLive` forgets.
- [ ] Tests for `TurnClock` (first, within 10 min → undefined, after 10 min → line) and `nowLine` format; run the
  whole core suite (group tests read `[` lines).
- [ ] Commit "Every turn knows the current time".

### Task 4: Attachments through the hub

**Files:** Modify `packages/core/src/runner.ts`, `packages/core/src/setup.ts` (held messages carry attachments),
`packages/core/src/core-call.ts` (`channels.inbound` files), `packages/core/src/server/main-app.ts` (upload route,
message route), `packages/core/src/locales/{en,ru}.ts`, `packages/core/src/channels.ts` (mirror quote names files);
Test `packages/core/test/attachments-hub.test.ts`; fakebrain gains `ATTACH?` (echoes `turn.attachments` and the note).

- `userMessage(conversationId, text, { channel, attachments?: AttachmentPart[] })`: parts = text (if any) +
  attachments; `TurnOpts.attachments`; group rounds pass them to each member; `setup.hold(…, { attachments })`.
- `turn()`: after the session is known, `view = remote ? {remote:true} : forSession(parts, root, workspacePath(row))`;
  text += `\n\n${attachmentNote(...)}`; `streamTurn(..., attachments: view.paths)` → `live.handle.send({ text, attachments })`.
- Routes: `POST /api/conversations/:id/attachments?name=` (`application/octet-stream`, route `bodyLimit` 25 MB +
  slack, raw buffer parser registered for that type), returns the part. `POST /api/conversations/:id/messages`
  accepts `attachments: string[]` (≤10, each via `attachmentFromPath` or 400 `attachment.invalid`), text may be empty
  then.
- `channels.inbound`: `files?: Array<{ name?, mimeType?, data: string /*base64*/, kind?, durationSec? }>`; each
  ≤ 25 MB, ≤ 10; empty text with files is not ignored.
- Mirror: a web message's quote in channels is its text plus `📎 name` per file.
- Locales: `attachment.tooLarge` ("The file is larger than {max}."), `attachment.tooMany` ("At most {max} files per
  message."), `attachment.invalid` ("This attachment does not belong to the conversation."), `message.empty` stays.
- [ ] Hub tests: upload + message → stored parts, fake brain sees note + workspace paths; files-only; group member
  gets a copy; Telegram-style inbound with base64; refusals.
- [ ] Run core suite + typecheck, commit.

### Task 5: Web composer

**Files:** Modify `packages/web/src/lib/api.ts` (`upload(path, blob)`), `packages/web/src/state/app.ts`
(`sendMessage(conversationId, text, attachments?)`), `packages/web/src/pages/chat/Composer.tsx`,
`packages/web/src/pages/chat/ChatView.tsx` (drop overlay), `packages/web/src/pages/chat/MessageView.tsx` (size);
Create `packages/web/src/lib/attachments.ts` + `.test.ts`, `packages/web/src/pages/chat/AttachmentChips.tsx`;
i18n `composer.attach`, `composer.dropHere`, `composer.uploading`, `composer.removeFile`, `composer.tooLarge`,
`composer.tooMany`.

- `lib/attachments.ts`: `type Pending = { id; file: File; status: "uploading" | "ready" | "error"; part?; error?; preview? }`,
  `addFiles(list, files, max)`, `readyPaths(list)`, `canSend(text, list)`, `formatBytes`.
- Composer: paperclip button (hidden `<input type=file multiple>`), `onPaste` with `clipboardData.files`, chips above
  the textarea, send enabled when text or ready files and nothing uploading; drafts keep files per conversation while
  the page lives.
- ChatView: `dragenter/over/leave/drop` on the chat column → overlay "Drop files to send" → hands files to the
  composer through a small store (`pendingFiles` map keyed by conversation).
- [ ] Unit tests for `lib/attachments.ts`; `npm run build -w packages/web`; i18n parity test; commit.

### Task 6: Telegram media in

**Files:** Modify `plugins/telegram/server/bot.ts`, `plugins/telegram/server/api.ts` (`getFile`, `download`),
`plugins/telegram/.owlbot-plugin/locales/{en,ru}.json` (`bot.unsupported`, `bot.fileTooLarge`, `bot.downloadFailed`;
`bot.textOnly` removed), `plugins/telegram/test/mock-telegram.ts` (`getFile`, `/file/bot<token>/<path>`, `addFile`),
`plugins/telegram/test/telegram.test.ts`.

- `onOwner`: commands only for text; otherwise `inboundOf(m)` → `{ text, files }`: photo (largest), document, voice
  (`kind: "voice"`, `durationSec`), audio, video, video_note, animation; caption → text; location/venue → text line;
  `forward_origin` → `[Forwarded from …]`; `reply_to_message` → `[In reply to: "…"]`. Size > 20 MB → `bot.fileTooLarge`.
- Albums: `media_group_id` buffers for 1.5 s (timer reset on each part), then one `channels.inbound`.
- [ ] Tests: photo with caption, album of three → one inbound with three files, voice → kind voice, too-large
  document refused, sticker → unsupported, location → text, reply/forward context.
- [ ] Run plugin tests, commit.

### Task 7: Docs and verification

- [ ] READMEs (en, ru): sending files, photos and voice notes; the time line is internal (no doc).
- [ ] `npm run typecheck`, `npx vitest run`, `npm run build`; live check: start a hub on spare ports, upload in the
  web UI with the browser pane, see the note reach a brain (fake or real), screenshot.
