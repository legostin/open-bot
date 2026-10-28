# One link to connect a device

Approved 2026-10-28. Connecting a computer or a phone to the hub takes one ordinary `https` link: forward it to the
device (Telegram, mail, AirDrop) or press it right there, and the device asks "Connect?" once. It replaces the hub
address + code the user typed by hand (and got wrong: the phones' `:8443` address for a computer).

## Decisions

| Question | Choice |
|---|---|
| How the link reaches the device | Both: forwarded from the chat or a page, or opened on the device itself ("This computer"). |
| Handoff to the app | A small page on the hub (`/join/<code>`) opens the app through `owlbot://`. No Universal Links: every hub has its own `*.ts.net` domain, desktops have no equivalent, and the iPhone app would have to change. |
| Which devices | One invite for any device: a computer becomes a machine, an iPhone a phone. |
| Lifetime | One use, one hour. A phone gets full access to the chats, so a leaked link must expire soon. |
| No app yet | The hub hands out the installer: `/download/desktop/<os>` redirects to the GitHub release of the hub's own version. The repository becomes public; installers are built and attached by CI on a version tag. |
| Who sees the code | The person, never the model. The chat card makes the invite on a click, like the phone card did: an agent that read outside content cannot create an invite and send it away. |

## Invites (`packages/core/src/invites.ts`)

- Table `invites(code primary key, expires_at, used_at, used_by)`, a new migration. Code: 8 characters `[A-Z0-9]`, the
  format the phone already accepts, so `owlbot-ios` needs no change.
- `create() → { code, expiresAt }` (1 hour, audit `invite.create`), `consume(code, by)` marks it used in one
  `update … where used_at is null and expires_at > now` (one winner), `valid(code)`, `revoke(code)` (audit).
- `MachineHub.pair` and `DeviceRegistry.pair` consume invites; their `createPairingCode` now create invites. The old
  tables `pairing_codes` and `device_pairing_codes` stay in the schema, unused. A code from any screen pairs either kind
  of device.
- `invite.used` on the bus carries `{ code, kind, name }`; the card and the pages close on it.

## The address in the link

`machineHubUrl(publicUrl, link)` (pairing.ts): the Tailscale link while it is up, when the hub's own address is local;
otherwise `publicUrl`. `inviteUrl(hubUrl, code)` is `<hubUrl>/join/<code>`, or nothing when that address is local
(only this computer could open it). Without a link the card says other devices cannot reach the hub and offers access
from anywhere; the phone's QR still works on the home network.

## API (web session)

- `POST /api/invites` → `Invite { code, expiresAt, url?, appLink?, phoneLink?, qrSvg? }`:
  `url` the shareable `https://…/join/<code>`; `appLink` `owlbot://pair?hub=<hubUrl>&code=<code>` for "This computer";
  `phoneLink` the phone's `owlbot://pair?v=1&c=…&n=…&fp=…&u=…` while phones can reach the hub, and `qrSvg` of it.
- `DELETE /api/invites/:code` revokes it.
- `POST /api/machines/pairing-code` and `POST /api/devices/pairing` stay (CLI, older clients) and return invites.

## The page (`GET /join/:code`, public, also on the link's gateway)

Server-rendered, no script (`default-src 'none'`), `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, in the
browser's language. The User-Agent picks the variant:

- **Windows / macOS:** "Open Owlbot" → `owlbot://pair?hub=<the origin the page was opened at>&code=<code>` (that
  address demonstrably works from this computer). Below: "No app yet? Download for Windows / macOS" (the detected OS
  first), then a note on the unsigned installer (SmartScreen: More info → Run anyway; macOS: System Settings →
  Privacy & Security → Open Anyway), then "After installing, press Open Owlbot again".
- **Linux and servers:** the one command: `curl -fsSLo owlbot-node.mjs <origin>/download/owlbot-node.mjs && node
  owlbot-node.mjs pair <origin>/join/<code>` (shown on every desktop variant too, folded).
- **iPhone / iPad:** "Open in Owlbot" → the phone link. When phones cannot reach the hub, the page says so.
- **Android:** there is no Owlbot app for Android yet.
- **Used, expired or unknown code:** "This link has expired or was already used. Ask for a new one in the chat."
  Unknown codes count against the same per-address budget as failed pairings (10 per 15 minutes).

## Installers (`GET /download/desktop/:os`, public)

302 to `https://github.com/<OWLBOT_RELEASES_REPO, default legostin/open-bot>/releases/download/v<version>/<asset>`:
Windows `owlbot-setup-<version>-x64.exe`, macOS `owlbot-<version>.dmg` (universal). The version is the root
`package.json`'s, which `config.version` now reads. `.github/workflows/release.yml` (tag `v*`, the tag must equal that
version) builds both installers on clean runners, runs the existing install checks and attaches them to the release.
Before the repository goes public, its history is scanned for secrets.

## Where the link comes from

- **Chat:** `hub_connect_device` replaces `hub_machine_pairing_code` and `hub_device_pairing`. It shows the card (part
  `device_pairing`, kept so old messages render) and tells the model only that a card is shown.
- **Card / Machines / Devices:** one `InviteBlock`: "Get a link" → the link with Copy (and Share where the browser has
  it), the time left, the phone QR, "Open on this computer" when the page is not opened on the hub's own computer,
  "Cancel link". When a device joins: "Connected: <name>".

## The devices

- **Desktop app:** the manual form is one field, "Invite link" (an `https://…/join/<code>` or `owlbot://pair?…` link),
  plus the machine name; it parses hub and code and pairs as before. `owlbot://pair` links keep working.
- **Node CLI:** `owlbot-node pair <link>` takes the same link; `pair <hub> <code>` still works.
- **iPhone:** unchanged; it gets the same `owlbot://pair?v=1…` link it already handles.

## Errors

The machine's name comes from its hostname (rename on Machines). A used or expired invite: the hub answers 400 with
"the invite has expired or was already used", the app and the CLI show it. Revoking an invite while a device pairs: the
pair loses (the code is gone). The page never says whether a code ever existed beyond "expired or used".

## Testing

- `invites.test.ts`: one use, expiry, revoke, a race of two consumers.
- `join.test.ts` (hub in-process): each User-Agent variant, the origin in the app link, the expired page, the budget,
  `/download/desktop/*` redirects, no `Referer` leak headers.
- Pairing both kinds with one invite kind each (`devices.test.ts`, the node's `hub.integration.test.ts`).
- Web: `InviteBlock` states; the node's link parsing; the desktop UI's link parsing (unit), `cargo test` unchanged.
- Release workflow: `actionlint` where available; the first real tag is the user's call.
