# Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub runs its own Tailscale node and gives one permanent Funnel link that opens the web UI and serves the
phone app from anywhere.

**Architecture:** A Go program (`packages/tailnet`, tsnet) is the node: it reports its state in JSON lines and
proxies Funnel traffic to two loopback "gateways" of the hub (a restricted main app and a plain-HTTP device app).
`RemoteAccess` in the core runs the node and feeds the integrations library; the web shows a card; the iOS app
refreshes its addresses.

**Tech Stack:** Go 1.27.3 + `tailscale.com` v1.104.2 (tsnet); Node 24 / Fastify / vitest; React 19; Swift.

Spec: `docs/superpowers/specs/2026-10-27-remote-access-design.md`.

## Global Constraints

- Node runs TypeScript directly: `.ts` imports, erasable syntax only, `import type` for types.
- Every user-facing string goes through the catalogs (core `packages/core/src/locales/{en,ru}.ts`, web
  `packages/web/src/i18n/{en,ru}.ts`); text for the model, code and comments are English.
- Requests from the link never reach the computer's own port; the security console never gets a gateway.
- The node's keys live in `<data>/tailnet/` (0700); nothing about it goes into settings or env except
  `OWLBOT_TAILNET_BIN` and `OWLBOT_TAILNET_HOSTNAME` (dev/test only).
- The node disables Tailscale log upload (`TS_NO_LOGS_NO_SUPPORT=true`).
- Funnel ports: web on 443, phones on 8443.

---

### Task 1: Contracts

**Files:** `packages/shared/src/types.ts`, `packages/core/src/bus.ts`, `packages/core/src/settings.ts`

**Produces:**
```ts
export type RemoteState = "off" | "starting" | "needs-login" | "needs-funnel" | "running" | "error";
export interface RemoteView {
  available: boolean;          // the node binary exists
  enabled: boolean;            // the switch (settings.remoteAccess)
  state: RemoteState;
  url?: string;                // https://owlbot.<tailnet>.ts.net
  deviceUrl?: string;          // https://owlbot.<tailnet>.ts.net:8443
  authUrl?: string;            // needs-login
  enableUrl?: string;          // needs-funnel
  account?: string;            // the tailnet login name
  keyExpiry?: string;          // ISO, when the node key expires
  error?: string;              // localized reason (unavailable / error)
}
// IntegrationView.connect: "google" | "setup" | "none" | "remote"
// UiEvent: { type: "remote.updated"; data: RemoteView }
// CoreSettings.remoteAccess: boolean (default false)
```
- [ ] Add the types, the bus event (`"remote.updated": RemoteView`, forwarded to the UI like `devices.network`),
  the setting with default `false`; `npm run typecheck`; commit.

### Task 2: The node (`packages/tailnet`)

**Files:** `packages/tailnet/{go.mod,go.sum,main.go,node.go,proxy.go,protocol.go,proxy_test.go,protocol_test.go,README.md,package.json}`,
`scripts/build-tailnet.mjs`, root `package.json` (`build:tailnet`), `.gitignore` (`packages/tailnet/bin/`).

**Protocol** (`protocol.go`): stdin first line `Start{Type:"start", Dir, Hostname, Web, Device, DeviceCert, DeviceKey}`,
then `{type:"logout"}`; stdout `State{Type:"state", State, URL, DeviceURL, AuthURL, EnableURL, Account, KeyExpiry, Message}`
(omitempty). EOF on stdin → close the server and exit 0.

**Node** (`node.go`): `tsnet.Server{Dir, Hostname, UserLogf: stderr, Logf: nil}`; `Start()`; a loop every 2 s on
`lc.Status()`:
- `NeedsLogin`/`NeedsMachineAuth` → `needs-login` with `st.AuthURL` (call `lc.StartLoginInteractive` once when
  the URL is empty);
- `Running` → `lc.QueryFeature(ctx, "funnel")` (every 10 s until `Complete`): not complete → `needs-funnel` with
  `URL`; complete → start the listeners once and emit `running` (`url` from `strings.TrimSuffix(st.Self.DNSName, ".")`,
  `account` = `st.User[st.Self.UserID].LoginName`, `keyExpiry` = `st.Self.KeyExpiry`);
- emit only on change; `logout` → `lc.Logout(ctx)`, close, exit 0.

**Proxies** (`proxy.go`): `newProxy(target string) http.Handler` = `httputil.ReverseProxy` with `Rewrite` that sets
`Out.URL` to `http://<target>`, keeps `In.Host`, sets `X-Forwarded-For` = client IP and `X-Forwarded-Proto: https`;
`clientIP(c net.Conn) string` unwraps `*tls.Conn` → `NetConn()`; `*ipn.FunnelConn` → `Src.Addr()`, else
`RemoteAddr` host. Servers: `http.Server{Handler, ConnContext}` storing the client IP in the context.
`:443` → `ListenFunnel("tcp", ":443")`; `:8443` → `ListenFunnel("tcp", ":8443", FunnelTLSConfig(&tls.Config{Certificates: deviceCert}))`.

- [ ] Write `protocol_test.go` (parse start, encode state omitting empties) and `proxy_test.go` (httptest backend
  sees Host, X-Forwarded-For from the context, X-Forwarded-Proto; WebSocket upgrade passes) — fail.
- [ ] Implement; `go test ./...` passes; `go vet`.
- [ ] `scripts/build-tailnet.mjs [--all]`: host target by default, all five with `--all`;
  `go build -trimpath -ldflags "-s -w"` with `CGO_ENABLED=0`, `GOOS`/`GOARCH` into
  `packages/tailnet/bin/<platform>-<arch>/owlbot-tailnet[.exe]`. Commit.

### Task 3: `RemoteAccess` in the core

**Files:** `packages/core/src/remote.ts`, `packages/core/test/remote.test.ts`,
`packages/core/test/fixtures/fake-tailnet.mjs`, `packages/core/src/config.ts` (`tailnetBin?`, `tailnetHostname`),
`packages/core/src/locales/{en,ru}.ts` (`remote.*`).

**Produces:**
```ts
export class RemoteAccess {
  constructor(d: { config: Config; settings: Settings; bus: EventBus; deviceTls: () => DeviceTls;
    gateways: { start(): Promise<{ web: number; device: number }>; stop(): Promise<void>; setHost(host?: string): void } });
  view(locale?: Locale): RemoteView;
  start(): Promise<void>;      // on hub start: runs the node when enabled
  enable(): Promise<RemoteView>;
  disable(): Promise<RemoteView>;
  forget(): Promise<RemoteView>;
  stop(): Promise<void>;       // hub stop
  linkHost(): string | undefined;   // host of `url` while running
}
export function tailnetBinary(cfg: Config): string | undefined;
```
- Spawns the binary with `stdio: ["pipe","pipe","pipe"]`, env `TS_NO_LOGS_NO_SUPPORT=true`; writes the start line
  (keys from `deviceTls()`), reads state lines; restarts after an unexpected exit (2 s, ×2 up to 60 s) with
  `state: "error"` and the last stderr line; `disable` closes stdin and kills after 5 s.
- The fake node (`fake-tailnet.mjs`) reads the start line and replays states from `FAKE_TAILNET_SCRIPT`
  (JSON array) and reacts to `logout`; `FAKE_TAILNET_CRASH=1` exits 3 after its states.
- [ ] Tests (fail first): not available without a binary; enable → starting → needs-login(authUrl) →
  needs-funnel(enableUrl) → running(url) with `remote.updated` events; the start line carries dir, hostname, ports
  and the device cert; crash → error, then back to running; disable stops it; forget sends logout, deletes
  `<data>/tailnet`, `enabled` false.
- [ ] Implement; tests pass; commit.

### Task 4: Gateways, sign-in budget, addresses, API, library

**Files:** `packages/core/src/server/main-app.ts`, `packages/core/src/server/device-app.ts`,
`packages/core/src/auth.ts`, `packages/core/src/app.ts`, `packages/core/src/pairing.ts`,
`packages/core/src/server/api.ts`, `packages/core/src/integrations.ts`, `packages/core/test/remote-gateway.test.ts`.

- `buildMainApp(hub, opts?: { remote?: { host: () => string | undefined } })`: in remote mode
  `trustProxy: "127.0.0.1"`, host check = the link host, origins = `https://<host>`, `secure` cookies, skip
  `/api/auth/setup`, `/api/auth/desktop`, `/api/auth/passkey/*`, `/mcp`, `/oauth/callback`, `/hooks/*`;
  `/api/auth/state` reports `passkeys: 0`; login calls `verifyPassword(pw, ip, { remote: true })`.
- `buildDeviceApp(hub, tls, opts?: { remote?: boolean })`: remote → no `https`, `trustProxy: "127.0.0.1"`.
- `AuthService.verifyPassword(password, ip, opts?: { remote?: boolean })`: remote failures also go into a shared
  list; ≥ 30 in an hour → `AuthError(429, "auth.remotePaused")`, audit `auth.remotePaused` once per pause and
  `onRemotePause()` (the hub notifies the user).
- `deviceUrls(port, extra, interfaces, link?)`: the link after private addresses, before tailnet IPs.
- `Hub`: `remote = new RemoteAccess(...)` with gateways on `127.0.0.1:0`; `deviceNetwork()` adds the link to `urls`;
  `devicePairing()` works when the device port or the remote link is up; start/stop wire `remote.start()/stop()`.
- API (web kind): `GET /api/remote`, `POST /api/remote/{enable,disable,forget}`; device kind:
  `GET /api/devices/addresses` → `{ urls }`.
- `listIntegrations()`: `remote-access` first (`category: "access"`, `icon: "globe"`, `connect: "remote"`).
- [ ] Tests (fail first) with a hub started on random ports and the fake node: gateway 404s on setup, desktop,
  passkey, MCP, OAuth callback, hooks; 421 on a foreign host; login through the gateway sets a `secure` cookie;
  `clientIp` = forwarded IP (per-IP lock hits that IP only); the shared budget pauses remote sign-in while local
  login works; device gateway hello + `/api/devices/addresses`; library entry statuses; pairing link lists the
  link. Implement; core suite passes; commit.

### Task 5: Web

**Files:** `packages/web/src/components/RemoteAccessCard.tsx`, `packages/web/src/state/remote.ts`,
`packages/web/src/components/IntegrationCard.tsx`, `packages/web/src/lib/integrations.ts` (+ test),
the Devices and Machines pages, `packages/web/src/i18n/{en,ru}.ts`.
- `state/remote.ts`: `loadRemote()`, `useRemote()`, refreshed on `remote.updated`.
- Card: per state — Turn on / Sign in to Tailscale (opens `authUrl`) / Allow Funnel (opens `enableUrl`) / link with
  Copy and QR, account, expiry warning (< 14 days) with the Machines link, Turn off, Forget; error and unavailable
  text. Through the link (`location.host === new URL(url).host`) Turn off / Forget confirm first.
- `primaryAction()` handles `connect: "remote"`; `IntegrationCard` renders `RemoteAccessCard` for it.
- Devices page: the link above the pairing QR; Machines page: the link as the hub address.
- [ ] Test `primaryAction` for remote; implement; web tests, typecheck, build; commit.

### Task 6: iOS app

**Files:** `~/claude-projects/owlbot-ios/OwlbotKit/Sources/OwlbotKit/{HubClient,HubSession}.swift`, its tests.
- `HubClient.addresses() async throws -> [URL]` (`GET /api/devices/addresses`); after `refresh()` in the run loop,
  `HubSession` merges them: `paired.urls = new` when different, save.
- [ ] Test the decode; `swift test` in OwlbotKit; commit there.

### Task 7: Shipping and docs

**Files:** `packaging/desktop/stage.mjs`, `.github/workflows/desktop.yml`, `docker/Dockerfile`, `README.md`,
`README.ru.md`, `packages/tailnet/README.md`.
- stage: copy `packages/tailnet/bin/<target>` (darwin: arm64 + x64; win-x64) into the app tree; fail clearly when
  missing. Workflow: `actions/setup-go` with `go-version-file: packages/tailnet/go.mod`, `npm run build:tailnet -- --all`.
- Dockerfile: `FROM golang:1.27-bookworm AS tailnet` builds the Linux binary; copied into `/app/packages/tailnet/bin/linux-<arch>/`.
- READMEs: "Access from anywhere" section; `build:tailnet`; env `OWLBOT_TAILNET_BIN`.
- [ ] Implement; `node packaging/desktop/stage.mjs --target darwin --skip-build` stages the binaries; commit.

### Task 8: Live check

- [ ] Build the node; a throwaway hub with `OWLBOT_TAILNET_HOSTNAME=owlbot-dev` in the browser pane: the card
  walks to "Sign in to Tailscale" with a real login URL. Signing in and allowing Funnel is the user's step; after
  it: the link opens the sign-in page from outside, the device port answers through `:8443`.
