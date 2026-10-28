# Voice messages: the hub transcribes them

2026-10-27, the step after attachments (`2026-10-27-attachments-design.md`). Voice notes are how many people talk to a
phone assistant, and they now reach the agent as audio files — which no brain can listen to: Claude Code, Codex and
the API loop all read text and images. The hub turns speech into text before the agent's turn.

## Engine

An OpenAI-compatible `POST <base>/audio/transcriptions` (multipart: `file`, `model`; JSON answer `{ text }`). One
protocol covers the hosted services and the local ones:

| Provider | Base URL | Default model | Key (vault) |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini-transcribe` | `openai_api_key` |
| `groq` (free tier) | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | `groq_api_key` |
| `custom` (speaches, LocalAI, a whisper.cpp server…) | the user's | the user's | optional `vault://` reference |

- Hub setting `transcription`: `{ provider: "auto" | "openai" | "groq" | "custom" | "off", model?, baseUrl?, keyRef? }`.
  `auto` (the default) uses OpenAI when the vault holds `openai_api_key`, else Groq when it holds `groq_api_key`,
  else nothing. A sealed vault means no key.
- The upload's file name carries an extension the services accept (`ogg`, `mp3`, `m4a`, `wav`, `webm`, `flac`, `mp4`):
  Telegram's `.oga` goes as `.ogg`. Files over 25 MB (the services' limit) are not sent.
- The hub calls the service itself (keys never leave the core), with a 120 s timeout.

## When it runs

- A user message with audio attachments of kind `voice` or `audio`: the runner transcribes them in the
  conversation's queue, before the agent's turn, so the turn waits for the words and later messages wait for it.
- The transcript is stored on the part (`attachment.transcript`), the web shows it under the voice note, and the note
  for the model carries it: `- attachments/voice-….ogg (audio/ogg, 47 KB, voice message 0:12), transcript: "…"`.
- Failure (network, a bad key, a rate limit) keeps the voice note without words: the note says
  `could not transcribe it: <reason>`, and the agent can retry with the tool below.
- Nothing set up: the note says `no speech-to-text is set up` and the system prompt's rule tells the agent to offer it:
  a Groq key (free) or an OpenAI key through the secure secret card (`secret_request` with the vault ids above),
  then to call `transcribe_audio` on the waiting voice note.

## The tool

`transcribe_audio({ path })` (read): any audio file in the agent's workspace (an attachment, a download), the same
engine, the text back. The agent uses it after the setup, for older voice notes, or for audio it fetched itself.

## Errors and limits

- Messages to the user are the agent's; the hub's notes and tool results are English text for the model.
- Only `voice` and `audio` attachments are transcribed automatically (not videos), at most 10 minutes of audio
  (by duration when known) per file.

## Testing

- Unit: provider choice (auto with and without keys, explicit, off), upload names, the note with a transcript,
  failure text.
- Hub: a fake OpenAI-compatible server; a channel voice note → the transcript is on the stored part and in the fake
  brain's note; no provider → the hint; a failing server → the failure line; `transcribe_audio` through MCP.
- Web: the transcript under a voice note (MessageView).
