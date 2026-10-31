# Integrations Library and Google Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page of integration cards; Google sign-in in the hub; a Google Calendar plugin the agent reads and writes;
the day's events in the digest.

**Architecture:** Spec `docs/superpowers/specs/2026-10-27-integrations-google-calendar-design.md`. Core: `connections.ts`
(OAuth with PKCE, vault, token cache), `integrations.ts` (the cards' data), routes in `server/api.ts` plus the public
`/oauth/callback` in `main-app.ts`, a `digest.compose` hook in the notifier. Plugin `plugins/google-calendar`.
Web: panel section `integrations`, `IntegrationCard` (page and chat part).

**Tech Stack:** Node 24 TypeScript, Fastify, React 19, vitest.

## Global Constraints

- `.ts` imports, erasable syntax, `import type`; user-facing text through catalogs (core, web, plugin locales);
  model-facing text English.
- Secrets only in the vault (`google_refresh_token`); plugins never see the refresh token.
- The built-in Google client may be empty: everything degrades to `unavailable`.

---

### Task 1: Contracts
Files: `packages/shared/src/manifest.ts` (`integration` block: `category`, `icon`, `connect: "google"|"setup"|"none"`,
`scopes: string[]`, `summary`; `CORE_METHODS += "connections.token"`), `packages/shared/src/types.ts` (MessagePart
`{ type: "integration"; id: string }`, `IntegrationView`, `IntegrationStatus`), `packages/core/src/hooks.ts` and
`packages/plugin-sdk/src/types.ts` (`digest.compose` payload `{ date, time, timezone }`, result `{ title, body }`).
- [ ] typecheck, commit.

### Task 2: Google connection (core)
Files: create `packages/core/src/connections.ts`, `packages/core/test/connections.test.ts` (fake Google server);
modify `config.ts` (`google: { clientId, clientSecret, authUrl, tokenUrl, revokeUrl, userinfoUrl }` from env),
`app.ts` (wire), `core-call.ts` (`connections.token`), `server/api.ts` (start, complete, delete, list),
`server/main-app.ts` (public `GET /oauth/callback`), locales.
- Interface: `class Connections { available(p); start(p, scopes, origin?) → { url }; complete(url|{code,state}) → Account;
  token(p) → { accessToken, expiresAt, account }; disconnect(p); list(): Account[] }`.
- [ ] tests: url params (PKCE S256, offline, consent), callback stores refresh token in vault + account, wrong/old
  state refused, refresh before expiry, invalid_grant → broken, disconnect revokes; commit.

### Task 3: Integrations list and chat card
Files: create `packages/core/src/integrations.ts`; modify `server/api.ts` (`GET /api/integrations`,
`POST /api/integrations/:id/enabled`), `tools/hub-tools.ts` (`integrations_list`, `integration_connect`),
`runner.ts`/hub-tools CARDS (`integration` part); manifests + locales of telegram, web, browser.
- [ ] tests (hub): statuses for each kind, connect card attached; commit.

### Task 4: Digest sections
Files: `packages/core/src/notifier.ts` (`flushDigest` runs `digest.compose`, sends sections, keeps their lines).
- [ ] test with a fake plugin hook; commit.

### Task 5: Google Calendar plugin
Files: `plugins/google-calendar/{package.json,.piomio-plugin/plugin.json,.piomio-plugin/locales/{en,ru}.json,
server/index.ts,server/api.ts,server/time.ts,test/*.test.ts}`; root `package.json` workspaces already include plugins/*.
- [ ] unit (time zones, formatting), plugin tests with the testkit (fake Calendar API, fake `connections.token`); commit.

### Task 6: Web
Files: `components/nav.ts` (section), `pages/Integrations.tsx`, `components/IntegrationCard.tsx`, `lib/integrations.ts`
(+test), `MessageView.tsx` (`integration` part), panel registration, i18n.
- [ ] build, i18n parity, live check in the browser pane; commit.

### Task 7: Docs and verification
- [ ] READMEs (Integrations, Google Calendar, how to create the Google client), full tests, build.
