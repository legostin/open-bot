# Owlbot

Self-hosted personal agent platform. Spec: `docs/superpowers/specs/2026-10-26-open-bot-design.md` (Russian).

## Conventions
- Node ≥ 24 runs TypeScript directly (type stripping): no build step for backend code.
  Import local files with the `.ts` extension; only erasable syntax (no enums, no parameter properties, no namespaces).
  `verbatimModuleSyntax` is on: use `import type` for types.
- npm workspaces: `packages/*` (core, shared, plugin-sdk, mcp-bridge, brains-cli, node, web, console, ui-sdk, testkit) and `plugins/*` (builtin plugins).
- Contracts live in `packages/shared/src/types.ts`, `packages/shared/src/manifest.ts` and `packages/plugin-sdk/src/types.ts`. Change them deliberately.
- Plugins only `import type` from `@owlbot/plugin-sdk`; the runner (`packages/plugin-sdk/src/runner.ts`) provides the implementation.
- Plugin tool names are exposed as `<toolPrefix>_<name>` (prefix defaults to plugin id with `-` → `_`). Names match `[a-zA-Z0-9_-]{1,64}`.
- i18n (English + Russian, more later): every user-facing string goes through a catalog — never hard-code it.
  Shared runtime: `packages/shared/src/i18n.ts` (`{name}` placeholders, ICU-style plurals). Core: `packages/core/src/locales/{en,ru}.ts` + `t()` / `LocalizedError` / `HttpError(status, key)`.
  Plugins: `.owlbot-plugin/locales/{en,ru}.json`, `"%key%"` in plugin.json, `ctx.i18n.t()` in the backend, `ui.i18n.t()` in UI modules.
  English is the source of truth and the fallback; `packages/core/test/i18n.test.ts` checks every catalog for parity.
- Text for the model (tool results, tool descriptions, system notes, agent prompts), code and comments is English and not translated.
- Secrets never go into settings, env files or prompts: store them in the vault and pass `vault://<id>` references.

## Commands
- `npm run typecheck` — TypeScript 7 (`tsc --noEmit`)
- `npm test` — vitest (unit + integration)
- `npm run build` — web UI, console and UI plugins (Vite / esbuild)
- `npm run build:tailnet` — the hub's own Tailscale node `packages/tailnet` (Go, not an npm workspace; `go test ./...` there)
- `npm start` — hub on :8080 (UI/API/MCP), :8081 (security console), :8089 (egress proxy)
- Docker is in WSL here: `wsl -u root -e sh -lc "cd /mnt/c/... && docker ..."`
