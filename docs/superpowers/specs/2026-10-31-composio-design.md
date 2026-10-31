# Composio: outside services through one integration, with a badge that says so

2026-10-31. Decided with the user: services that do not let Owlbot register its own sign-in (Slack, GitHub, Google
without our own client, HubSpot, Dropbox, Box…) connect through [Composio](https://composio.dev), a hosted service
with its own OAuth apps for ~1000 apps. Composio holds the account tokens and sees every call, so everything that goes
through it carries a **Composio** badge; tapping it says what that means. Native sign-ins (Notion, Linear, Granola, the
MCP servers with open registration) stay as they are and are preferred where they exist.

## What the person sees

- **Catalog.** Ready cards in their situations: Slack, GitHub, HubSpot, Google Drive, Docs, Sheets, Calendar, Meet,
  OneDrive, Dropbox, Box, Trello, Jira, Zoom, Calendly, Figma, Salesforce (work); Gmail, Outlook, Microsoft Teams,
  LinkedIn (communication); Google Tasks (everyday); YouTube, Reddit (reading). Only apps Composio signs in to with
  its own OAuth app: not Discord (see the plugin below), Spotify, X or Shopify (they need the person's own client). They look like any other card, with a small
  **Composio** badge next to the name. Apps an agent connects from the chat show up the same way, with the badge.
  One more card, **Composio**, holds the key (group "other").
- **The badge** opens a short note (a popover on the web, a sheet on iOS):

  > **Composio is an outside service.** Signing in to Slack and every request to it go through Composio's cloud: the
  > account's keys are kept there, not on your hub, and Composio sees what the agent reads and sends. It needs your
  > own Composio account (free up to 100,000 calls a month). [composio.dev]

  The badge is everywhere the card is: the catalog, the entry's page, the card in the chat; web, desktop and iOS
  (the iOS app draws no integration cards in the chat yet, for any integration: there the badge is in the catalog).
- **Connecting, chat first.** "Connect Slack" (or Connect in the catalog, which opens the chat with that request):
  1. No Composio key yet: the agent shows Slack's card with the key field and where to get it (composio.dev →
     Settings → API keys); the key goes straight to the vault.
  2. Then the same card has **Sign in**: it opens Composio's page where the person allows access to Slack. This works
     from a phone too: the hub checks for the finished sign-in itself, nothing has to come back to localhost.
  3. The card turns Connected and the agent carries on with what was asked.
- **Any other app.** "Connect Trello through Composio": the agent finds it among Composio's apps, adds it to the
  catalog and shows the same sign-in card.
- **Sign out** on the card removes the connection at Composio too; an app added from the chat also leaves the catalog.

## The core: generic, nothing about Composio

Two general abilities, for any integration of this kind.

### A plugin with several catalog entries

- `integration.entries` in the manifest (`packages/shared/src/manifest.ts`): entries known ahead
  (`id`, `name`, `summary`, `category`, `icon`, `example`, `popular`; text as `"%key%"`). They show even while the
  plugin is off (status `off`).
- The running plugin reports its entries' state, and entries it added, with `ctx.catalog.update(entries)`
  (`packages/plugin-sdk/src/types.ts`, `runner.ts`, request `catalog.update`). Each state: `status`
  (`connected` | `needs-setup` | `broken`), `connect` (`setup` while the plugin's own secrets are missing, else
  `signin`), `account`, `detail`. The core keeps the last report while the plugin runs; the plugin keeps its added
  entries in its own storage and reports them again when it starts. While the plugin is off only the manifest's
  entries show.
- In the catalog an entry's id is `<pluginId>:<entryId>` (`composio:slack`). `listIntegrations` expands such a
  plugin into its own card (if it has an `integration` block of its own) plus one view per entry. Every place that
  takes an integration id takes it: `hub_integrations_list`, `hub_integration_connect`, the chat card
  `{ type: "integration", id }`, `/api/integrations/:id/...`.
- Turning an entry on (`POST /api/integrations/:id/enabled`) turns its plugin on. An entry has no switch of its own:
  its state is whether it is connected.

### The "through an outside service" badge

- `integration.via` in the manifest: `{ name, about, link }` (`about` is a `"%key%"` of the plugin's own locales,
  with `{name}` for the entry's name). Every entry of the plugin gets it, and so does its own card unless that card
  is the service itself (the Composio card has no Composio badge).
- `IntegrationView.via?: { name: string; about: string; link?: string }` (`packages/shared/src/types.ts`), localized
  for the reader. The web and iOS draw the badge and its note from it; the text lives in the plugin's catalogs.

### Sign-in through the plugin

- Entries use the existing `connect: "signin"` and the same **Sign in** button (`ServiceSignIn` on the web, its
  counterpart on iOS).
- `POST /api/integrations/:id/signin` for an entry asks the plugin (core → plugin request `catalog.signin` with the
  entry id; the plugin answers `{ url }`). `DELETE` sends `catalog.signout`. The plugin side:
  `ctx.catalog.onSignIn(handler)` / `onSignOut(handler)`.
- The core remembers the conversation the sign-in came from. When the plugin later reports the entry `connected`,
  the core emits `connections.updated` and tells that conversation's agent, as it does after an MCP sign-in.
- Entries need no pasted way back (`IntegrationView.signinReturn: false`): the card hides that step.

## The plugin: `integrations/composio`

- **Key**: one setup secret, vault item `composio` (`x-api-key`). `permissions.network: ["backend.composio.dev"]`.
  API v3.1. The whole hub is one Composio user, id `owlbot-<hub id>`, kept in plugin storage.
- **Sign-in**:
  1. The first time an app connects the plugin creates an auth config with Composio's own OAuth app
     (`POST /auth_configs`, `use_composio_managed_auth`) and stores its id.
  2. It creates a link (`POST /connected_accounts/link`) and returns `redirect_url`.
  3. It polls the connected account (`GET /connected_accounts/:id`) every few seconds until `ACTIVE` or until the
     link expires; then reports the entry `connected` and registers its tools.
  4. Sign out deletes the connected account at Composio; an entry added from the chat is dropped.
- **Tools** (prefix `composio`):
  - Each connected app's main tools (Composio's `important`, at most 30 per app) as their own tools:
    `composio_slack_send_message`, `composio_github_list_issues`… Names are cut to 64 characters (with a short hash
    when cut). The tool's version is pinned at registration and sent with each call.
  - `composio_apps_search({ query })` (read): apps among Composio's toolkits, and whether Composio can sign in to them
    itself.
  - `composio_app_add({ app })` (local-write): adds the app to the catalog as `composio:<slug>`; then
    `hub_integration_connect`.
  - `composio_tools_search({ app, query })` (read): a connected app's other tools.
  - `composio_tool_run({ tool, arguments })` (external, always asks): runs one of those by slug; the approval card
    names it.
- **Safety**:
  - Only tools tagged `readOnlyHint` are `read`. Everything else, untagged too, is `external`: the approval cards ask
    as they do today. Composio tags on a best-effort basis, so the default is "it writes".
  - Every tool is `source: true`: the result came from outside, so later writes ask after it.
  - The approval card reads "Slack: Send message — channel: {channel}, text: {text}" (the tool's fields, required
    first, at most five; the action's name is Composio's, in English); composio_tool_run's card names the tool and
    its arguments, and "always allow" on it covers that one tool only.
  - A read needs `readOnlyHint` and none of `createHint`, `updateHint`, `destructiveHint`.
- **Storage**: the Composio user id, auth config and connected account ids per app, a sign-in in progress (picked up
  again after a restart), entries added from the chat. Composio keeps no account the hub stops waiting for: one a
  newer sign-in replaces, one whose link ran out (after a grace of two minutes), one signed out.
- **Discord** is not among the ready cards: Composio's user OAuth for Discord gives only the profile and servers, and
  its bot toolkit (`discordbot`) needs the person's own bot token, which Composio's own sign-in does not cover. The
  agent can still add a Discord app from the chat when Composio signs in to it by itself.

## Logos (added 2026-10-31)

- A real service's card shows its own logo on a white tile instead of the tinted icon; abilities (weather,
  currencies…) keep their icon. Web catalog rows, popular tiles, the entry's page and the chat card; the iOS catalog.
- `integration.logo` and `entries[].logo` in the manifest: a 128×128 PNG inside the plugin (`./logos/slack.png`),
  committed to the repository: no request leaves the hub to draw one. The hub serves it at
  `GET /api/integrations/:id/logo` only when it is a PNG (by its signature) inside the plugin's folder and at most
  64 KB; `IntegrationView.logo` is that address with a version (`?v=`), so a new file is fetched again.
- The PNGs were made from Composio's logo CDN (`logos.composio.dev/api/<slug>`, SVG) with AppKit; apps it only has a
  placeholder for (Granola, Blender, Wikipedia, 2GIS, Google) keep their icon. Apps added from the chat keep the
  plug icon for now.
- A service that refuses a call for a permission not given at sign-in (Google's unticked boxes: "insufficient
  authentication scopes") turns its card to Reconnect with "%detail.scopes%"; the sign-in card and the agent say up
  front to allow everything the service's page asks for.

## Errors

- The key is wrong or revoked (401): every entry is `broken` with a clear detail and the card asks for the key again;
  `hub_integrations_list` says the same.
- The free quota is used up (Composio stops until next month): the tool tells the agent "Composio's limit is
  reached", the agent tells the person. The entry stays as it is.
- The sign-in expired or was revoked at the service: the entry is `broken`, the card has Reconnect.
- The link expired before the person signed in: polling stops, the entry stays `needs-setup`, the button makes a new
  link.
- Composio is unreachable (network, 5xx): the tool returns the error with its cause; entries keep their last known
  state; the plugin process does not fall over.
- An app Composio cannot sign in to itself: `composio_apps_search` says so ("needs its own OAuth client"),
  `composio_app_add` refuses it.

## Tests

- Core: plugin entries in the catalog (known ahead and added; `off` while the plugin is off), `via`, sign-in and
  sign-out through the plugin, the agent hears about the sign-in, `integration_connect` / `integrations_list` with
  `composio:slack`.
- Plugin, against a fake Composio: key, auth config, link, polling to `ACTIVE`, tools by tags (untagged is a
  write), names cut, 401 / limit / 5xx, sign-out.
- Locales: en/ru parity (`packages/core/test/i18n.test.ts`).
- Web: the badge and its note (`catalog.test.ts`, the card).
- iOS: the badge in the catalog row, the note's sheet, the chat card (OwlbotKit tests + a simulator check).
- Live, with the person's key: connect one app, call one read and one write through the approval card.

## Not in this step

- Our own OAuth apps inside Composio.
- Composio triggers (webhooks such as "an email arrived"): they fit Owlbot's triggers, a step of their own.
- Composio's Tool Router and its generic "search and execute" tools in place of separate ones.
- Self-hosted Composio (Enterprise).
- Moving Google Calendar to Composio: the native one stays.
