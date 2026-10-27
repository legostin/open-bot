# Integrations library and Google Calendar

2026-10-27. Decided with the user: an integrations library (a page of cards), Google first, Owlbot's own OAuth client
built in, the agent reads and writes the calendar, the morning digest shows the day's events. The phone's calendar
(the iOS app) comes next as another integration in the same library.

## The library

- A new panel section **Integrations** (group "Connections", first in it): cards with an icon, the name, one line of
  description, a status and one button.
- An integration is a built-in plugin with an `integration` block in its manifest:

  ```json
  "integration": { "category": "calendar", "icon": "calendar", "connect": "google", "scopes": ["…"], "summary": "%integration.summary%" }
  ```

  `connect`: `google` (the hub's Google sign-in), `setup` (the plugin's setup card: secrets and its own steps, as
  Telegram has today) or `none` (works as it is). `icon` is a lucide icon name.
- Cards from the start: Google Calendar (`google`), Telegram (`setup`), Web search (`setup`, every key optional),
  Browser (`none`).
- Status: `connected` (with the account, e.g. anna@gmail.com), `needs-setup`, `off` (the plugin is disabled),
  `unavailable` (Google without a client in this build). The button: Connect, Set up, Turn on, Disconnect.
- `GET /api/integrations` lists them; `POST /api/integrations/:id/enabled` turns the plugin on or off.
- In the chat: hub tools `integrations_list` and `integration_connect({ id })`; the latter adds a message part
  `{ type: "integration", id }`, the same card live in the chat (a `setup` one embeds the plugin's setup card).

## Connections: Google sign-in in the core

`packages/core/src/connections.ts`, one account per provider for now.

- Provider `google`: endpoints (auth, token, revoke, userinfo) and the client from `OWLBOT_GOOGLE_CLIENT_ID` /
  `OWLBOT_GOOGLE_CLIENT_SECRET`, defaulting to the client built into the code (an installed-app client: Google
  treats its secret as public). Empty → integrations that need Google are `unavailable`.
- Start: `POST /api/connections/google/start { integration }` → `{ url }`. Authorization code flow with PKCE (S256),
  `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, the scopes of every enabled integration
  that uses Google plus `openid email`. `state` is random, single use, ten minutes.
- Return: Google sends the browser to `http://127.0.0.1:<hub port>/oauth/callback` (a Desktop client accepts any
  loopback port). The public route checks `state`, exchanges the code, reads the email, and answers with a small
  page ("Google is connected, you can close this tab") that also links back to the hub.
- A hub elsewhere (a VPS) or a phone: the return page does not open. The card then asks for the address from the
  browser's address bar; `POST /api/connections/google/complete { url }` takes the code from it the same way.
- The refresh token goes to the vault (`google_refresh_token`, a secret no plugin is granted), so the vault must be
  created and unlocked: the card says so and offers the vault's own form. The account (email, scopes, when) is kept
  in the settings key `connections`.
- Plugins: core method `connections.token({ provider: "google" })` → `{ accessToken, expiresAt, account }`, for a
  plugin whose manifest has `integration.connect = "google"` and `connections.token` in `permissions.core`. Access
  tokens are cached in memory and refreshed a minute before they expire. A refused refresh (`invalid_grant`: the user
  revoked access) marks the connection broken: the card shows Reconnect, the tool says so.
- Disconnect: `DELETE /api/connections/google` revokes the token at Google, removes it from the vault and the record.
- Events `connections.updated` refresh the cards live; the agent hears "[System] Google is connected" in the chat
  the card was in.

## Google Calendar plugin (`plugins/google-calendar`)

Tools (prefix `calendar`), times in the user's timezone, dates as local `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`:

| Tool | Effect | What |
|---|---|---|
| `calendar_calendars` | read | the user's calendars: id, name, primary, access |
| `calendar_events` | read | events from `from` to `to` (default: today), optional `calendar`, `query` |
| `calendar_free_busy` | read | busy intervals in a period, for finding a free slot |
| `calendar_create_event` | external | title, start, end (or all-day date), location, description, attendees |
| `calendar_update_event` | external | id and the fields to change |
| `calendar_delete_event` | external | id |

- External tools go through the usual approval card ("Create the event “Dentist” on Tue 28 Oct, 10:00–11:00").
- Calls `https://www.googleapis.com/calendar/v3` (setting `apiBaseUrl` for tests) with the token from the core.
- Scopes: `calendar.events`, `calendar.readonly`.
- Not connected: the tool answers "Google Calendar is not connected; call hub_integration_connect with id
  google-calendar to show the user the Connect card."

## The digest

A new hook `digest.compose` (`{ date, time, timezone }` → `{ title, body }`): at each digest time the notifier asks
plugins for sections and sends the digest with them even when no other items wait. Google Calendar answers in the
morning (before 12:00) with today's events and later with tomorrow's; no events, no section. Items and sections
keep their line breaks (sections are not squeezed into one line like items).

## Errors

All user-facing text through the catalogs (core, web, the plugin's locales); tool results and notes for the model
in English. Network failures and Google's errors reach the tool result as `Google Calendar: <message>`.

## Testing

- Unit: PKCE and state, the callback URL parser, local time ↔ RFC 3339 with the timezone, event formatting.
- Hub with a fake Google (auth, token, userinfo, revoke, Calendar API): start → callback → token in the vault and
  the account listed; refresh on expiry; `invalid_grant` → broken; disconnect revokes; the integrations list and
  statuses; the plugin's tools (events, create through approval); the digest section.
- Web: the cards' state helpers and i18n parity.

## Before it works for real

The Google Cloud client is created once by the project's owner (it needs a Google account): a project, the Google
Calendar API enabled, the consent screen (External, In production), an OAuth client of type Desktop app. Its ID and
secret go into the code (or the two variables). Until Google verifies the calendar scopes, sign-in shows an
"unverified app" warning and at most 100 users can connect.
