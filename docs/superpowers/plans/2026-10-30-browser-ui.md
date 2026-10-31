# Browser UI Implementation Plan

> Executed inline in the session that wrote it (the person said "делай"). Spec:
> `docs/superpowers/specs/2026-10-30-browser-ui-design.md`.

**Goal:** a browser in the live view that looks and works like a browser: tabs, icon toolbar, search from the
address bar with suggestions, history, a phone layout with zoom, gestures and a keyboard that opens by itself.

**Architecture:** the plugin's server (`plugins/browser/server`) gains a history store, richer tab state, search
in `navigate`, a touch probe and two history tools; the UI (`plugins/browser/ui/src`) is split into focused files
with one injected stylesheet on the host's theme variables and lucide icons bundled by esbuild.

**Tech stack:** Node 24 TypeScript (type stripping), Playwright + CDP, React from the host, esbuild, vitest.

## Global constraints

- Every user-facing string in `.piomio-plugin/locales/{en,ru}.json` (`ui.*`), parity is tested.
- Text for the model (tool descriptions/results) English, not translated.
- No script of ours in a page's main world for the probe/focus checks (isolated world only).
- Plugins only `import type` from `@piomio/plugin-sdk`; `.ts` extensions in server imports.

## File map

- Create `plugins/browser/shared/address.ts` — pure: `addressKind(text)`, `SEARCH_ENGINES`, `searchUrl(engine, q)`.
- Create `plugins/browser/server/history.ts` — `HistoryStore` (JSON file, record/title/search/suggest/top/remove/clear/prune).
- Modify `plugins/browser/server/util.ts` — `searchEngine` setting; `resolveAddress(text, engine)`.
- Modify `plugins/browser/server/manager.ts` — history recording, favicons, loading, back/forward state, stop,
  `navigate {text}`, probe/focus via an isolated world, HTTP handler.
- Modify `plugins/browser/server/tools.ts` — `history`, `history_clear` tools; ENGINES use `SEARCH_ENGINES`.
- Modify `plugins/browser/server/index.ts` — `ctx.http.handle`.
- Modify `plugins/browser/.piomio-plugin/plugin.json` + locales — setting, approval, ui strings.
- UI: `ui/src/{index.tsx, host.ts, styles.ts, view.tsx, screen.tsx, zoom.ts, omnibox.tsx, tabs.tsx, history.tsx, newtab.tsx, call.tsx}`.
- Tests: `test/unit.test.ts` (address, settings), `test/history.test.ts` (store), `test/zoom.test.ts`,
  `test/browser.test.ts` (search navigate, history HTTP + tools, state fields, probe).

## Tasks

1. **Address and search** — `addressKind`/`searchUrl`/`resolveAddress` + `searchEngine` setting; unit tests first
   (hosts, ports, IPs, schemes, Cyrillic domains, words → search for each engine).
2. **History store** — tests first: record dedupes the same URL in a row, title fills later, search by words and
   paging by `before`, suggest ranks frequent + recent and dedupes URLs, top dedupes hosts, remove/clear, prune by
   age and count, persists across instances (debounced write, `flush()`).
3. **Manager: state and recording** — `onNavigated` records visits with `by`; favicons from the isolated world;
   `loading`, `canGoBack/canGoForward` (CDP `Page.getNavigationHistory`); `stop` (CDP `Page.stopLoading`);
   `navigate { text }`; HTTP routes; integration tests in `browser.test.ts`.
4. **Probe and focus** — isolated world via CDP `Page.createIsolatedWorld` + `Runtime.evaluate`; `probe` answers
   `{ id, seq, editable: true | false | null }`; `focus { editable }` after the person's clicks/keys in control;
   integration test with a textarea.
5. **History tools** — `browser_history` (read) and `browser_history_clear` (external, approval summary);
   update the effects test.
6. **UI shell and desktop** — split files, stylesheet, lucide icons, tab strip, toolbar, omnibox with suggestions,
   history panel, new tab page, ⋯ menu.
7. **UI phone + gestures** — layout under 640 px, bottom bar, tab switcher, full-view address input, zoom math
   (`zoom.ts`, unit tests), pinch/pan/tap/double-tap, trackpad pinch, zoom chip, keyboard auto-open.
8. **Verify** — `npm run typecheck`, `npx vitest run plugins/browser packages/core/test/i18n.test.ts`,
   `npm run build`, live check in a throwaway dev hub (desktop and phone sizes), then delete its data.
