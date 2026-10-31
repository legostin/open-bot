# Remote access: a permanent link through Tailscale

2026-10-27. Decided with the user: the hub is reachable from anywhere through one permanent link, with no Tailscale
on the phone or the browser's device (Tailscale Funnel); Tailscale comes built into Piomio (its own node, not the
Tailscale app installed on the computer). Today the phone app works only on the home Wi-Fi, or when the phone itself
runs Tailscale in the same tailnet, and the web UI only on the computer.

## What the user sees

- The integrations library gets a card **Access from anywhere** (category `access`, first in the library, icon
  `globe`). Its steps:
  1. **Turn on** (needs the hub password, which every set-up hub has).
  2. **Sign in to Tailscale**: Tailscale's sign-in page (Google, Apple, GitHub, Microsoft…) opens in a new tab or the
     system browser (iOS app). The node `piomio` joins the user's tailnet; a new tailnet is made for a new account.
  3. **Allow Funnel**, when the tailnet does not allow it yet: Tailscale's own page, one confirmation by the tailnet
     admin (it turns on HTTPS certificates and adds the `funnel` attribute to the policy).
  4. **On**: the link `https://piomio.<tailnet>.ts.net` with Copy and a QR code, the tailnet account, and Turn off.
     A smaller **Forget** signs the node out of Tailscale and deletes its keys.
- The link is permanent: it changes only when the node is removed from the tailnet or renamed there. Tailscale
  assigns `piomio-1` and so on when the name is taken.
- Through the link: the web UI (sign-in by password), the phone app, and machines (`piomio-node pair <link> <code>`).
- Phones: a new pairing QR lists the link among the hub's addresses. Phones paired before learn it on their next
  connection (below). At home they still go straight over the Wi-Fi; away, through the link.
- The agent shows the same card in the chat with `hub_integration_connect({ id: "remote-access" })`.
- Tailscale's node keys expire (180 days by default). From 14 days before the expiry the card warns and links to the
  admin console's Machines page, where expiry can be turned off for the node; once expired the card is back at
  "Sign in to Tailscale".
- Settings → Devices shows the link next to the pairing QR; the Machines page offers it as the hub address.

## The node: `packages/tailnet` (Go)

- A small Go program `piomio-tailnet` on `tailscale.com/tsnet`. The hub runs it as a child process and talks to it
  in JSON lines over stdin/stdout. Its logs go to stderr, which the hub keeps in its log.
- Hub → node, the first line:
  `{ "type": "start", "dir": "<data>/tailnet", "hostname": "piomio", "web": "127.0.0.1:<port>", "device": "127.0.0.1:<port>", "deviceCert": "<PEM>", "deviceKey": "<PEM>" }`.
  Later lines: `{ "type": "logout" }`. The hub stops the node by closing stdin (the node exits) and kills it after 5 s.
- Node → hub: `{ "type": "state", ... }` lines:
  - `{ "state": "starting" }`
  - `{ "state": "needs-login", "authUrl": "https://login.tailscale.com/a/…" }`, from the IPN bus `BrowseToURL`
  - `{ "state": "needs-funnel", "enableUrl": "https://login.tailscale.com/f/funnel?node=…" }`, from
    `LocalClient().QueryFeature(ctx, "funnel")`; the node checks again every 10 s and on the IPN bus
  - `{ "state": "running", "url": "https://piomio.<tailnet>.ts.net", "deviceUrl": "https://piomio.<tailnet>.ts.net:8443", "account": "<login name>", "keyExpiry": "<ISO>|null" }`
  - `{ "state": "error", "message": "…" }`
- When running it listens with `ListenFunnel` (Funnel and the tailnet):
  - `:443` with Tailscale's Let's Encrypt certificate → an HTTP reverse proxy (WebSockets included) to `web`;
  - `:8443` with `FunnelTLSConfig` carrying the hub's own device certificate, so the phone's pinned fingerprint holds
    → an HTTP reverse proxy to `device`.
  Both proxies keep the `Host` header and set `X-Forwarded-For` to the client's address (`FunnelConn.Src` for
  Funnel, the peer address on the tailnet) and `X-Forwarded-Proto: https`.
- State (node keys) lives in `<data>/tailnet/` (directory 0700), like the device port's TLS key in
  `<data>/devices/`: the link comes back after a restart without waiting for the vault.
- Builds: `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`, `linux-arm64` into
  `packages/tailnet/bin/<platform>-<arch>/piomio-tailnet[.exe]` (`npm run build:tailnet`, needs Go;
  `scripts/build-tailnet.mjs` cross-compiles with `CGO_ENABLED=0`). Go tests cover the line protocol and the proxy
  headers (the tsnet parts sit behind an interface).

## The hub

- `packages/core/src/remote.ts`, class `RemoteAccess`:
  - finds the binary: `PIOMIO_TAILNET_BIN`, else `packages/tailnet/bin/<platform>-<arch>/…` from the app root;
    none → `available: false`;
  - setting `remote: { enabled: boolean }` (core settings); on start, an enabled hub starts the node;
  - `view(): RemoteView` = `{ available, enabled, state, url?, deviceUrl?, authUrl?, enableUrl?, account?, keyExpiry?, error? }`;
  - `enable()` / `disable()` / `forget()` (forget: a running node gets `logout` and exits; then `<data>/tailnet` is
    deleted and `enabled` turns false; a node that was not running stays in the tailnet's list as offline);
  - restarts a node that died: 2 s, doubling up to 60 s; the state is `error` with its last stderr line meanwhile;
  - emits `remote.updated` with the view on every change.
- **The gateways**: requests from the link never reach the computer's own port.
  - `buildMainApp(hub, { remote: true })` on `127.0.0.1:0` (a port only the node is told). It drops
    `/api/auth/setup`, `/api/auth/desktop`, the passkey routes, `/oauth/callback` and `/hooks/*` (they answer 404); `/mcp` stays, behind its sessions' bearer tokens, for brains on machines paired through the link; it allows
    the host and origin of the link only; cookies are `secure`; `trustProxy` is `127.0.0.1`, so `clientIp()` is the
    real client. Everything else (sign-in, the API behind the session, the SPA, machines' pairing and `/node/ws`)
    is as on the main port. The security console is a separate app and never has a gateway.
  - `buildDeviceApp(hub, tls, { remote: true })` over plain HTTP on `127.0.0.1:0`, the same routes as the device
    port, `trustProxy` `127.0.0.1`.
  - Both gateways start with the node and stop with it.
- **Sign-in from the link**: the per-address limit stays (10 failures in 15 minutes). On top of it, failures from
  all remote addresses share a budget: 30 in an hour pauses password sign-in through the link for an hour (the
  computer's own sign-in is not affected), writes `auth.remotePaused` to the audit log and notifies the user.
  Passkeys are bound to the computer's address and do not work through the link (password only, for now).
- **Addresses for phones**: `deviceUrls()` puts the link's `deviceUrl` after the private addresses and before the
  raw tailnet ones. A new authenticated `GET /api/devices/addresses` → `{ urls }` gives paired phones the current list.
- **API** (main app and gateway, behind the session): `GET /api/remote`, `POST /api/remote/enable`,
  `POST /api/remote/disable`, `POST /api/remote/forget`. `enable` answers 409 `remote.unavailable` without the
  binary and `auth.noPassword` without a password.
- **The library**: `listIntegrations()` adds a core entry `remote-access` (`connect: "remote"`) before the plugins'
  cards: `off` (not enabled), `needs-setup` (needs-login or needs-funnel, the step in `detail`), `connected`
  (`account` = the link), `broken` (error), `unavailable` (no binary).
- Contracts: `IntegrationView.connect` gains `"remote"`; new `RemoteView`, `RemoteState` and the UiEvent
  `remote.updated` in `packages/shared/src/types.ts`.

## Web

- `IntegrationCard` renders `connect: "remote"` with a `RemoteAccessCard`: the step buttons (Turn on, Sign in to
  Tailscale, Allow Funnel), the link with Copy and a QR, the account, the expiry warning, Turn off and Forget.
  Sign-in and Allow Funnel open Tailscale's page like the Google sign-in does (`native.openURL` in the apps).
- When the page itself is open through the link, Turn off and Forget ask first: "You will lose this page".
- Devices page: the link and its state above the pairing QR. Machines page: the link as the hub address.
- All strings in the web catalogs (en, ru); core strings in the core catalogs.

## The iOS app (`~/claude-projects/piomio-ios`)

- After connecting, `HubSession` calls `GET /api/devices/addresses` and stores the new list in `PairedHub.urls`
  (the last working address stays first in `candidates`). Nothing else changes: the link's port presents the same
  certificate the app pins.

## Shipping

- Desktop app: `packaging/desktop/stage.mjs` copies the target's binaries (`darwin`: arm64 and x64; `win-x64`) into
  the app tree; the workflow gets `actions/setup-go` and runs `npm run build:tailnet` first.
- Docker: a Go build stage builds the image's Linux binary; the node keeps its keys in `/data/tailnet`. tsnet runs
  in userspace, so the container needs no extra privileges.
- From source: `npm run build:tailnet` (README: needs Go 1.25+); without it the card says "Unavailable" and why.

## Errors

- The binary is missing or not executable: `unavailable`, with the reason.
- The node dies: restarts with back-off, the card shows `error` and the last line from the node.
- Tailscale signs the node out or the key expires: back to `needs-login`.
- Funnel is turned off in the tailnet: back to `needs-funnel`.
- A gateway port fails to bind: `error`, the node is not started.

## Tests

- Go: the line protocol, the proxies set `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`.
- Core, with a fake node (a Node script speaking the same lines, `PIOMIO_TAILNET_BIN`): state transitions and
  restarts; the gateways answer 404 on setup, desktop, passkeys, OAuth callback and hooks; `clientIp()` comes from the
  forwarded header; the shared remote failure budget and that local sign-in still works; `/api/devices/addresses`;
  the library entry; enable without a password or without the binary.
- Web: the card's steps and actions.
- By hand on the user's tailnet: sign in, allow Funnel, open the link from a phone off the Wi-Fi, the phone app
  through the link. Signing in to Tailscale and allowing Funnel are the user's own steps.

## Not now

- Webhooks for plugins (`/hooks/*`) through the link.
- Passkeys through the link.
- Choosing the node's name in the UI (rename it in the Tailscale admin console).
- Using a Tailscale app already installed on the computer.
