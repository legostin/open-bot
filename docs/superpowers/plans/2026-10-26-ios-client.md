# iOS client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phones pair with a hub by QR or link and use it from a native SwiftUI app: team, chat with cards, approvals with Face ID, tasks, notifications, voice.

**Architecture:** The hub gets a devices service and a second, phone-only HTTPS server (pinned self-signed certificate, bearer tokens) that serves the same API as the web UI plus device routes. The app lives in its own repository (`piomio-ios`): a Swift package `PiomioKit` for everything testable and a SwiftUI app target.

**Tech Stack:** Node 24 (type stripping), Fastify 5, `node:sqlite`, `node:crypto`, vitest; `qrcode-generator` for QR codes; Swift 6, SwiftUI (iOS 26), Security / LocalAuthentication / Speech / AVFoundation.

Spec: `docs/superpowers/specs/2026-10-26-ios-client-design.md`.

## Global Constraints

- Backend TypeScript runs without a build: `.ts` imports, erasable syntax only, `import type` for types.
- Every user-facing string goes through the catalogs (core `packages/core/src/locales/{en,ru}.ts`, web `packages/web/src/i18n/{en,ru}.ts`, app `Localizable.xcstrings`); English is the source; parity tests stay green.
- Text for the model (tool descriptions, tool results) is English.
- Device port default: web port + 2 (8082). Pairing codes live 10 minutes and are single use. Approval nonces live 2 minutes and are single use.
- Link format: `piomio://pair?v=1&c=<code>&n=<hub name>&fp=<base64url sha256 of the certificate DER>&u=<https url>` (repeat `u`).
- Approval signature payload: `piomio-approval\n<approvalId>\napprove\n<nonce>`, ECDSA P-256 / SHA-256, DER signature, base64.
- iOS deployment target 26.0; bundle id `app.piomio.ios`, URL scheme `piomio`.

---

### Task 1: Devices service and storage

**Files:** Create `packages/core/src/devices.ts`, `packages/core/test/devices.test.ts`; modify `packages/core/src/db.ts` (migration), `packages/shared/src/types.ts` (`Device`), `packages/core/src/bus.ts` (`device.updated`), `packages/core/src/app.ts` (wire `hub.devices`), `packages/core/src/approvals.ts` (`via: "device"`).

**Interfaces (produces):**
- `class DeviceRegistry { createPairingCode(): { code, expiresAt }; pair({ code, name, platform, model, publicKey }): { device: Device; token: string }; authenticate(header: string | undefined): Device | undefined; list(): Device[]; get(id); rename(id, name); revoke(id, actor); challenge(deviceId, approvalId): { nonce, expiresAt }; verifyApproval(device, approvalId, nonce, signatureB64): boolean }`
- `interface Device { id; name; platform; model?; createdAt; lastSeenAt?; }`

- [ ] Tests: code single use and expiry; bad public key refused; token authenticates, revoked token does not; `last_seen_at` updates; nonce single use; signature from a `crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })` key verifies, a wrong key or a replayed nonce does not.
- [ ] Implement, run `npx vitest run packages/core/test/devices.test.ts`, then the whole suite.

### Task 2: Certificate and the device server

**Files:** Create `packages/core/src/devices-tls.ts` (self-signed ECDSA certificate built as DER, fingerprint), `packages/core/src/server/api.ts` (authenticated API moved out of `main-app.ts`), `packages/core/src/server/device-app.ts`, `packages/core/test/device-app.test.ts`; modify `packages/core/src/server/main-app.ts`, `packages/core/src/config.ts` (`devicePort`, `devicesEnv`), `packages/core/src/settings.ts` (`devicesLan`), `packages/core/src/app.ts` (start/stop the device server on the switch).

**Interfaces:** `deviceTls(dataDir): { key: string; cert: string; fingerprint: string }`; `registerApi(api, hub, opts: { kind: "web" | "device"; wsAllowed(req): boolean; bootstrapExtra(req): object })`; `buildDeviceApp(hub, tls): Promise<FastifyInstance>`; `hub.setDevicesLan(on: boolean)`; `hub.deviceAddresses(): string[]`.

- [ ] Tests: the certificate parses with `new X509Certificate`, fingerprint stable across two calls; over HTTPS (`undici` / `https` with `rejectUnauthorized: false` and a fingerprint check) `/api/device/hello` answers without a token, `/api/team` 401 without and 200 with a paired token; `/api/approvals/:id/resolve` approves with a valid signature and refuses a bad one; the web app still answers `/api/team` with a cookie session (existing tests).
- [ ] Implement; run the core suite.

### Task 3: Pairing endpoints, chat card, CLI

**Files:** Create `packages/core/src/pairing.ts` (link, addresses, QR SVG/ASCII via `qrcode-generator`); modify `packages/core/src/server/api.ts` (`/api/devices*` for the web), `packages/core/src/tools/hub-tools.ts` (`hub_device_pairing`, `hub_devices_list`), `packages/shared/src/types.ts` (`device_pairing` message part), `packages/core/src/cli.ts` (`devices pair`), core locales.

- [ ] Tests: `pairingLink()` encodes every address and parses back; `/api/devices/pairing` returns code, link, svg; the tool attaches the card part.
- [ ] Implement; run the core suite and `npm run typecheck`.

### Task 4: Web UI

**Files:** Create `packages/web/src/pages/Devices.tsx`, `packages/web/src/pages/chat/DevicePairingCard.tsx`; modify `components/nav.ts`, the settings panel section switch, `pages/chat/MessageView.tsx`, `packages/web/src/i18n/{en,ru}.ts`, shared UI event types.

- [ ] Devices section: network switch, "Connect a phone" (QR, link + Copy, code, expiry), devices list with Revoke; live updates on `device.updated`.
- [ ] Chat card renders the same pairing block.
- [ ] `npm run build`, `npm test`, check in the browser.

### Task 5: PiomioKit (repository `piomio-ios`)

**Files:** `PiomioKit/Package.swift`, `Sources/PiomioKit/{Models,PairingLink,PinnedTrust,HubClient,Endpoints,Realtime,Credentials,Stores}.swift`, `Tests/PiomioKitTests/*`.

- [ ] Tests first for link parsing, part decoding (fixtures recorded from the dev hub), event reducer.
- [ ] `swift test` green.

### Task 6: The app

**Files:** `Piomio.xcodeproj`, `Config/{Info.plist,Base.xcconfig}`, `Piomio/` (App, Onboarding, Scanner, Team, Chat + cards, Tasks, Inbox, Hub, Voice, DeviceKey), `Piomio/Localizable.xcstrings`.

- [ ] Build for the simulator, pair with the dev hub via `xcrun simctl openurl`, walk every tab, screenshots.
- [ ] Build signed for the iPhone (`-allowProvisioningUpdates`), install with `xcrun devicectl device install app`, launch, pair over Wi-Fi, send a message, approve with Face ID.
