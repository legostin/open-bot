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

## Interface (law)
- No modal dialogs or forms. Things are made and set up in the chat with an agent: it asks, the person answers or taps buttons inside its messages (quick replies: `choices` parts; live cards with their actions). A "New …" or "Settings" entry point opens the right agent's chat with a short request in the person's words.
- Full minimalism: show only what is needed now; details appear when they are wanted.
- Applies to the web UI, the desktop app and the iOS app alike.

## Cleanup
Delete what you create once it has served its purpose: nothing temporary outlives the task.
- Tests write temp files only under `tmpdir()`. Each vitest run gets its own temp folder (`packages/testkit/src/temp-dir.ts`), deleted at the end, so single tests needn't clean up. Scripts and checks run outside vitest delete their own temp folders.
- Remove a worktree (`git worktree remove`, then any folder left behind) as soon as its branch is merged.
- Throwaway hubs (demos, manual checks): stop them and delete their data dirs when the check is done.
- Build output (Rust `target/`, Xcode DerivedData, downloaded CI artifacts, mounted DMGs) is deleted once the build is installed or the check is done. Installing on the person's Mac from a local build is fine; it need not wait for CI.
- Never delete hub data that holds the person's conversations (the installed hub's, old copies): move it to the Trash and say so.

## Commands
- `npm run typecheck` — TypeScript 7 (`tsc --noEmit`)
- `npm test` — vitest (unit + integration)
- `npm run build` — web UI, console and UI plugins (Vite / esbuild)
- `npm run build:tailnet` — the hub's own Tailscale node `packages/tailnet` (Go, not an npm workspace; `go test ./...` there)
- `npm start` — hub on :8080 (UI/API/MCP), :8081 (security console), :8089 (egress proxy)
- Docker is in WSL here: `wsl -u root -e sh -lc "cd /mnt/c/... && docker ..."`
