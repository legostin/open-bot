# Owlbot desktop app (Tauri 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Inno Setup / AppleScript desktop installers with one Tauri 2 app for macOS and Windows that shows the hub's web UI in its own window, lives in the menu bar / tray, runs the hub (or this computer's machine daemon) in the background, and ships as a drag-and-drop `.dmg`, a silent `.pkg` and a per-user NSIS installer.

**Architecture:** `packages/desktop` holds a Rust/Tauri app (`src-tauri`) and its own small setup screens (`ui`, TypeScript + esbuild). The app supervises one child process on the bundled Node from `packaging/desktop/stage.mjs`: the hub (`launch.mjs run`) or the machine daemon (`owlbot-node.mjs run`), talking to it over stdin (`stop`, `ticket <t>`). The hub window loads the hub's own web UI and signs in with a one-time ticket the app hands the hub over that stdin; the core accepts it at `POST /api/auth/desktop`.

**Tech Stack:** Rust 1.85+ with Tauri 2.12 (`tauri`, `tauri-build`, `tauri-plugin-single-instance`, `tauri-plugin-deep-link`, `tauri-plugin-opener`), `@tauri-apps/cli` and `@tauri-apps/api` 2.12, TypeScript (Node 24 type stripping for the backend, esbuild for the setup screens), vitest, `cargo test`, pkgbuild/productbuild (macOS), NSIS through the Tauri bundler (Windows).

**Spec:** `docs/superpowers/specs/2026-10-26-desktop-app-design.md`.

## Global Constraints

- Node ≥ 24 runs backend TypeScript directly: import local files with `.ts`, only erasable syntax (no enums, parameter properties, namespaces), `import type` for types (`verbatimModuleSyntax`).
- Every user-facing string goes through a catalog: app, tray and installer texts in `packaging/desktop/locales/{en,ru}.json`; web UI in `packages/web/src/i18n/{en,ru}.ts`; core in `packages/core/src/locales/{en,ru}.ts`. English is the source of truth; the i18n tests check parity. Code, comments, logs for developers and text for the model are English.
- Data dirs and ports stay as they are: `~/Library/Application Support/Owlbot` (macOS), `%LOCALAPPDATA%\Owlbot` (Windows), ports from `<data>/desktop.json` (default 8080/8081/8089). Machine daemon state stays in `~/.owlbot-node` (`OWLBOT_NODE_HOME` overrides).
- Bundle identifier `ai.owlbot.app`; deep-link scheme `owlbot`; product and binary name `Owlbot`.
- macOS 13.5 or later (universal: Apple silicon and Intel); Windows 10/11 x64.
- Unsigned builds: macOS ad hoc (`signingIdentity: "-"`), never `--deep`, so the bundled Node keeps its Developer ID signature.
- `OWLBOT_DATA_DIR` set means a dev or test run: the app then never writes start-at-login entries and never touches the AppleScript build's LaunchAgent (`ai.owlbot.hub`). `OWLBOT_APP_ROOT` points a dev run at a staged app tree, `OWLBOT_NODE_HOME` moves the node state.
- **Never run the app against the default data dir or port on this Mac while developing**: the user's own hub runs here (the pre-rename open-bot 0.1.0: LaunchAgent `ai.openbot.hub`, port 8080, data in `~/Library/Application Support/open-bot`). Dev runs use `OWLBOT_DATA_DIR=<scratch>` with `{"port":18080}` in its `desktop.json`, and `OWLBOT_NODE_HOME=<scratch>`.
- Names after the Owlbot rename (commit f67ca09): display name `Owlbot`, `@owlbot/*`, `OWLBOT_*`, `owlbot-node`, `~/.owlbot-node`, data dir `Owlbot`, outputs `owlbot-<version>.dmg|.pkg` and `owlbot-setup-<version>-x64.exe`. No migration from the pre-rename open-bot.
- Brain detection, the login-shell PATH in the core (`packages/core/src/user-path.ts`, `setup.ts`) and the chat's setup card belong to another workstream (merged in 7a3e620): do not change them. Start Task 1 from the current `main`.
- Commit only when the user asks for commits. The "Commit" steps below describe the commit to make once they do; until then leave the changes in the working tree.
- Ask the user before installing anything (Rust targets, tools). `rustup target add x86_64-apple-darwin` is needed for the universal macOS build.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/desktop-login.ts` (new) | One-time sign-in tickets and the app's stdin commands |
| `packages/core/src/cli.ts` | `start` reads the app's stdin when `OWLBOT_DESKTOP=1` |
| `packages/core/src/app.ts` | `Hub.desktopTickets` |
| `packages/core/src/server/main-app.ts` | `POST /api/auth/desktop` |
| `packages/core/src/locales/{en,ru}.ts` | `auth.badDesktopTicket` |
| `packages/node/src/desktop.ts` (new), `packages/node/src/cli.ts` | `run` stops on the app's stdin |
| `packages/web/src/lib/desktop.ts` (new) | Ticket fragment parsing, `owlbot://pair` link |
| `packages/web/src/state/app.ts` | Uses the ticket before deciding login vs app |
| `packages/web/src/pages/Machines.tsx`, `packages/web/src/i18n/{en,ru}.ts` | "Connect with the app" link |
| `packaging/desktop/launch.mjs` | Sets `OWLBOT_DESKTOP=1`; no stdin reader of its own |
| `packaging/desktop/stage.mjs` | Excludes `packages/desktop`, drops Node's `bin/npm`/`npx` links and dangling links |
| `packaging/desktop/locales/{en,ru}.json` | App, tray and installer texts |
| `packaging/desktop/build.mjs` (new) | `npm run package:desktop`: stage, UI, `tauri build`, outputs |
| `packaging/macos/generate.mjs` | Installer pages and distribution only |
| `packaging/macos/pkg.mjs` (new) | The silent `.pkg` around the app |
| `packaging/macos/scripts/{preinstall,postinstall}`, `packaging/macos/uninstall.sh` | Package scripts |
| `packaging/windows/generate.mjs` (new) | NSIS hooks from the catalogs |
| `packages/desktop/package.json`, `ui/*` (new) | The app's setup screens |
| `packages/desktop/src-tauri/*` (new) | The Tauri app (modules listed in Task 7–10) |
| `packaging/assets/png/*` (new) | PNG icons for Tauri |
| `.github/workflows/desktop.yml`, `README.md`, `README.ru.md` | CI and docs |

Removed in Task 11: `packaging/windows/{owlbot.iss,build.mjs,tray/}`, `packaging/macos/{build.mjs,bin/}`.

---

### Task 1: Core: desktop sign-in tickets and stdin commands

**Files:**
- Create: `packages/core/src/desktop-login.ts`
- Modify: `packages/core/src/app.ts`, `packages/core/src/cli.ts`, `packages/core/src/server/main-app.ts`, `packages/core/src/locales/en.ts`, `packages/core/src/locales/ru.ts`, `packaging/desktop/launch.mjs`
- Test: `packages/core/test/desktop-login.test.ts` (new), `packages/core/test/hub.test.ts`, `packages/core/test/desktop-packaging.test.ts`

**Interfaces:**
- Produces: `class DesktopTickets { add(ticket: string): void; consume(ticket: string): boolean }`, `readDesktopCommands(input: Readable, on: { stop(): void; ticket(t: string): void }): void`, `Hub.desktopTickets: DesktopTickets`, route `POST /api/auth/desktop {ticket}` → `{ok:true}` + `ob_session` cookie, 401 `auth.badDesktopTicket`, 409 `auth.noPassword`, 403 on a foreign Origin. Tickets match `[\w-]{32,128}`. stdin lines: `stop`, `ticket <t>`; EOF stops the hub.

- [ ] **Step 1: Write the failing unit test**

`packages/core/test/desktop-login.test.ts`:

```ts
// One-time sign-in tickets of the desktop app and the commands it sends over the hub's stdin.
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { DesktopTickets, readDesktopCommands } from "../src/desktop-login.ts";

const ticket = "a".repeat(43);

describe("desktop sign-in tickets", () => {
  it("lets a ticket in once", () => {
    const tickets = new DesktopTickets();
    tickets.add(ticket);
    expect(tickets.consume(ticket)).toBe(true);
    expect(tickets.consume(ticket)).toBe(false);
  });

  it("forgets a ticket after a minute and ignores malformed ones", () => {
    let now = 1_000;
    const tickets = new DesktopTickets(() => now);
    tickets.add(ticket);
    now += 60_001;
    expect(tickets.consume(ticket)).toBe(false);
    tickets.add("short");
    expect(tickets.consume("short")).toBe(false);
  });

  it("reads the app's lines and stops when the pipe closes", async () => {
    const input = new PassThrough();
    const seen: string[] = [];
    readDesktopCommands(input, { stop: () => seen.push("stop"), ticket: (t) => seen.push(`ticket ${t}`) });
    input.write(`ticket ${ticket}\nnoise\nstop\n`);
    input.end();
    await vi.waitFor(() => expect(seen).toEqual([`ticket ${ticket}`, "stop", "stop"]));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/core/test/desktop-login.test.ts`
Expected: FAIL, `Cannot find module '../src/desktop-login.ts'`.

- [ ] **Step 3: Implement `desktop-login.ts`**

```ts
// The desktop app signs its own window in: it hands the hub one-time tickets over the hub's stdin, a pipe only the
// app that started the hub holds (OWLBOT_DESKTOP=1). The window then posts its ticket to POST /api/auth/desktop.

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

const TICKET_TTL_MS = 60_000;
const hash = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

/** One-time sign-in tickets, in memory only: a restart forgets them. */
export class DesktopTickets {
  private tickets = new Map<string, number>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  add(ticket: string): void {
    if (!/^[\w-]{32,128}$/.test(ticket)) return;
    const now = this.now();
    for (const [h, expires] of this.tickets) if (expires <= now) this.tickets.delete(h);
    this.tickets.set(hash(ticket), now + TICKET_TTL_MS);
  }

  /** True once per ticket, while it is fresh. */
  consume(ticket: string): boolean {
    const h = hash(ticket);
    const expires = this.tickets.get(h);
    this.tickets.delete(h);
    return expires !== undefined && expires > this.now();
  }
}

/**
 * The app's lines on stdin: `stop` (Windows has no SIGTERM for a windowless child) and `ticket <t>`. The app closing
 * the pipe (it quit or crashed) stops the hub too, so the hub never outlives it.
 */
export function readDesktopCommands(input: Readable, on: { stop: () => void; ticket: (t: string) => void }): void {
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    const [cmd, arg] = line.trim().split(/\s+/, 2);
    if (cmd === "stop") on.stop();
    else if (cmd === "ticket" && arg) on.ticket(arg);
  });
  lines.on("close", () => on.stop());
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run packages/core/test/desktop-login.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing integration test**

In `packages/core/test/hub.test.ts`, add right after the test `"requires setup token, session cookie, CSRF and same Origin"` (it sets the password this test needs):

```ts
  it("signs the desktop app's window in with a one-time ticket", async () => {
    const ticket = "t".repeat(43);
    hub.desktopTickets.add(ticket);
    const app = new Client(hub.config.publicUrl);
    expect((await app.raw("POST", "/api/auth/desktop", { ticket }, { origin: "https://evil.example" })).status).toBe(403);
    await app.req("POST", "/api/auth/desktop", { ticket });
    expect((await app.raw("GET", "/api/bootstrap")).status).toBe(200);
    const other = new Client(hub.config.publicUrl);
    expect((await other.raw("POST", "/api/auth/desktop", { ticket })).status).toBe(401);
    expect((await other.raw("POST", "/api/auth/desktop", { ticket: "nope" })).status).toBe(401);
  });
```

Run: `npx vitest run packages/core/test/hub.test.ts -t "desktop app"`
Expected: FAIL (`hub.desktopTickets` is undefined).

- [ ] **Step 6: Wire it into the hub**

`packages/core/src/app.ts`: add the import next to `import { AuthService } from "./auth.ts";`

```ts
import { DesktopTickets } from "./desktop-login.ts";
```

and the field next to `auth: AuthService;`:

```ts
  /** One-time sign-in tickets from the desktop app (see desktop-login.ts). */
  desktopTickets = new DesktopTickets();
```

`packages/core/src/server/main-app.ts`: after the `app.post("/api/auth/login", …)` route add:

```ts
  // The desktop app's own window: a one-time ticket the app gave the hub over its stdin (desktop-login.ts).
  app.post("/api/auth/desktop", async (req, reply) => {
    if (!originAllowed(req, origins)) throw new HttpError(403, "Origin not allowed");
    if (!hub.auth.hasPassword()) throw new AuthError(409, "auth.noPassword");
    const ticket = String((req.body as { ticket?: string })?.ticket ?? "");
    if (!hub.desktopTickets.consume(ticket)) {
      hub.audit.append("user", "auth.failure", "desktop", { ip: clientIp(req) });
      throw new AuthError(401, "auth.badDesktopTicket");
    }
    const { token } = hub.auth.createSession("main");
    hub.audit.append("user", "auth.desktop");
    setCookie(reply, token);
    return { ok: true };
  });
```

`packages/core/src/locales/en.ts`, next to `"auth.badSetupToken"`:

```ts
  "auth.badDesktopTicket": "This sign-in link has expired. Sign in with your password.",
```

`packages/core/src/locales/ru.ts`, same place:

```ts
  "auth.badDesktopTicket": "Ссылка для входа устарела. Войдите с паролем.",
```

`packages/core/src/cli.ts`: add `import { readDesktopCommands } from "./desktop-login.ts";` after the `Hub` import, and in `case "start"` after `process.on("SIGTERM", …)`:

```ts
      // Run by the desktop app: its stdin carries `stop` and sign-in tickets; closing it stops the hub.
      if (process.env.OWLBOT_DESKTOP === "1") readDesktopCommands(process.stdin, { stop: () => void shutdown("stop"), ticket: (t) => hub.desktopTickets.add(t) });
```

- [ ] **Step 7: Move the stdin reader out of `launch.mjs`**

In `packaging/desktop/launch.mjs`:
- header comment: replace the line `// A "stop" line on stdin stops the hub cleanly: a windowless child on Windows gets no SIGTERM.` with `// The desktop app talks to the hub over its stdin (OWLBOT_DESKTOP=1, read by the core: packages/core/src/desktop-login.ts).`
- delete `import { createInterface } from "node:readline";`
- in `hubEnv`, add `OWLBOT_DESKTOP: "1",` right after `OWLBOT_INSTALL_CLIS: "1",`
- in `run()`, delete the block

```js
  if (!process.stdin.isTTY) {
    createInterface({ input: process.stdin }).on("line", (line) => {
      if (line.trim() === "stop") process.emit("SIGTERM", "SIGTERM");
    });
  }
```

In `packages/core/test/desktop-packaging.test.ts`, test `"gives the hub its settings without overriding the caller's, and loads the resolve hook once"`, add after the `OWLBOT_INSTALL_CLIS` expectation:

```ts
    expect(env.OWLBOT_DESKTOP).toBe("1");
```

- [ ] **Step 8: Run the tests and the typecheck**

Run: `npx vitest run packages/core/test/desktop-login.test.ts packages/core/test/hub.test.ts packages/core/test/desktop-packaging.test.ts packages/core/test/i18n.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/desktop-login.ts packages/core/src/app.ts packages/core/src/cli.ts packages/core/src/server/main-app.ts packages/core/src/locales/en.ts packages/core/src/locales/ru.ts packaging/desktop/launch.mjs packages/core/test/desktop-login.test.ts packages/core/test/hub.test.ts packages/core/test/desktop-packaging.test.ts
git commit -m "Desktop app sign-in: one-time tickets over the hub's stdin"
```

---

### Task 2: Machine daemon stops on the app's stdin

**Files:**
- Create: `packages/node/src/desktop.ts`
- Modify: `packages/node/src/cli.ts`
- Test: `packages/node/test/desktop.test.ts` (new)

**Interfaces:**
- Produces: `stopOnDesktopStdin(input: Readable, stop: () => void): void`; `owlbot-node run` with `OWLBOT_DESKTOP=1` stops on a `stop` line or EOF.

- [ ] **Step 1: Write the failing test**

`packages/node/test/desktop.test.ts`:

```ts
// The desktop app stops the machine daemon through its stdin.
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { stopOnDesktopStdin } from "../src/desktop.ts";

describe("desktop stdin", () => {
  it("stops on a stop line and when the pipe closes", async () => {
    const input = new PassThrough();
    const stop = vi.fn();
    stopOnDesktopStdin(input, stop);
    input.write("hello\nstop\n");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    input.end();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  });
});
```

Run: `npx vitest run packages/node/test/desktop.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement it**

`packages/node/src/desktop.ts`:

```ts
// Run by the desktop app (OWLBOT_DESKTOP=1): a `stop` line on stdin, or the app closing the pipe, stops the daemon.
// Windows has no SIGTERM for a windowless child.

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export function stopOnDesktopStdin(input: Readable, stop: () => void): void {
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    if (line.trim() === "stop") stop();
  });
  lines.on("close", stop);
}
```

In `packages/node/src/cli.ts`, add `import { stopOnDesktopStdin } from "./desktop.ts";` after the `messages.ts` import, and in `cmdRun()` after `process.on("SIGHUP", …)`:

```ts
  if (process.env.OWLBOT_DESKTOP === "1") stopOnDesktopStdin(process.stdin, () => void shutdown("stop"));
```

- [ ] **Step 3: Run the tests, the typecheck and the bundle**

Run: `npx vitest run packages/node/test && npm run typecheck && npm run build:node`
Expected: PASS; `packages/node/dist/owlbot-node.mjs` rebuilt.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/desktop.ts packages/node/src/cli.ts packages/node/test/desktop.test.ts
git commit -m "owlbot-node run stops on the desktop app's stdin"
```

---

### Task 3: Web: sign in from `#desktop=`, link to the app on the Machines page

**Files:**
- Create: `packages/web/src/lib/desktop.ts`
- Modify: `packages/web/src/state/app.ts`, `packages/web/src/pages/Machines.tsx`, `packages/web/src/i18n/en.ts`, `packages/web/src/i18n/ru.ts`
- Test: `packages/web/src/lib/desktop.test.ts` (new)

**Interfaces:**
- Consumes: `POST /api/auth/desktop {ticket}` (Task 1).
- Produces: `desktopTicketFrom(hash: string): string | undefined`, `pairLink(hubUrl: string, code: string): string` (`owlbot://pair?hub=…&code=…`, parsed by the app in Task 7).

- [ ] **Step 1: Write the failing test**

`packages/web/src/lib/desktop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { desktopTicketFrom, pairLink } from "./desktop";

describe("desktop app links", () => {
  it("reads a sign-in ticket from the address fragment", () => {
    const t = "A1_-".repeat(11);
    expect(desktopTicketFrom(`#desktop=${t}`)).toBe(t);
    expect(desktopTicketFrom("#desktop=short")).toBeUndefined();
    expect(desktopTicketFrom("#setup=abcdefgh")).toBeUndefined();
    expect(desktopTicketFrom("")).toBeUndefined();
  });

  it("builds the pairing link the app opens", () => {
    expect(pairLink("https://bot.example.com", "AB12CD34")).toBe("owlbot://pair?hub=https%3A%2F%2Fbot.example.com&code=AB12CD34");
  });
});
```

Run: `npx vitest run packages/web/src/lib/desktop.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement `lib/desktop.ts`**

```ts
// The desktop app (packages/desktop) opens its window at `/#desktop=<ticket>`, a one-time sign-in ticket (see
// packages/core/src/desktop-login.ts), and connects its computer to a hub from an `owlbot://pair` link.

/** The sign-in ticket in an address fragment, if any. */
export function desktopTicketFrom(hash: string): string | undefined {
  return /^#desktop=([\w-]{32,128})$/.exec(hash)?.[1];
}

/** The link that makes the desktop app connect its computer to this hub as a machine. */
export function pairLink(hubUrl: string, code: string): string {
  return `owlbot://pair?${new URLSearchParams({ hub: hubUrl, code })}`;
}
```

- [ ] **Step 3: Use the ticket in `init()`**

In `packages/web/src/state/app.ts` add `import { desktopTicketFrom } from "../lib/desktop";` after the `../lib/messages` import, and above `export async function init()`:

```ts
/** The desktop app's one-time sign-in ticket: read once when the page loads, then dropped from the address bar. */
let desktopTicket = (() => {
  const ticket = desktopTicketFrom(window.location.hash);
  if (ticket) history.replaceState(null, "", window.location.pathname + window.location.search);
  return ticket;
})();
```

In `init()`, between `phase.set({ kind: "loading" });` and `try {`, insert:

```ts
  const ticket = desktopTicket;
  desktopTicket = undefined;
  // A used or expired ticket just leaves the usual sign-in form.
  if (ticket) await request("POST", "/api/auth/desktop", { ticket }).catch(() => undefined);
```

- [ ] **Step 4: Add the link on the Machines page**

`packages/web/src/i18n/en.ts`, after `"machines.step2"`:

```ts
  "machines.orApp": "Is the Owlbot app installed on that computer?",
  "machines.openInApp": "Connect with the app",
```

`packages/web/src/i18n/ru.ts`, after `"machines.step2"`:

```ts
  "machines.orApp": "На том компьютере стоит приложение Owlbot?",
  "machines.openInApp": "Подключить через приложение",
```

`packages/web/src/pages/Machines.tsx`: add `import { pairLink } from "../lib/desktop";` after the `../lib/format` import, and right after the `<div>` that holds `machines.step2` and `<CodeLine>npx owlbot-node run</CodeLine>`:

```tsx
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="text-muted">{t("machines.orApp")}</span>
            <a className="font-medium text-accent-text hover:underline" href={pairLink(pairing.hubUrl, pairing.code)}>
              {t("machines.openInApp")}
            </a>
          </div>
```

- [ ] **Step 5: Run the tests, the typecheck and the build**

Run: `npx vitest run packages/web/src && npm run typecheck -w @owlbot/web && npm run build -w @owlbot/web`
Expected: PASS (`desktop.test.ts` and `i18n.test.ts`), typecheck clean, Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/desktop.ts packages/web/src/lib/desktop.test.ts packages/web/src/state/app.ts packages/web/src/pages/Machines.tsx packages/web/src/i18n/en.ts packages/web/src/i18n/ru.ts
git commit -m "Web UI: desktop app sign-in ticket and a Connect with the app link"
```

---

### Task 4: Stage the hub for the app

**Files:**
- Modify: `packaging/desktop/stage.mjs`
- Test: `packages/core/test/desktop-packaging.test.ts`

**Interfaces:**
- Produces: `export function wanted(src: string): boolean`, `export function removeDanglingLinks(dir: string): number` (already in the working tree from the earlier attempt; keep it).

- [ ] **Step 1: Write the failing test**

In `packages/core/test/desktop-packaging.test.ts`, change the stage import to `import { removeDanglingLinks, wanted } from "../../../packaging/desktop/stage.mjs";` (keep the `// @ts-ignore` above it) and add to `describe("desktop launcher")`:

```ts
  it("stages the hub without the desktop app's own sources", () => {
    expect(wanted(join(ROOT, "packages", "core", "src", "cli.ts"))).toBe(true);
    expect(wanted(join(ROOT, "packages", "desktop", "package.json"))).toBe(true);
    expect(wanted(join(ROOT, "packages", "desktop", "src-tauri", "target", "release", "owlbot"))).toBe(false);
    expect(wanted(join(ROOT, "packages", "desktop", "ui", "src", "main.ts"))).toBe(false);
    expect(wanted(join(ROOT, "packages", "core", "test", "hub.test.ts"))).toBe(false);
  });
```

Keep the `"drops links whose target is gone, keeps the others"` test.

Run: `npx vitest run packages/core/test/desktop-packaging.test.ts`
Expected: FAIL (`wanted` is not exported).

- [ ] **Step 2: Implement**

In `packaging/desktop/stage.mjs`:
- `function wanted(src)` becomes `export function wanted(src)`; after the line `if (top === "plugins" && sub === "ui" && parts[3] === "src") return false;` add:

```js
  // The desktop app is built around the stage; its manifest stays so `npm ci` finds the workspace.
  if (top === "packages" && pkg === "desktop" && sub && sub !== "package.json") return false;
```

- in `extract()`, the list after `// Not needed to run the hub or npm.` gains `join("bin", "npm"), join("bin", "npx")` (links into lib/node_modules/npm that a bundler would copy as broken files; the hub runs npm through npm-cli.js, see packages/core/src/cli-tools.ts). Update that comment to:

```js
  // Not needed to run the hub or npm (the hub calls npm-cli.js directly: packages/core/src/cli-tools.ts). bin/npm and
  // bin/npx are links, which the Tauri bundler would copy as broken files.
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run packages/core/test/desktop-packaging.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packaging/desktop/stage.mjs packages/core/test/desktop-packaging.test.ts
git commit -m "Stage: leave the desktop app out, drop Node's bin links and dangling links"
```

---

### Task 5: App and tray texts in the installer catalogs

**Files:**
- Modify: `packaging/desktop/locales/en.json`, `packaging/desktop/locales/ru.json`
- Test: `packages/core/test/i18n.test.ts` (existing parity test)

**Interfaces:**
- Produces keys used by Tasks 6–10: `tray.status.{starting,running,restarting,failed,portBusy,stopped,node}`, `tray.setupAgain`, `app.welcome.*`, `app.pair.*`, `app.link.*`, `app.error.*`; existing `tray.open`, `tray.autostart`, `tray.logs`, `tray.restart`, `tray.quit`, `tray.starting` stay.

- [ ] **Step 1: Add the keys**

Append to `packaging/desktop/locales/en.json` (before the closing brace; keep valid JSON):

```json
  "tray.status.starting": "Starting…",
  "tray.status.running": "Running",
  "tray.status.restarting": "Restarting…",
  "tray.status.failed": "Stopped: it kept crashing",
  "tray.status.portBusy": "Port {port} is taken",
  "tray.status.stopped": "Stopped",
  "tray.status.node": "Machine of {hub}",
  "tray.setupAgain": "Set up again…",
  "app.welcome.title": "How will you use this computer?",
  "app.welcome.hub.title": "A new Owlbot on this computer",
  "app.welcome.hub.body": "Your agent runs here. Chats, agents and the vault stay on this computer.",
  "app.welcome.node.title": "Connect to my Owlbot",
  "app.welcome.node.body": "Your Owlbot already runs elsewhere. This computer becomes one of its machines: agents can use its Claude Code, Codex and the folders you allow.",
  "app.pair.title": "Connect this computer",
  "app.pair.hub": "Hub address",
  "app.pair.hubHint": "The address you open Owlbot at.",
  "app.pair.code": "Code",
  "app.pair.codeHint": "On the hub's Machines page choose Connect a machine and copy the code.",
  "app.pair.name": "Machine name",
  "app.pair.submit": "Connect",
  "app.pair.back": "Back",
  "app.pair.useExisting": "Use the existing connection to {hub}",
  "app.link.title": "Connect to {hub}?",
  "app.link.body": "This computer becomes a machine of {hub}.",
  "app.link.hubMode": "This computer runs its own Owlbot now. It stops, and its data stays here: Set up again… in the menu brings it back.",
  "app.link.cancel": "Cancel",
  "app.error.title": "Owlbot did not start",
  "app.error.notStarted": "Owlbot did not answer in time. Show the log to see why, or try again.",
  "app.error.failed": "Owlbot keeps stopping. Show the log to see why, or try again.",
  "app.error.portBusy": "Port {port} is taken by another program, so Owlbot cannot start. Close that program and try again.",
  "app.error.noRuntime": "Owlbot's files are damaged. Install Owlbot again.",
  "app.error.retry": "Try again"
```

Append to `packaging/desktop/locales/ru.json`:

```json
  "tray.status.starting": "Запускается…",
  "tray.status.running": "Работает",
  "tray.status.restarting": "Перезапускается…",
  "tray.status.failed": "Остановлен: снова и снова падал",
  "tray.status.portBusy": "Порт {port} занят",
  "tray.status.stopped": "Остановлен",
  "tray.status.node": "Машина хаба {hub}",
  "tray.setupAgain": "Настроить заново…",
  "app.welcome.title": "Как вы будете пользоваться этим компьютером?",
  "app.welcome.hub.title": "Новый Owlbot на этом компьютере",
  "app.welcome.hub.body": "Ваш агент работает здесь. Чаты, агенты и хранилище секретов остаются на этом компьютере.",
  "app.welcome.node.title": "Подключить к моему Owlbot",
  "app.welcome.node.body": "Ваш Owlbot уже работает в другом месте. Этот компьютер станет одной из его машин: агенты смогут пользоваться его Claude Code, Codex и папками, которые вы разрешите.",
  "app.pair.title": "Подключить этот компьютер",
  "app.pair.hub": "Адрес хаба",
  "app.pair.hubHint": "Адрес, по которому вы открываете Owlbot.",
  "app.pair.code": "Код",
  "app.pair.codeHint": "На странице «Машины» хаба нажмите «Подключить машину» и скопируйте код.",
  "app.pair.name": "Имя машины",
  "app.pair.submit": "Подключить",
  "app.pair.back": "Назад",
  "app.pair.useExisting": "Использовать готовое подключение к {hub}",
  "app.link.title": "Подключиться к {hub}?",
  "app.link.body": "Этот компьютер станет машиной хаба {hub}.",
  "app.link.hubMode": "Сейчас на этом компьютере работает свой Owlbot. Он остановится, а его данные останутся здесь: «Настроить заново…» в меню вернёт его.",
  "app.link.cancel": "Отмена",
  "app.error.title": "Owlbot не запустился",
  "app.error.notStarted": "Owlbot не ответил вовремя. Откройте журнал, чтобы узнать причину, или попробуйте ещё раз.",
  "app.error.failed": "Owlbot снова и снова останавливается. Откройте журнал, чтобы узнать причину, или попробуйте ещё раз.",
  "app.error.portBusy": "Порт {port} занят другой программой, поэтому Owlbot не может запуститься. Закройте эту программу и попробуйте ещё раз.",
  "app.error.noRuntime": "Файлы Owlbot повреждены. Установите Owlbot заново.",
  "app.error.retry": "Попробовать ещё раз"
```

- [ ] **Step 2: Run the parity test**

Run: `npx vitest run packages/core/test/i18n.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packaging/desktop/locales/en.json packaging/desktop/locales/ru.json
git commit -m "Desktop app texts: tray status, first run, pairing, errors"
```

---

### Task 6: The app's setup screens (`packages/desktop/ui`)

**Files:**
- Create: `packages/desktop/package.json`, `packages/desktop/ui/index.html`, `packages/desktop/ui/style.css`, `packages/desktop/ui/src/main.ts`, `packages/desktop/ui/build.mjs`, `packages/desktop/ui/tsconfig.json`
- Modify: `package-lock.json` (npm install), `.gitignore`

**Interfaces:**
- Consumes (Tauri commands of Task 10, window `setup` only): `get_state() -> UiState`, `choose_hub()`, `pair({hub, code, name})`, `use_existing_node()`, `open_log()`, `retry()`, `dismiss()`. Errors arrive as rejected promises with the message string.
- `UiState` (camelCase JSON): `{ lang: "en"|"ru", mode: "hub"|"node"|null, starting: boolean, existing: {hub, name}|null, link: {hub, code}|null, error: {key, port}|null, hostname: string }`.

- [ ] **Step 1: Package manifest and dependencies**

`packages/desktop/package.json`:

```json
{
  "name": "@owlbot/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Owlbot desktop app (Tauri): a window for the hub's UI, a tray icon, the hub or a machine in the background",
  "scripts": {
    "build:ui": "node ui/build.mjs",
    "typecheck": "tsc -p ui/tsconfig.json",
    "tauri": "tauri"
  },
  "devDependencies": {
    "@tauri-apps/api": "^2.12.4",
    "@tauri-apps/cli": "^2.12.4"
  }
}
```

Run: `npm install`
Expected: `package-lock.json` gains `packages/desktop` and the two packages.

Append to `.gitignore`:

```
packages/desktop/src-tauri/target/
packages/desktop/src-tauri/gen/
```

- [ ] **Step 2: Page, styles, build and tsconfig**

`packages/desktop/ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Owlbot</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="main.js"></script>
  </body>
</html>
```

`packages/desktop/ui/style.css`:

```css
:root {
  color-scheme: light dark;
  --bg: #f7f6f2;
  --surface: #ffffff;
  --border: #dedad0;
  --text: #1f1d1a;
  --muted: #6b665c;
  --accent: #2f6f62;
  --accent-text: #ffffff;
  --danger: #b3261e;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1b1a18; --surface: #252421; --border: #3a3833; --text: #ece9e2; --muted: #a39d92; --accent: #6fb8a6; --accent-text: #10201c; --danger: #f2b8b5; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
main { display: flex; flex-direction: column; gap: 14px; padding: 28px; }
h1 { margin: 0 0 4px; font-size: 19px; font-weight: 600; }
p { margin: 0; }
.muted { color: var(--muted); }
.error { color: var(--danger); white-space: pre-wrap; min-height: 1em; }
.choice { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: inherit; font: inherit; cursor: pointer; }
.choice:hover { border-color: var(--accent); }
.choice strong { font-size: 15px; }
.choice span { color: var(--muted); }
form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field small { color: var(--muted); }
input { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: inherit; font: inherit; }
.row { display: flex; gap: 8px; justify-content: flex-end; }
button.primary, button.secondary, button.link { padding: 8px 14px; border-radius: 8px; font: inherit; cursor: pointer; }
button.primary { border: 0; background: var(--accent); color: var(--accent-text); }
button.secondary { border: 1px solid var(--border); background: var(--surface); color: inherit; }
button.link { border: 0; background: none; color: var(--accent); padding: 4px 0; text-align: left; }
button:disabled, input:disabled { opacity: 0.6; cursor: default; }
```

`packages/desktop/ui/build.mjs`:

```js
// Builds the app's own screens into ui/dist (Tauri's frontendDist): the bundled script, the page and its styles.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const out = join(here, "dist");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  legalComments: "none",
  logLevel: "warning",
});
for (const f of ["index.html", "style.css"]) copyFileSync(join(here, f), join(out, f));
```

`packages/desktop/ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2022", "dom"],
    "strict": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src"]
}
```

- [ ] **Step 3: The screens**

`packages/desktop/ui/src/main.ts`:

```ts
// The app's own screens (window "setup"): how this computer is used, connecting it to a hub (also from an
// owlbot://pair link), "starting" and "did not start". The hub's UI opens in its own window and gets no app commands.

import { invoke } from "@tauri-apps/api/core";
import en from "../../../../packaging/desktop/locales/en.json";
import ru from "../../../../packaging/desktop/locales/ru.json";

type Mode = "hub" | "node";
interface UiState {
  lang: "en" | "ru";
  mode: Mode | null;
  starting: boolean;
  existing: { hub: string; name: string } | null;
  link: { hub: string; code: string } | null;
  error: { key: string; port: number | null } | null;
  hostname: string;
}

const catalogs: Record<string, Record<string, string>> = { en, ru };
let lang = "en";

/** A catalog text in the app's language, English when it has none; `{name}` placeholders from `params`. */
function t(key: string, params: Record<string, string | number> = {}): string {
  const s = catalogs[lang]?.[key] ?? catalogs.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

type Child = Node | string | null | false | undefined;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c) e.append(c);
  return e;
}

function show(...children: Child[]): void {
  document.getElementById("root")!.replaceChildren(h("main", {}, ...children));
}

function button(text: string, onClick: () => void, kind = "secondary"): HTMLButtonElement {
  const b = h("button", { type: "button", class: kind }, text) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

function input(value: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const i = h("input", { spellcheck: "false", ...attrs }) as HTMLInputElement;
  i.value = value;
  return i;
}

function field(label: string, control: HTMLInputElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control, hint && h("small", {}, hint));
}

/** Runs an app command with the screen's controls disabled; a failure shows its text in `note`. */
async function run(note: HTMLElement, cmd: string, args: Record<string, unknown> = {}): Promise<void> {
  const controls = [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
  controls.forEach((c) => (c.disabled = true));
  note.textContent = "";
  try {
    await invoke(cmd, args);
  } catch (e) {
    note.textContent = String(e);
    controls.forEach((c) => (c.disabled = false));
  }
}

function choice(title: string, body: string, onClick: () => void): HTMLElement {
  const b = h("button", { type: "button", class: "choice" }, h("strong", {}, title), h("span", {}, body));
  b.addEventListener("click", onClick);
  return b;
}

function welcome(state: UiState): void {
  const note = h("p", { class: "error" });
  show(
    h("h1", {}, t("app.welcome.title")),
    choice(t("app.welcome.hub.title"), t("app.welcome.hub.body"), () => void run(note, "choose_hub")),
    choice(t("app.welcome.node.title"), t("app.welcome.node.body"), () => pairForm(state)),
    state.existing && button(t("app.pair.useExisting", { hub: state.existing.hub }), () => void run(note, "use_existing_node"), "link"),
    note,
  );
}

/** Hub address, code and machine name; prefilled from an owlbot://pair link. */
function pairForm(state: UiState, link?: { hub: string; code: string }): void {
  const hub = input(link?.hub ?? "", { type: "url", placeholder: "https://bot.example.com", required: "" });
  const code = input(link?.code ?? "", { autocomplete: "one-time-code", required: "" });
  const name = input(state.hostname, { maxlength: "60" });
  const note = h("p", { class: "error" });
  const form = h(
    "form",
    {},
    link ? null : field(t("app.pair.hub"), hub, t("app.pair.hubHint")),
    link ? null : field(t("app.pair.code"), code, t("app.pair.codeHint")),
    field(t("app.pair.name"), name),
    note,
    h(
      "div",
      { class: "row" },
      link ? button(t("app.link.cancel"), () => void invoke("dismiss")) : button(t("app.pair.back"), () => welcome(state)),
      h("button", { type: "submit", class: "primary" }, t("app.pair.submit")),
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void run(note, "pair", { hub: hub.value, code: code.value, name: name.value });
  });
  if (link) {
    show(h("h1", {}, t("app.link.title", { hub: link.hub })), h("p", { class: "muted" }, t("app.link.body", { hub: link.hub })), state.mode === "hub" && h("p", {}, t("app.link.hubMode")), form);
  } else {
    show(h("h1", {}, t("app.pair.title")), form);
  }
  (link ? name : hub).focus();
}

function errorScreen(state: UiState, error: NonNullable<UiState["error"]>): void {
  const note = h("p", { class: "error" });
  show(
    h("h1", {}, t("app.error.title")),
    h("p", {}, t(error.key, { port: error.port ?? "" })),
    note,
    h("div", { class: "row" }, button(t("tray.logs"), () => void invoke("open_log")), state.mode ? button(t("app.error.retry"), () => void run(note, "retry"), "primary") : null),
  );
}

async function render(): Promise<void> {
  const state = await invoke<UiState>("get_state");
  lang = state.lang;
  document.documentElement.lang = lang;
  if (state.error) errorScreen(state, state.error);
  else if (state.link) pairForm(state, state.link);
  else if (state.starting) {
    show(h("h1", {}, t("tray.starting")));
    setTimeout(() => void render(), 1000);
  } else welcome(state);
}

void render();
```

- [ ] **Step 4: Build and typecheck**

Run: `npm run build:ui -w @owlbot/desktop && npm run typecheck -w @owlbot/desktop && ls packages/desktop/ui/dist`
Expected: no errors; `index.html main.js style.css`.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/package.json packages/desktop/ui package-lock.json .gitignore
git commit -m "Desktop app: setup screens (first run, pairing, errors)"
```

---

### Task 7: Tauri scaffold, icons and the app's pure modules

**Files:**
- Create: `packages/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/setup.json}`, `packages/desktop/src-tauri/src/{main.rs,settings.rs,deeplink.rs,i18n.rs,login.rs}`, `packaging/assets/png/{32x32.png,128x128.png,128x128@2x.png,icon.png}`
- Modify: `packaging/desktop/make-icons.mjs`
- Test: `cargo test` (unit tests inside the modules)

**Interfaces:**
- Produces:
  - `settings::Mode { Hub, Node }` (serde lowercase), `Mode::parse(&str) -> Option<Mode>`, `settings::Settings { mode: Option<Mode>, autostart: bool }` (default `autostart = true`), `settings::load(&Path) -> Settings`, `settings::save(&Path, &Settings) -> io::Result<()>`, `settings::Existing { hub: String, name: String }`, `settings::existing_node(home: &Path) -> Option<Existing>`.
  - `deeplink::PairLink { hub: String, code: String }`, `deeplink::parse(&Url) -> Option<PairLink>`.
  - `i18n::Texts` with `for_locale(Option<&str>) -> Texts`, `lang() -> &'static str`, `t(&str) -> String`, `f(&str, &[(&str, &str)]) -> String`; `i18n::texts() -> &'static Texts`.
  - `login::new_ticket() -> String` (43 chars, base64url), `login::with_ticket(base: &str, ticket: &str) -> String`.

- [ ] **Step 1: Icons**

```bash
S=$(mktemp -d)
iconutil -c iconset packaging/assets/owlbot.icns -o "$S/owlbot.iconset"
mkdir -p packaging/assets/png
cp "$S/owlbot.iconset/icon_32x32.png" packaging/assets/png/32x32.png
cp "$S/owlbot.iconset/icon_128x128.png" packaging/assets/png/128x128.png
cp "$S/owlbot.iconset/icon_128x128@2x.png" packaging/assets/png/128x128@2x.png
cp "$S/owlbot.iconset/icon_512x512.png" packaging/assets/png/icon.png
```

In `packaging/desktop/make-icons.mjs` (renders the same favicon, so future logo changes keep these in sync): change the header comment's first line to `// Renders the web UI's favicon into the desktop icons: packaging/assets/owlbot.ico (Windows, PNG entries),` / `// Owlbot.icns (macOS) and png/ (Tauri bundle icons). Run by hand when the logo changes; the outputs are committed so` / `// builds need no browser.`, and before `console.log(...)` add:

```js
// PNGs for the Tauri bundle (tauri.conf.json "bundle.icon"; the tray uses the app icon).
mkdirSync(join(out, "png"), { recursive: true });
for (const [file, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512]]) writeFileSync(join(out, "png", file), png[size]);
```

- [ ] **Step 2: Cargo manifest, build script, config, capability**

`packages/desktop/src-tauri/Cargo.toml`:

```toml
[package]
name = "owlbot"
version = "0.1.0"
description = "Owlbot desktop app"
edition = "2021"
rust-version = "1.85"
publish = false

[build-dependencies]
tauri-build = { version = "2.7", features = [] }

[dependencies]
tauri = { version = "2.12", features = ["tray-icon"] }
tauri-plugin-single-instance = { version = "2.5", features = ["deep-link"] }
tauri-plugin-deep-link = "2.6"
tauri-plugin-opener = "2.7"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sys-locale = "0.3"
getrandom = "0.3"
base64 = "0.22"

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[target.'cfg(windows)'.dependencies]
win32job = "2"
winreg = "0.56"

[profile.release]
codegen-units = 1
lto = true
strip = true
```

`packages/desktop/src-tauri/build.rs`:

```rust
// App commands are allowed only where a capability grants them: capabilities/setup.json gives them to the setup
// window; the hub's page in the main window gets none.
fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
    "get_state",
    "choose_hub",
    "pair",
    "use_existing_node",
    "open_log",
    "retry",
    "dismiss",
  ])))
  .expect("tauri-build failed");
}
```

`packages/desktop/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Owlbot",
  "mainBinaryName": "Owlbot",
  "version": "../../../package.json",
  "identifier": "ai.owlbot.app",
  "build": {
    "frontendDist": "../ui/dist"
  },
  "app": {
    "windows": [],
    "security": {
      "csp": "default-src 'self'; connect-src ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg", "nsis"],
    "icon": [
      "../../../packaging/assets/png/32x32.png",
      "../../../packaging/assets/png/128x128.png",
      "../../../packaging/assets/png/128x128@2x.png",
      "../../../packaging/assets/png/icon.png",
      "../../../packaging/assets/owlbot.icns",
      "../../../packaging/assets/owlbot.ico"
    ],
    "macOS": {
      "minimumSystemVersion": "13.5",
      "signingIdentity": "-"
    },
    "windows": {
      "nsis": {
        "installMode": "currentUser",
        "languages": ["English", "Russian"],
        "displayLanguageSelector": false
      }
    }
  },
  "plugins": {
    "deep-link": {
      "desktop": { "schemes": ["owlbot"] }
    }
  }
}
```

`packages/desktop/src-tauri/capabilities/setup.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "setup",
  "description": "The app's own setup screens. The hub's page in the main window gets no app commands.",
  "windows": ["setup"],
  "permissions": [
    "allow-get-state",
    "allow-choose-hub",
    "allow-pair",
    "allow-use-existing-node",
    "allow-open-log",
    "allow-retry",
    "allow-dismiss"
  ]
}
```

- [ ] **Step 3: Write the pure modules with their tests**

`packages/desktop/src-tauri/src/settings.rs`:

```rust
//! The app's own settings (<app config dir>/settings.json; no file means the first run) and the machine daemon's
//! pairing in ~/.owlbot-node, written by `owlbot-node pair`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
  /// The hub runs on this computer.
  Hub,
  /// This computer is a machine of another hub.
  Node,
}

impl Mode {
  pub fn parse(s: &str) -> Option<Mode> {
    match s {
      "hub" => Some(Mode::Hub),
      "node" => Some(Mode::Node),
      _ => None,
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
  #[serde(default)]
  pub mode: Option<Mode>,
  /// Start at login: on by default; applied at every start, so an upgrade that dropped the entry gets it back.
  #[serde(default = "on")]
  pub autostart: bool,
}

fn on() -> bool {
  true
}

impl Default for Settings {
  fn default() -> Self {
    Settings { mode: None, autostart: true }
  }
}

pub fn file(config_dir: &Path) -> PathBuf {
  config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> Settings {
  fs::read_to_string(file(config_dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(config_dir: &Path, settings: &Settings) -> io::Result<()> {
  fs::create_dir_all(config_dir)?;
  let tmp = config_dir.join("settings.json.tmp");
  fs::write(&tmp, serde_json::to_vec_pretty(settings).map_err(io::Error::other)?)?;
  fs::rename(tmp, file(config_dir))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Existing {
  pub hub: String,
  pub name: String,
}

/// The pairing in <node home>/config.json ({hubUrl, machineId, name}), if this computer is paired.
pub fn existing_node(home: &Path) -> Option<Existing> {
  let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(home.join("config.json")).ok()?).ok()?;
  Some(Existing {
    hub: v.get("hubUrl")?.as_str()?.to_string(),
    name: v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("owl-settings-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
  }

  #[test]
  fn first_run_has_no_mode_and_autostart_on() {
    assert_eq!(load(&dir("none")), Settings { mode: None, autostart: true });
  }

  #[test]
  fn saves_and_loads() {
    let d = dir("roundtrip");
    save(&d, &Settings { mode: Some(Mode::Node), autostart: false }).unwrap();
    assert_eq!(load(&d), Settings { mode: Some(Mode::Node), autostart: false });
    assert!(fs::read_to_string(file(&d)).unwrap().contains("\"node\""));
  }

  #[test]
  fn a_broken_file_is_a_first_run() {
    let d = dir("broken");
    fs::create_dir_all(&d).unwrap();
    fs::write(file(&d), "{nope").unwrap();
    assert_eq!(load(&d).mode, None);
  }

  #[test]
  fn reads_an_existing_pairing() {
    let d = dir("node");
    assert_eq!(existing_node(&d), None);
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("config.json"), r#"{"hubUrl":"https://bot.example.com","machineId":"m1","name":"laptop"}"#).unwrap();
    assert_eq!(existing_node(&d), Some(Existing { hub: "https://bot.example.com".into(), name: "laptop".into() }));
  }

  #[test]
  fn parses_modes() {
    assert_eq!(Mode::parse("hub"), Some(Mode::Hub));
    assert_eq!(Mode::parse("node"), Some(Mode::Node));
    assert_eq!(Mode::parse("x"), None);
  }
}
```

`packages/desktop/src-tauri/src/deeplink.rs`:

```rust
//! `owlbot://pair?hub=<url>&code=<code>`: the link the hub's Machines page offers to connect this computer.

use serde::Serialize;
use tauri::Url;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairLink {
  pub hub: String,
  pub code: String,
}

pub fn parse(link: &Url) -> Option<PairLink> {
  if link.scheme() != "owlbot" {
    return None;
  }
  // owlbot://pair?… has "pair" as its host; owlbot:pair?… as its path.
  let what = link.host_str().unwrap_or_else(|| link.path()).trim_matches('/');
  if what != "pair" {
    return None;
  }
  let (mut hub, mut code) = (None, None);
  for (k, v) in link.query_pairs() {
    match k.as_ref() {
      "hub" => hub = Some(v.into_owned()),
      "code" => code = Some(v.into_owned()),
      _ => {}
    }
  }
  let (hub, code) = (hub?, code?);
  let url = Url::parse(&hub).ok()?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return None;
  }
  if code.is_empty() || code.len() > 64 || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
    return None;
  }
  Some(PairLink { hub, code })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(s: &str) -> Option<PairLink> {
    parse(&Url::parse(s).unwrap())
  }

  #[test]
  fn reads_a_pairing_link() {
    assert_eq!(
      p("owlbot://pair?hub=https%3A%2F%2Fbot.example.com&code=AB12CD34"),
      Some(PairLink { hub: "https://bot.example.com".into(), code: "AB12CD34".into() })
    );
    assert_eq!(p("owlbot:pair?hub=http://192.168.1.5:8080&code=x-1").map(|l| l.hub), Some("http://192.168.1.5:8080".into()));
  }

  #[test]
  fn refuses_anything_else() {
    assert_eq!(p("owlbot://other?hub=https://a.b&code=x"), None);
    assert_eq!(p("owlbot://pair?hub=file:///etc/passwd&code=x"), None);
    assert_eq!(p("owlbot://pair?hub=https://a.b"), None);
    assert_eq!(p("owlbot://pair?hub=https://a.b&code=a%20b"), None);
    assert_eq!(p("https://pair?hub=https://a.b&code=x"), None);
  }
}
```

`packages/desktop/src-tauri/src/i18n.rs`:

```rust
//! The app's texts from packaging/desktop/locales (shared with the installers). English is the source of truth and
//! the fallback; the system language picks Russian.

use std::collections::HashMap;
use std::sync::OnceLock;

const EN: &str = include_str!("../../../../packaging/desktop/locales/en.json");
const RU: &str = include_str!("../../../../packaging/desktop/locales/ru.json");

pub struct Texts {
  lang: &'static str,
  en: HashMap<String, String>,
  own: HashMap<String, String>,
}

impl Texts {
  pub fn for_locale(locale: Option<&str>) -> Texts {
    let lang = match locale {
      Some(l) if l.to_ascii_lowercase().starts_with("ru") => "ru",
      _ => "en",
    };
    let parse = |s: &str| serde_json::from_str::<HashMap<String, String>>(s).expect("installer catalog");
    Texts { lang, en: parse(EN), own: if lang == "ru" { parse(RU) } else { HashMap::new() } }
  }

  pub fn lang(&self) -> &'static str {
    self.lang
  }

  pub fn t(&self, key: &str) -> String {
    self.own.get(key).or_else(|| self.en.get(key)).cloned().unwrap_or_else(|| key.to_string())
  }

  /// `t` with `{name}` placeholders filled in.
  pub fn f(&self, key: &str, params: &[(&str, &str)]) -> String {
    params.iter().fold(self.t(key), |s, (k, v)| s.replace(&format!("{{{k}}}"), v))
  }
}

pub fn texts() -> &'static Texts {
  static TEXTS: OnceLock<Texts> = OnceLock::new();
  TEXTS.get_or_init(|| Texts::for_locale(sys_locale::get_locale().as_deref()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn picks_the_language_and_falls_back_to_english() {
    let ru = Texts::for_locale(Some("ru-RU"));
    assert_eq!(ru.lang(), "ru");
    assert_eq!(ru.t("tray.quit"), "Выйти из Owlbot");
    let en = Texts::for_locale(Some("de-DE"));
    assert_eq!(en.lang(), "en");
    assert_eq!(en.t("tray.quit"), "Quit Owlbot");
    assert_eq!(en.t("no.such.key"), "no.such.key");
  }

  #[test]
  fn fills_placeholders() {
    assert_eq!(Texts::for_locale(Some("en")).f("tray.status.portBusy", &[("port", "8080")]), "Port 8080 is taken");
  }
}
```

`packages/desktop/src-tauri/src/login.rs`:

```rust
//! One-time sign-in tickets for the hub window: the app writes `ticket <t>` to the hub's stdin and opens
//! `<hub>/#desktop=<t>` (packages/core/src/desktop-login.ts, packages/web/src/lib/desktop.ts).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// 32 random bytes, base64url: 43 characters of [A-Za-z0-9_-].
pub fn new_ticket() -> String {
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes).expect("system random generator");
  URL_SAFE_NO_PAD.encode(bytes)
}

/// `base` without its fragment, plus `#desktop=<ticket>`.
pub fn with_ticket(base: &str, ticket: &str) -> String {
  let base = base.split('#').next().unwrap_or(base);
  format!("{base}#desktop={ticket}")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tickets_match_what_the_hub_accepts() {
    let a = new_ticket();
    assert_eq!(a.len(), 43);
    assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert_ne!(a, new_ticket());
  }

  #[test]
  fn puts_the_ticket_in_the_fragment() {
    assert_eq!(with_ticket("http://localhost:8080/", "abc"), "http://localhost:8080/#desktop=abc");
    assert_eq!(with_ticket("http://localhost:8080/#old", "abc"), "http://localhost:8080/#desktop=abc");
  }
}
```

`packages/desktop/src-tauri/src/main.rs` (temporary; Task 10 replaces it):

```rust
// Owlbot desktop app. Spec: docs/superpowers/specs/2026-10-26-desktop-app-design.md
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deeplink;
mod i18n;
mod login;
mod settings;

fn main() {
  tauri::Builder::default().run(tauri::generate_context!()).expect("Owlbot failed to start");
}
```

- [ ] **Step 4: Build and test**

Run: `npm run build:ui -w @owlbot/desktop && cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
Expected: compiles (the first build downloads and compiles Tauri, several minutes; unused-code warnings are fine at this step); tests PASS (settings 5, deeplink 2, i18n 2, login 2).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src-tauri packaging/assets/png packaging/desktop/make-icons.mjs
git commit -m "Desktop app: Tauri scaffold, settings, pairing links, texts, sign-in tickets"
```

(`src-tauri/Cargo.lock` is committed: this is an application.)

---

### Task 8: Process supervisor

**Files:**
- Create: `packages/desktop/src-tauri/src/supervisor.rs`
- Modify: `packages/desktop/src-tauri/src/main.rs` (add `mod supervisor;`)
- Test: unit tests in `supervisor.rs` (they run `node` from the PATH as a fake child; Node 24 is on every dev machine and CI runner)

**Interfaces:**
- Produces:
  - `enum Status { Stopped, Starting, Running, Restarting, Failed, PortBusy(u16) }` (`Clone, Debug, PartialEq, Eq`)
  - `struct Spec { program: PathBuf, args: Vec<String>, env: Vec<(String, String)>, log: PathBuf, port: Option<u16>, restart_delay: Duration }`
  - `Supervisor::new(listener: impl Fn(Status) + Send + Sync + 'static) -> Supervisor` (`Clone`), `start(&self, Spec)`, `stop(&self)` (blocking, ≤ 15 s), `send_line(&self, &str) -> bool`
  - `node_binary(app_root: &Path) -> PathBuf`, `command(program: &Path) -> Command` (no console window on Windows)
  - `Crashes::new()`, `Crashes::record(&mut self, Instant) -> bool`, `rotate(log: &Path, limit: u64) -> io::Result<()>`, `port_free(u16) -> bool`

- [ ] **Step 1: Write the module with its tests**

`packages/desktop/src-tauri/src/supervisor.rs`:

```rust
//! Runs the hub (or the machine daemon) as a child process on the bundled Node and keeps it running: output to a log
//! file, a restart after a crash, no more retries when it keeps crashing (five within two minutes), a clean stop
//! through its stdin (Windows has no SIGTERM for a windowless child). The child also stops when the pipe closes, so it
//! never outlives the app; on Windows a job object ends what it started, on macOS its process group.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
  Stopped,
  Starting,
  Running,
  Restarting,
  /// It kept crashing; Restart tries again.
  Failed,
  PortBusy(u16),
}

#[derive(Clone, Debug)]
pub struct Spec {
  pub program: PathBuf,
  pub args: Vec<String>,
  pub env: Vec<(String, String)>,
  pub log: PathBuf,
  /// The hub's port, checked before each start.
  pub port: Option<u16>,
  pub restart_delay: Duration,
}

const LOG_LIMIT: u64 = 5 * 1024 * 1024;
const STOP_GRACE: Duration = Duration::from_secs(15);

/// The bundled Node: runtime/node.exe on Windows, runtime/<arm64|x64>/bin/node on macOS.
pub fn node_binary(app_root: &Path) -> PathBuf {
  if cfg!(windows) {
    app_root.join("runtime").join("node.exe")
  } else {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    app_root.join("runtime").join(arch).join("bin").join("node")
  }
}

/// A command with no console window on Windows.
pub fn command(program: &Path) -> Command {
  #[allow(unused_mut)]
  let mut cmd = Command::new(program);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  cmd
}

/// Five crashes within two minutes stop the retries.
pub struct Crashes {
  times: Vec<Instant>,
}

impl Crashes {
  pub fn new() -> Self {
    Crashes { times: Vec::new() }
  }

  /// Records a crash at `now`; true while it may start again.
  pub fn record(&mut self, now: Instant) -> bool {
    self.times.retain(|t| now.duration_since(*t) < Duration::from_secs(120));
    self.times.push(now);
    self.times.len() < 5
  }
}

/// Moves a log over `limit` bytes to <log>.1 (one previous log is kept).
pub fn rotate(log: &Path, limit: u64) -> io::Result<()> {
  match fs::metadata(log) {
    Ok(m) if m.len() > limit => fs::rename(log, log.with_extension("log.1")),
    _ => Ok(()),
  }
}

pub fn port_free(port: u16) -> bool {
  TcpListener::bind(("127.0.0.1", port)).is_ok()
}

struct Proc {
  child: Child,
  stdin: Option<ChildStdin>,
  /// Kill-on-close: dropping it ends everything the child started.
  #[cfg(windows)]
  _job: win32job::Job,
}

#[derive(Default)]
struct Inner {
  proc: Option<Proc>,
  /// Bumped by every start and stop: a watcher of an older generation gives up.
  generation: u64,
}

#[derive(Clone)]
pub struct Supervisor {
  inner: Arc<Mutex<Inner>>,
  listener: Arc<dyn Fn(Status) + Send + Sync>,
}

impl Supervisor {
  pub fn new(listener: impl Fn(Status) + Send + Sync + 'static) -> Self {
    Supervisor { inner: Arc::new(Mutex::new(Inner::default())), listener: Arc::new(listener) }
  }

  fn emit(&self, status: Status) {
    (self.listener)(status)
  }

  fn current(&self, generation: u64) -> bool {
    self.inner.lock().unwrap().generation == generation
  }

  /// Stops what runs now, then runs `spec` and keeps it running until `stop`.
  pub fn start(&self, spec: Spec) {
    self.stop();
    let generation = {
      let mut i = self.inner.lock().unwrap();
      i.generation += 1;
      i.generation
    };
    let me = self.clone();
    thread::spawn(move || me.watch(spec, generation));
  }

  /// Writes one line to the child's stdin; false when nothing runs.
  pub fn send_line(&self, line: &str) -> bool {
    let mut i = self.inner.lock().unwrap();
    match i.proc.as_mut().and_then(|p| p.stdin.as_mut()) {
      Some(stdin) => stdin.write_all(format!("{line}\n").as_bytes()).and_then(|_| stdin.flush()).is_ok(),
      None => false,
    }
  }

  /// `stop` on the child's stdin, a kill after 15 s. Blocks until it is gone.
  pub fn stop(&self) {
    let proc = {
      let mut i = self.inner.lock().unwrap();
      i.generation += 1;
      i.proc.take()
    };
    let Some(mut p) = proc else { return };
    if let Some(mut stdin) = p.stdin.take() {
      let _ = stdin.write_all(b"stop\n");
      let _ = stdin.flush();
    }
    let t0 = Instant::now();
    while t0.elapsed() < STOP_GRACE {
      if matches!(p.child.try_wait(), Ok(Some(_))) {
        break;
      }
      thread::sleep(Duration::from_millis(100));
    }
    end(p);
    self.emit(Status::Stopped);
  }

  fn watch(&self, spec: Spec, generation: u64) {
    let mut crashes = Crashes::new();
    loop {
      if let Some(port) = spec.port {
        if !port_free(port) {
          self.emit(Status::PortBusy(port));
          return;
        }
      }
      self.emit(Status::Starting);
      let proc = match spawn(&spec) {
        Ok(p) => p,
        Err(e) => {
          note(&spec.log, &format!("cannot start {}: {e}", spec.program.display()));
          self.emit(Status::Failed);
          return;
        }
      };
      {
        let mut i = self.inner.lock().unwrap();
        if i.generation != generation {
          drop(i);
          end(proc);
          return;
        }
        i.proc = Some(proc);
      }
      self.emit(Status::Running);
      // Poll for the exit without holding the lock, so stop() and send_line() reach the child.
      let exit = loop {
        thread::sleep(Duration::from_millis(250));
        let mut i = self.inner.lock().unwrap();
        if i.generation != generation {
          return;
        }
        let done = match i.proc.as_mut() {
          Some(p) => p.child.try_wait(),
          None => return,
        };
        let text = match done {
          Ok(None) => continue,
          Ok(Some(status)) => status.to_string(),
          Err(e) => e.to_string(),
        };
        if let Some(p) = i.proc.take() {
          drop(i);
          end(p);
        }
        break text;
      };
      note(&spec.log, &format!("the process ended ({exit})"));
      if !crashes.record(Instant::now()) {
        self.emit(Status::Failed);
        return;
      }
      self.emit(Status::Restarting);
      thread::sleep(spec.restart_delay);
      if !self.current(generation) {
        return;
      }
    }
  }
}

fn spawn(spec: &Spec) -> io::Result<Proc> {
  if let Some(dir) = spec.log.parent() {
    fs::create_dir_all(dir)?;
  }
  rotate(&spec.log, LOG_LIMIT)?;
  let log = OpenOptions::new().create(true).append(true).open(&spec.log)?;
  let mut cmd = command(&spec.program);
  cmd.args(&spec.args)
    .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
    .stdin(Stdio::piped())
    .stdout(log.try_clone()?)
    .stderr(log);
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  #[cfg(windows)]
  let job = {
    let job = win32job::Job::create().map_err(io::Error::other)?;
    let mut info = job.query_extended_limit_info().map_err(io::Error::other)?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info).map_err(io::Error::other)?;
    job
  };
  let mut child = cmd.spawn()?;
  #[cfg(windows)]
  {
    use std::os::windows::io::AsRawHandle;
    job.assign_process(child.as_raw_handle() as isize).map_err(io::Error::other)?;
  }
  let stdin = child.stdin.take();
  Ok(Proc {
    child,
    stdin,
    #[cfg(windows)]
    _job: job,
  })
}

/// Ends what is left of the child: its process group on macOS; on Windows dropping the job does it.
fn end(mut p: Proc) {
  #[cfg(unix)]
  unsafe {
    libc::killpg(p.child.id() as libc::pid_t, libc::SIGKILL);
  }
  let _ = p.child.kill();
  let _ = p.child.wait();
}

/// A line of the app's own in the child's log.
fn note(log: &Path, text: &str) {
  if let Some(dir) = log.parent() {
    let _ = fs::create_dir_all(dir);
  }
  if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log) {
    let _ = writeln!(f, "[owlbot] {text}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("owl-supervisor-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
  }

  fn script(js: &str, log: PathBuf) -> Spec {
    Spec { program: "node".into(), args: vec!["-e".into(), js.into()], env: vec![], log, port: None, restart_delay: Duration::from_millis(50) }
  }

  fn recorder() -> (Supervisor, Arc<Mutex<Vec<Status>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (Supervisor::new(move |s| sink.lock().unwrap().push(s)), seen)
  }

  fn wait_for(seen: &Arc<Mutex<Vec<Status>>>, want: Status) {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(30) {
      if seen.lock().unwrap().contains(&want) {
        return;
      }
      thread::sleep(Duration::from_millis(50));
    }
    panic!("no {want:?} in {:?}", seen.lock().unwrap());
  }

  const ECHO: &str = r#"require("readline").createInterface({ input: process.stdin }).on("line", (l) => { console.log("got " + l); if (l === "stop") process.exit(0); }); setInterval(() => {}, 1000);"#;

  #[test]
  fn passes_lines_and_stops_through_stdin() {
    let log = tmp("echo").join("x.log");
    let (sup, seen) = recorder();
    sup.start(script(ECHO, log.clone()));
    wait_for(&seen, Status::Running);
    assert!(sup.send_line("ticket abc"));
    let t0 = Instant::now();
    sup.stop();
    assert!(t0.elapsed() < Duration::from_secs(10), "stop took {:?}", t0.elapsed());
    let text = fs::read_to_string(&log).unwrap();
    assert!(text.contains("got ticket abc") && text.contains("got stop"), "{text}");
    assert_eq!(seen.lock().unwrap().last(), Some(&Status::Stopped));
    assert!(!sup.send_line("late"));
  }

  #[test]
  fn restarts_a_crashing_child_then_gives_up() {
    let (sup, seen) = recorder();
    sup.start(script("process.exit(1)", tmp("crash").join("x.log")));
    wait_for(&seen, Status::Failed);
    let restarts = seen.lock().unwrap().iter().filter(|s| **s == Status::Restarting).count();
    assert_eq!(restarts, 4);
  }

  #[test]
  fn refuses_a_taken_port() {
    let taken = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = taken.local_addr().unwrap().port();
    let (sup, seen) = recorder();
    let mut spec = script("setInterval(() => {}, 1000)", tmp("port").join("x.log"));
    spec.port = Some(port);
    sup.start(spec);
    wait_for(&seen, Status::PortBusy(port));
  }

  #[test]
  fn counts_crashes_within_two_minutes() {
    let t = Instant::now();
    let mut c = Crashes::new();
    for _ in 0..4 {
      assert!(c.record(t));
    }
    assert!(!c.record(t));
    let mut c = Crashes::new();
    for i in 0..10 {
      assert!(c.record(t + Duration::from_secs(60 * i)));
    }
  }

  #[test]
  fn rotates_a_big_log() {
    let d = tmp("rotate");
    fs::create_dir_all(&d).unwrap();
    let log = d.join("hub.log");
    fs::write(&log, vec![b'x'; 100]).unwrap();
    rotate(&log, 50).unwrap();
    assert!(!log.exists());
    assert!(d.join("hub.log.1").exists());
  }
}
```

Add `mod supervisor;` to `main.rs` after `mod settings;`.

- [ ] **Step 2: Run the tests**

Run: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml supervisor`
Expected: 5 tests PASS (the crash test takes a few seconds). The Windows-only code (job object, `CREATE_NO_WINDOW`) compiles in the Windows CI job (Task 12).

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src-tauri/src/supervisor.rs packages/desktop/src-tauri/src/main.rs
git commit -m "Desktop app: supervise the hub or machine process"
```

---

### Task 9: Login-shell PATH, start at login, the AppleScript build's agent

**Files:**
- Create: `packages/desktop/src-tauri/src/shellpath.rs`, `packages/desktop/src-tauri/src/autostart.rs`, `packages/desktop/src-tauri/src/migration.rs`
- Modify: `packages/desktop/src-tauri/src/main.rs` (modules)
- Test: unit tests in `shellpath.rs` and `autostart.rs`

**Interfaces:**
- Produces: `shellpath::login_path() -> String` (macOS), `shellpath::between_marks(&str) -> Option<&str>`, `shellpath::merge(&str, &str) -> String`; `autostart::set(exe: &Path, on: bool) -> io::Result<()>`, `autostart::launch_agent(exe: &str, plist: &str) -> String`; `migration::remove_old_hub_agent()` (macOS).

- [ ] **Step 1: Write `shellpath.rs` with its tests**

```rust
//! macOS gives a GUI app a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so brain CLIs installed with Homebrew, npm or
//! the Claude installer are not found. The hub reads the login shell's PATH itself (packages/core/src/user-path.ts);
//! for owlbot-node the app asks the login shell once and passes it on.

/// Marks the PATH in the shell's output: startup files may print other text.
const MARK: &str = "__OWLBOT_PATH__";

pub fn between_marks(out: &str) -> Option<&str> {
  let start = out.find(MARK)? + MARK.len();
  let end = out[start..].find(MARK)? + start;
  Some(&out[start..end]).filter(|p| !p.is_empty())
}

/// The folders of `first`, then those of `then` not seen yet.
pub fn merge(first: &str, then: &str) -> String {
  let mut seen: Vec<&str> = Vec::new();
  for p in first.split(':').chain(then.split(':')) {
    if !p.is_empty() && !seen.contains(&p) {
      seen.push(p);
    }
  }
  seen.join(":")
}

pub fn fallback(home: &str) -> String {
  format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
}

#[cfg(target_os = "macos")]
pub fn login_path() -> String {
  use std::io::Read;
  use std::process::{Command, Stdio};
  use std::time::{Duration, Instant};

  let home = std::env::var("HOME").unwrap_or_default();
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
  let found = (|| {
    let mut child = Command::new(&shell).args(["-ilc", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let t0 = Instant::now();
    loop {
      match child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) if t0.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(50)),
        _ => {
          let _ = child.kill();
          let _ = child.wait();
          return None;
        }
      }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    between_marks(&out).map(str::to_string)
  })();
  match found {
    Some(path) => merge(&path, &fallback(&home)),
    None => fallback(&home),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn finds_the_path_among_shell_chatter() {
    assert_eq!(between_marks("Welcome!\n__OWLBOT_PATH__/a:/b__OWLBOT_PATH__"), Some("/a:/b"));
    assert_eq!(between_marks("no marks"), None);
    assert_eq!(between_marks("__OWLBOT_PATH____OWLBOT_PATH__"), None);
  }

  #[test]
  fn merges_without_duplicates() {
    assert_eq!(merge("/a:/usr/bin", "/usr/bin:/bin"), "/a:/usr/bin:/bin");
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn asks_the_login_shell() {
    assert!(login_path().split(':').any(|p| p == "/usr/bin"));
  }
}
```

- [ ] **Step 2: Write `autostart.rs` with its tests**

```rust
//! Start at login with `--background` (no window): a LaunchAgent on macOS, the HKCU Run value `Owlbot` on Windows
//! (the uninstaller of the Tauri bundle removes that value by its product name). Both point at the app's current path;
//! the app applies its setting at every start, which also repairs them after a move or an upgrade.

use std::io;
use std::path::Path;

pub const ARG: &str = "--background";

fn xml(s: &str) -> String {
  s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The macOS LaunchAgent: a small guard starts the app when it is still there and deletes this plist when the app
/// was moved to the Trash, so nothing is left failing at every login.
pub fn launch_agent(exe: &str, plist: &str) -> String {
  const GUARD: &str = r#"if [ -x "$1" ]; then exec "$1" --background; fi; rm -f "$2""#;
  format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.owlbot.app</string>
  <key>AssociatedBundleIdentifiers</key><array><string>ai.owlbot.app</string></array>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>{}</string><string>Owlbot</string><string>{}</string><string>{}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
    xml(GUARD),
    xml(exe),
    xml(plist)
  )
}

#[cfg(target_os = "macos")]
pub fn set(exe: &Path, on: bool) -> io::Result<()> {
  use std::fs;
  let plist = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/LaunchAgents/ai.owlbot.app.plist");
  if !on {
    return match fs::remove_file(&plist) {
      Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
      _ => Ok(()),
    };
  }
  let body = launch_agent(&exe.to_string_lossy(), &plist.to_string_lossy());
  if fs::read_to_string(&plist).ok().as_deref() == Some(body.as_str()) {
    return Ok(());
  }
  fs::create_dir_all(plist.parent().expect("LaunchAgents folder"))?;
  // launchd reads it at the next login; the app already runs now.
  fs::write(&plist, body)
}

#[cfg(windows)]
pub fn set(exe: &Path, on: bool) -> io::Result<()> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;
  let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")?;
  if on {
    key.set_value("Owlbot", &format!("\"{}\" {ARG}", exe.display()))
  } else {
    match key.delete_value("Owlbot") {
      Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
      _ => Ok(()),
    }
  }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn set(_exe: &Path, _on: bool) -> io::Result<()> {
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_launch_agent_starts_the_app_or_removes_itself() {
    let a = launch_agent("/Applications/open & bot.app/Contents/MacOS/Owlbot", "/Users/u/Library/LaunchAgents/ai.owlbot.app.plist");
    assert!(a.contains("<string>/Applications/open &amp; bot.app/Contents/MacOS/Owlbot</string>"));
    assert!(a.contains(r#"exec "$1" --background; fi; rm -f "$2""#));
    assert!(a.contains("<key>AssociatedBundleIdentifiers</key>"));
    assert!(!a.contains("KeepAlive"));
  }
}
```

- [ ] **Step 3: Write `migration.rs`**

```rust
//! The AppleScript build of Owlbot (on main before this app) ran the hub from a LaunchAgent of its own (ai.owlbot.hub,
//! same data dir, same port). The app runs the hub itself now, so that agent goes before the app starts its hub.

use std::path::Path;
use std::process::Command;

pub fn remove_old_hub_agent() {
  let home = std::env::var("HOME").unwrap_or_default();
  let plist = Path::new(&home).join("Library/LaunchAgents/ai.owlbot.hub.plist");
  if !plist.exists() {
    return;
  }
  let uid = unsafe { libc::getuid() };
  let _ = Command::new("launchctl").args(["bootout", &format!("gui/{uid}/ai.owlbot.hub")]).status();
  let _ = std::fs::remove_file(plist);
}
```

In `main.rs` add `mod autostart;`, `#[cfg(target_os = "macos")] mod migration;` and `mod shellpath;` (alphabetical with the others).

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml shellpath autostart`
Expected: PASS (shellpath 3 on macOS, autostart 1).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src
git commit -m "Desktop app: login-shell PATH, start at login, the AppleScript build's hub agent"
```

---

### Task 10: The app: windows, tray, commands, links

**Files:**
- Create: `packages/desktop/src-tauri/src/app.rs`, `packages/desktop/src-tauri/src/window.rs`, `packages/desktop/src-tauri/src/tray.rs`, `packages/desktop/src-tauri/src/commands.rs`
- Modify: `packages/desktop/src-tauri/src/main.rs` (final)
- Test: unit tests in `app.rs`, `tray.rs`, `window.rs`; a run on this Mac in isolation (Step 6)

**Interfaces:**
- Consumes: everything of Tasks 7–9; core stdin commands and `POST /api/auth/desktop` (Task 1); `launch.mjs url` (prints the address, exit 0, or exit 3 when the hub did not answer in 90 s); `owlbot-node.mjs pair <hub> <code> [--name n]` (exit 0 on success, localized text on failure).
- Produces: the Tauri commands of Task 6 with the `UiState` shape there; CLI flags `--background`, `--mode hub|node`, `--quit`.

- [ ] **Step 1: `window.rs`**

```rust
//! Two windows: "main" shows the hub's own web UI (no app commands), "setup" the app's own screens (ui/). Links that
//! leave the hub's origin open in the system browser; closing the hub window keeps the app in the tray.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::app::AppState;

pub const MAIN: &str = "main";
pub const SETUP: &str = "setup";

pub fn same_origin(a: &Url, b: &Url) -> bool {
  a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// The app's own pages: tauri://localhost on macOS, http(s)://tauri.localhost on Windows.
pub fn is_local(u: &Url) -> bool {
  u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

/// Shows the hub window when it exists; false when it has to be opened first.
pub fn show_main(app: &AppHandle) -> bool {
  let Some(w) = app.get_webview_window(MAIN) else { return false };
  let _ = w.show();
  let _ = w.unminimize();
  let _ = w.set_focus();
  dock(app, true);
  true
}

pub fn open_main(app: &AppHandle, url: Url) -> tauri::Result<()> {
  if show_main(app) {
    return Ok(());
  }
  let origin = url.clone();
  let browser = app.clone();
  let popups = app.clone();
  WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
    .title("Owlbot")
    .inner_size(1200.0, 820.0)
    .min_inner_size(420.0, 520.0)
    .on_navigation(move |u| {
      if same_origin(u, &origin) || u.scheme() == "about" || u.scheme() == "blob" {
        return true;
      }
      let _ = browser.opener().open_url(u.as_str(), None::<&str>);
      false
    })
    .on_new_window(move |u, _| {
      let _ = popups.opener().open_url(u.as_str(), None::<&str>);
      NewWindowResponse::Deny
    })
    .build()?;
  dock(app, true);
  Ok(())
}

/// The setup window, reloaded when it is already open so it shows the current state.
pub fn open_setup(app: &AppHandle) -> tauri::Result<()> {
  if let Some(w) = app.get_webview_window(SETUP) {
    w.eval("location.reload()")?;
    w.show()?;
    w.set_focus()?;
  } else {
    WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
      .title("Owlbot")
      .inner_size(560.0, 660.0)
      .resizable(false)
      .center()
      .on_navigation(|u| is_local(u))
      .build()?;
  }
  dock(app, true);
  Ok(())
}

pub fn close_setup(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(SETUP) {
    let _ = w.close();
  }
}

/// Drops the hub window (its page belongs to the previous mode or hub).
pub fn close_main(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(MAIN) {
    let _ = w.destroy();
  }
}

/// Closing the hub window only hides it; closing the setup window before anything was chosen quits.
pub fn on_event(window: &Window, event: &WindowEvent) {
  let app = window.app_handle();
  match event {
    WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
      api.prevent_close();
      let _ = window.hide();
      hide_dock_if_idle(app);
    }
    WindowEvent::Destroyed if window.label() == SETUP => {
      let first_run = app.try_state::<AppState>().map(|s| s.settings.lock().unwrap().mode.is_none()).unwrap_or(true);
      if first_run {
        app.exit(0);
      } else {
        hide_dock_if_idle(app);
      }
    }
    _ => {}
  }
}

fn hide_dock_if_idle(app: &AppHandle) {
  let visible = [MAIN, SETUP].iter().any(|l| app.get_webview_window(l).and_then(|w| w.is_visible().ok()).unwrap_or(false));
  if !visible {
    dock(app, false);
  }
}

/// macOS: a Dock icon only while a window is open; the menu bar icon stays.
pub fn dock(app: &AppHandle, visible: bool) {
  #[cfg(target_os = "macos")]
  let _ = app.set_activation_policy(if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
  #[cfg(not(target_os = "macos"))]
  let _ = (app, visible);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn compares_origins() {
    let hub = Url::parse("http://localhost:8080/#desktop=x").unwrap();
    assert!(same_origin(&Url::parse("http://localhost:8080/chat").unwrap(), &hub));
    assert!(!same_origin(&Url::parse("http://localhost:8081/").unwrap(), &hub));
    assert!(!same_origin(&Url::parse("https://example.com/").unwrap(), &hub));
    assert!(same_origin(&Url::parse("https://bot.example.com/x").unwrap(), &Url::parse("https://bot.example.com:443/").unwrap()));
  }

  #[test]
  fn knows_its_own_pages() {
    assert!(is_local(&Url::parse("tauri://localhost/index.html").unwrap()));
    assert!(is_local(&Url::parse("http://tauri.localhost/index.html").unwrap()));
    assert!(!is_local(&Url::parse("http://localhost:8080/").unwrap()));
  }
}
```

- [ ] **Step 2: `tray.rs`**

```rust
//! The menu bar (macOS) or tray (Windows) icon: the hub's state and the app's commands.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::i18n::{texts, Texts};
use crate::settings::Mode;
use crate::supervisor::Status;

pub struct Tray {
  pub status: MenuItem<Wry>,
  pub autostart: CheckMenuItem<Wry>,
}

pub fn build(app: &AppHandle, autostart: bool) -> tauri::Result<Tray> {
  let t = texts();
  let status = MenuItem::with_id(app, "status", t.t("tray.status.stopped"), false, None::<&str>)?;
  let autostart = CheckMenuItem::with_id(app, "autostart", t.t("tray.autostart"), true, autostart, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[
      &status,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, "open", t.t("tray.open"), true, None::<&str>)?,
      &autostart,
      &MenuItem::with_id(app, "logs", t.t("tray.logs"), true, None::<&str>)?,
      &MenuItem::with_id(app, "restart", t.t("tray.restart"), true, None::<&str>)?,
      &MenuItem::with_id(app, "setup", t.t("tray.setupAgain"), true, None::<&str>)?,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, "quit", t.t("tray.quit"), true, None::<&str>)?,
    ],
  )?;
  let mut builder = TrayIconBuilder::with_id("main")
    .tooltip("Owlbot")
    .menu(&menu)
    .show_menu_on_left_click(cfg!(target_os = "macos"))
    .on_menu_event(|app, e| crate::app::on_menu(app, e.id().as_ref()))
    .on_tray_icon_event(|tray, e| {
      // Windows: a click opens the window, the right click shows the menu. macOS: the menu on any click.
      if !cfg!(target_os = "macos") {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
          crate::app::open_ui(tray.app_handle());
        }
      }
    });
  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }
  builder.build(app)?;
  Ok(Tray { status, autostart })
}

pub fn status_text(t: &Texts, status: &Status, mode: Option<Mode>, hub: Option<&str>) -> String {
  match (status, mode) {
    (Status::Running, Some(Mode::Node)) => t.f("tray.status.node", &[("hub", hub.unwrap_or(""))]),
    (Status::Starting, _) => t.t("tray.status.starting"),
    (Status::Running, _) => t.t("tray.status.running"),
    (Status::Restarting, _) => t.t("tray.status.restarting"),
    (Status::Failed, _) => t.t("tray.status.failed"),
    (Status::PortBusy(port), _) => t.f("tray.status.portBusy", &[("port", &port.to_string())]),
    (Status::Stopped, _) => t.t("tray.status.stopped"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn describes_the_state() {
    let t = Texts::for_locale(Some("en"));
    assert_eq!(status_text(&t, &Status::Running, Some(Mode::Hub), None), "Running");
    assert_eq!(status_text(&t, &Status::Running, Some(Mode::Node), Some("https://bot.example.com")), "Machine of https://bot.example.com");
    assert_eq!(status_text(&t, &Status::PortBusy(8080), Some(Mode::Hub), None), "Port 8080 is taken");
  }
}
```

- [ ] **Step 3: `app.rs`**

```rust
//! The app's state and what it does: run the hub or the machine daemon, open the right window, answer the tray,
//! links and a second launch.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, Url};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

use crate::deeplink::{self, PairLink};
use crate::i18n::texts;
use crate::settings::{self, Mode, Settings};
use crate::supervisor::{self, Spec, Status, Supervisor};
use crate::{autostart, login, tray, window};

/// `--background` (no window: started at login), `--mode hub|node` (when nothing is chosen yet), `--quit` (stops the
/// running app).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
  pub background: bool,
  pub mode: Option<Mode>,
  pub quit: bool,
}

impl Args {
  pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Args {
    let mut out = Args::default();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
      match a.as_str() {
        "--background" => out.background = true,
        "--quit" => out.quit = true,
        "--mode" => out.mode = it.next().and_then(|m| Mode::parse(&m)),
        _ => {}
      }
    }
    out
  }
}

pub struct Paths {
  pub config_dir: PathBuf,
  /// The staged app tree: the app's resource "app" (OWLBOT_APP_ROOT in a dev run).
  pub app_root: PathBuf,
  pub node: PathBuf,
  pub hub_data: PathBuf,
  pub hub_log: PathBuf,
  pub node_home: PathBuf,
  pub node_log: PathBuf,
  /// OWLBOT_DATA_DIR is set: a dev or test run, which leaves start at login and the AppleScript build's agent alone.
  pub dev: bool,
}

impl Paths {
  fn resolve(app: &AppHandle) -> tauri::Result<Paths> {
    let p = app.path();
    let app_root = std::env::var_os("OWLBOT_APP_ROOT").map(PathBuf::from).unwrap_or(p.resource_dir()?.join("app"));
    let data_override = std::env::var_os("OWLBOT_DATA_DIR").map(PathBuf::from);
    let hub_data = data_override.clone().unwrap_or(p.local_data_dir()?.join("Owlbot"));
    let node_home = std::env::var_os("OWLBOT_NODE_HOME").map(PathBuf::from).unwrap_or(p.home_dir()?.join(".owlbot-node"));
    Ok(Paths {
      config_dir: p.app_config_dir()?,
      node: supervisor::node_binary(&app_root),
      hub_log: hub_data.join("logs").join("hub.log"),
      node_log: p.app_log_dir()?.join("node.log"),
      app_root,
      hub_data,
      node_home,
      dev: data_override.is_some(),
    })
  }

  /// The hub's port from <data>/desktop.json, as launch.mjs reads it.
  pub fn hub_port(&self) -> u16 {
    std::fs::read_to_string(self.hub_data.join("desktop.json"))
      .ok()
      .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
      .and_then(|v| v.get("port")?.as_u64())
      .and_then(|p| u16::try_from(p).ok())
      .unwrap_or(8080)
  }

  fn launch(&self) -> PathBuf {
    self.app_root.join("packaging").join("desktop").join("launch.mjs")
  }

  fn node_cli(&self) -> PathBuf {
    self.app_root.join("packages").join("node").join("dist").join("owlbot-node.mjs")
  }
}

/// What the setup window shows instead of the choice: why nothing runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UiError {
  pub key: &'static str,
  pub port: Option<u16>,
}

pub struct AppState {
  pub paths: Paths,
  pub settings: Mutex<Settings>,
  pub supervisor: Supervisor,
  pub status: Mutex<Status>,
  pub link: Mutex<Option<PairLink>>,
  pub error: Mutex<Option<UiError>>,
  /// The hub window's address is being fetched: the setup window says "starting".
  pub starting: Mutex<bool>,
  pub tray: Mutex<Option<tray::Tray>>,
  /// macOS: the login shell's PATH for owlbot-node (a GUI app gets a bare one; the hub reads it itself).
  pub path_env: Option<String>,
}

pub fn setup(app: &mut tauri::App, args: Args) -> Result<(), Box<dyn std::error::Error>> {
  let handle = app.handle().clone();
  if args.quit {
    handle.exit(0);
    return Ok(());
  }
  let paths = Paths::resolve(&handle)?;
  let mut settings = settings::load(&paths.config_dir);
  if settings.mode.is_none() && args.mode.is_some() {
    settings.mode = args.mode;
    settings::save(&paths.config_dir, &settings)?;
  }
  let supervisor = {
    let h = handle.clone();
    Supervisor::new(move |s| on_status(&h, s))
  };
  #[cfg(target_os = "macos")]
  let path_env = Some(crate::shellpath::login_path());
  #[cfg(not(target_os = "macos"))]
  let path_env = None;
  let damaged = !paths.node.exists() || !paths.launch().exists();
  app.manage(AppState {
    paths,
    settings: Mutex::new(settings.clone()),
    supervisor,
    status: Mutex::new(Status::Stopped),
    link: Mutex::new(None),
    error: Mutex::new(damaged.then_some(UiError { key: "app.error.noRuntime", port: None })),
    starting: Mutex::new(false),
    tray: Mutex::new(None),
    path_env,
  });
  let state = handle.state::<AppState>();
  *state.tray.lock().unwrap() = Some(tray::build(&handle, settings.autostart)?);
  if !state.paths.dev {
    #[cfg(target_os = "macos")]
    crate::migration::remove_old_hub_agent();
    if settings.mode.is_some() {
      apply_autostart(settings.autostart);
    }
  }
  let h = handle.clone();
  handle.deep_link().on_open_url(move |e| {
    for url in e.urls() {
      on_link(&h, &url);
    }
  });
  let mut linked = false;
  if let Ok(Some(urls)) = handle.deep_link().get_current() {
    for url in urls {
      linked |= on_link(&handle, &url);
    }
  }
  match settings.mode {
    Some(mode) if !damaged => {
      start(&handle, mode);
      if !args.background && !linked {
        open_ui(&handle);
      } else if !linked {
        window::dock(&handle, false);
      }
    }
    _ if !linked => window::open_setup(&handle)?,
    _ => {}
  }
  Ok(())
}

fn apply_autostart(on: bool) {
  if let Ok(exe) = std::env::current_exe() {
    if let Err(e) = autostart::set(&exe, on) {
      eprintln!("owlbot: start at login: {e}");
    }
  }
}

fn spec(st: &AppState, mode: Mode) -> Spec {
  let p = &st.paths;
  let mut env = vec![("OWLBOT_DESKTOP".to_string(), "1".to_string())];
  let delay = Duration::from_secs(2);
  match mode {
    Mode::Hub => {
      env.push(("OWLBOT_DATA_DIR".into(), arg(&p.hub_data)));
      Spec { program: p.node.clone(), args: vec![arg(&p.launch()), "run".into()], env, log: p.hub_log.clone(), port: Some(p.hub_port()), restart_delay: delay }
    }
    Mode::Node => {
      env.push(("OWLBOT_LANG".into(), texts().lang().into()));
      env.push(("OWLBOT_NODE_HOME".into(), arg(&p.node_home)));
      // The hub finds the user's CLIs itself (packages/core/src/user-path.ts); owlbot-node needs this PATH.
      if let Some(path) = &st.path_env {
        env.push(("PATH".into(), path.clone()));
      }
      Spec { program: p.node.clone(), args: vec![arg(&p.node_cli()), "run".into()], env, log: p.node_log.clone(), port: None, restart_delay: delay }
    }
  }
}

fn arg(p: &Path) -> String {
  p.to_string_lossy().into_owned()
}

pub fn start(app: &AppHandle, mode: Mode) {
  let st = app.state::<AppState>();
  st.supervisor.start(spec(&st, mode));
}

fn on_status(app: &AppHandle, status: Status) {
  let Some(st) = app.try_state::<AppState>() else { return };
  *st.status.lock().unwrap() = status.clone();
  match &status {
    Status::Failed => *st.error.lock().unwrap() = Some(UiError { key: "app.error.failed", port: None }),
    Status::PortBusy(port) => *st.error.lock().unwrap() = Some(UiError { key: "app.error.portBusy", port: Some(*port) }),
    _ => {}
  }
  let mode = st.settings.lock().unwrap().mode;
  let hub = settings::existing_node(&st.paths.node_home).map(|e| e.hub);
  let text = tray::status_text(texts(), &status, mode, hub.as_deref());
  // set_text runs on the main thread and waits for it: never hold the lock meanwhile.
  let item = st.tray.lock().unwrap().as_ref().map(|t| t.status.clone());
  if let Some(item) = item {
    let _ = item.set_text(text);
  }
}

/// The hub window's address: what `launch.mjs url` prints once the hub answers (the setup form with its code until a
/// password is set), else the hub with a fresh one-time sign-in ticket.
fn hub_window_url(st: &AppState) -> Option<Url> {
  let p = &st.paths;
  let out = supervisor::command(&p.node).arg(p.launch()).arg("url").env("OWLBOT_DATA_DIR", &p.hub_data).output().ok()?;
  if !out.status.success() {
    return None;
  }
  let base = String::from_utf8_lossy(&out.stdout).trim().to_string();
  if base.contains("#setup=") {
    return Url::parse(&base).ok();
  }
  let ticket = login::new_ticket();
  if !st.supervisor.send_line(&format!("ticket {ticket}")) {
    return None;
  }
  Url::parse(&login::with_ticket(&base, &ticket)).ok()
}

/// Shows what the user should see now: the setup window (first run, an error, a link) or the hub's UI.
pub fn open_ui(app: &AppHandle) {
  let st = app.state::<AppState>();
  let mode = st.settings.lock().unwrap().mode;
  let pending = st.error.lock().unwrap().is_some() || st.link.lock().unwrap().is_some();
  let Some(mode) = mode.filter(|_| !pending) else {
    let _ = window::open_setup(app);
    return;
  };
  if window::show_main(app) {
    return;
  }
  *st.starting.lock().unwrap() = true;
  let _ = window::open_setup(app);
  let app = app.clone();
  std::thread::spawn(move || {
    let st = app.state::<AppState>();
    let url = match mode {
      Mode::Hub => hub_window_url(&st),
      Mode::Node => settings::existing_node(&st.paths.node_home).and_then(|e| Url::parse(&e.hub).ok()),
    };
    *st.starting.lock().unwrap() = false;
    match url {
      Some(url) => {
        let _ = window::open_main(&app, url);
        window::close_setup(&app);
      }
      None => {
        st.error.lock().unwrap().get_or_insert(UiError { key: "app.error.notStarted", port: None });
        let _ = window::open_setup(&app);
      }
    }
  });
}

/// The first-run (or "Set up again…") choice: saved, start at login applied the first time, the mode's process
/// started unless it already runs, its window opened.
pub fn choose(app: &AppHandle, mode: Mode) -> Result<(), String> {
  let st = app.state::<AppState>();
  let (previous, autostart) = {
    let mut s = st.settings.lock().unwrap();
    let previous = s.mode;
    s.mode = Some(mode);
    settings::save(&st.paths.config_dir, &s).map_err(|e| e.to_string())?;
    (previous, s.autostart)
  };
  *st.link.lock().unwrap() = None;
  *st.error.lock().unwrap() = None;
  if previous.is_none() && !st.paths.dev {
    apply_autostart(autostart);
  }
  let running = matches!(*st.status.lock().unwrap(), Status::Starting | Status::Running | Status::Restarting);
  if previous != Some(mode) || !running {
    window::close_main(app);
    start(app, mode);
  }
  open_ui(app);
  Ok(())
}

/// `owlbot-node pair` with the bundled Node; on success this computer becomes a machine of that hub.
pub fn pair(app: &AppHandle, hub: &str, code: &str, name: &str) -> Result<(), String> {
  let st = app.state::<AppState>();
  let p = &st.paths;
  let mut cmd = supervisor::command(&p.node);
  cmd.arg(p.node_cli()).args(["pair", hub.trim(), code.trim()]).env("OWLBOT_LANG", texts().lang()).env("OWLBOT_NODE_HOME", &p.node_home);
  if !name.trim().is_empty() {
    cmd.args(["--name", name.trim()]);
  }
  if let Some(path) = &st.path_env {
    cmd.env("PATH", path);
  }
  let out = cmd.output().map_err(|e| e.to_string())?;
  if !out.status.success() {
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    return Err(last_lines(&text, 3));
  }
  // A daemon of an earlier pairing must not stay connected to the old hub.
  st.supervisor.stop();
  choose(app, Mode::Node)
}

pub fn last_lines(s: &str, n: usize) -> String {
  let lines: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
  lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Remembers a pairing link and shows it in the setup window; false when it is not one.
fn on_link(app: &AppHandle, url: &Url) -> bool {
  let Some(link) = deeplink::parse(url) else { return false };
  *app.state::<AppState>().link.lock().unwrap() = Some(link);
  let _ = window::open_setup(app);
  true
}

/// A second launch hands its arguments to this one: `--quit` stops the app, `--mode` makes the first-run choice when
/// none was made, anything else shows the window. Links arrive through the deep-link plugin.
pub fn second_instance(app: &AppHandle, argv: Vec<String>) {
  let link = argv.iter().any(|a| a.starts_with("owlbot:"));
  let args = Args::parse(argv.into_iter().skip(1));
  if args.quit {
    app.exit(0);
    return;
  }
  let unset = app.state::<AppState>().settings.lock().unwrap().mode.is_none();
  match args.mode {
    Some(mode) if unset => {
      let _ = choose(app, mode);
    }
    _ if !args.background && !link => open_ui(app),
    _ => {}
  }
}

pub fn restart(app: &AppHandle) {
  let st = app.state::<AppState>();
  *st.error.lock().unwrap() = None;
  let mode = st.settings.lock().unwrap().mode;
  if let Some(mode) = mode {
    start(app, mode);
  }
}

pub fn open_log(app: &AppHandle) {
  let st = app.state::<AppState>();
  let log = match st.settings.lock().unwrap().mode {
    Some(Mode::Node) => st.paths.node_log.clone(),
    _ => st.paths.hub_log.clone(),
  };
  let _ = app.opener().open_path(log.to_string_lossy(), None::<&str>);
}

pub fn on_menu(app: &AppHandle, id: &str) {
  let st = app.state::<AppState>();
  match id {
    "open" => open_ui(app),
    "autostart" => {
      let on = {
        let mut s = st.settings.lock().unwrap();
        s.autostart = !s.autostart;
        let _ = settings::save(&st.paths.config_dir, &s);
        s.autostart
      };
      if !st.paths.dev {
        apply_autostart(on);
      }
      let item = st.tray.lock().unwrap().as_ref().map(|t| t.autostart.clone());
      if let Some(item) = item {
        let _ = item.set_checked(on);
      }
    }
    "logs" => open_log(app),
    "restart" => {
      let app = app.clone();
      std::thread::spawn(move || restart(&app));
    }
    "setup" => {
      let _ = window::open_setup(app);
    }
    "quit" => app.exit(0),
    _ => {}
  }
}

/// The computer's name for the machine-name field: the Sharing name on macOS, COMPUTERNAME on Windows.
pub fn hostname() -> String {
  #[cfg(target_os = "macos")]
  if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !name.is_empty() {
      return name;
    }
  }
  std::env::var("COMPUTERNAME").unwrap_or_default()
}

pub fn on_run_event(app: &AppHandle, event: RunEvent) {
  match event {
    // The last window was closed: the app stays in the tray. Quit and --quit exit with a code.
    RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
    RunEvent::Exit => {
      if let Some(st) = app.try_state::<AppState>() {
        st.supervisor.stop();
      }
    }
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => open_ui(app),
    _ => {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(a: &[&str]) -> Args {
    Args::parse(a.iter().map(|s| s.to_string()))
  }

  #[test]
  fn parses_flags() {
    assert_eq!(args(&["--mode", "hub", "--background"]), Args { background: true, mode: Some(Mode::Hub), quit: false });
    assert_eq!(args(&["--quit"]).quit, true);
    assert_eq!(args(&["--mode", "x"]).mode, None);
    assert_eq!(args(&["owlbot://pair?hub=x&code=y"]), Args::default());
  }

  #[test]
  fn keeps_the_last_lines_of_a_failure() {
    assert_eq!(last_lines("a\n\nb\n c \nd\n", 3), "b\nc\nd");
    assert_eq!(last_lines("only", 3), "only");
  }
}
```

- [ ] **Step 4: `commands.rs` and the final `main.rs`**

`packages/desktop/src-tauri/src/commands.rs`:

```rust
//! Commands for the app's own screens (window "setup" only: capabilities/setup.json).

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app::{self, AppState, UiError};
use crate::deeplink::PairLink;
use crate::i18n::texts;
use crate::settings::{self, Existing, Mode};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
  lang: &'static str,
  mode: Option<Mode>,
  starting: bool,
  existing: Option<Existing>,
  link: Option<PairLink>,
  error: Option<UiError>,
  hostname: String,
}

#[tauri::command]
pub fn get_state(app: AppHandle) -> UiState {
  let st = app.state::<AppState>();
  UiState {
    lang: texts().lang(),
    mode: st.settings.lock().unwrap().mode,
    starting: *st.starting.lock().unwrap(),
    existing: settings::existing_node(&st.paths.node_home),
    link: st.link.lock().unwrap().clone(),
    error: st.error.lock().unwrap().clone(),
    hostname: app::hostname(),
  }
}

/// Runs `f` off the async runtime: choosing stops the previous process, which may take up to 15 s.
async fn blocking(app: AppHandle, f: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || f(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn choose_hub(app: AppHandle) -> Result<(), String> {
  blocking(app, |a| app::choose(a, Mode::Hub)).await
}

#[tauri::command]
pub async fn pair(app: AppHandle, hub: String, code: String, name: String) -> Result<(), String> {
  blocking(app, move |a| app::pair(a, &hub, &code, &name)).await
}

#[tauri::command]
pub async fn use_existing_node(app: AppHandle) -> Result<(), String> {
  blocking(app, |a| app::choose(a, Mode::Node)).await
}

#[tauri::command]
pub fn open_log(app: AppHandle) {
  app::open_log(&app);
}

#[tauri::command]
pub async fn retry(app: AppHandle) -> Result<(), String> {
  blocking(app, |a| {
    app::restart(a);
    app::open_ui(a);
    Ok(())
  })
  .await
}

#[tauri::command]
pub fn dismiss(app: AppHandle) {
  *app.state::<AppState>().link.lock().unwrap() = None;
  crate::window::close_setup(&app);
}
```

`packages/desktop/src-tauri/src/main.rs` (final):

```rust
// Owlbot desktop app: a window for the hub's web UI, a menu bar / tray icon, and the hub (or this computer's
// machine daemon) running in the background on the bundled Node.
// Spec: docs/superpowers/specs/2026-10-26-desktop-app-design.md
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod autostart;
mod commands;
mod deeplink;
mod i18n;
mod login;
#[cfg(target_os = "macos")]
mod migration;
mod settings;
mod shellpath;
mod supervisor;
mod tray;
mod window;

fn main() {
  let args = app::Args::parse(std::env::args().skip(1));
  tauri::Builder::default()
    // First: a second launch (and a link on Windows) goes to the running app.
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| app::second_instance(app, argv)))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      commands::get_state,
      commands::choose_hub,
      commands::pair,
      commands::use_existing_node,
      commands::open_log,
      commands::retry,
      commands::dismiss
    ])
    .on_window_event(window::on_event)
    .setup(move |app| app::setup(app, args))
    .build(tauri::generate_context!())
    .expect("Owlbot failed to start")
    .run(app::on_run_event);
}
```

- [ ] **Step 5: Build and run the unit tests**

Run: `npm run build:ui -w @owlbot/desktop && cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml -- -D warnings`
Expected: all tests PASS; clippy clean (fix what it reports: unused imports, needless borrows).

- [ ] **Step 6: Run the app on this Mac in isolation**

Never against the default data dir (see Global Constraints). Stage once, then:

```bash
node packaging/desktop/stage.mjs --target darwin --skip-build
D=$(mktemp -d); mkdir -p "$D/data" "$D/node"; echo '{"port":18080}' > "$D/data/desktop.json"
OWLBOT_APP_ROOT="$PWD/dist/desktop/stage-darwin/app" OWLBOT_DATA_DIR="$D/data" OWLBOT_NODE_HOME="$D/node" \
  npm run tauri -w @owlbot/desktop -- dev
```

Check, in order:
1. The setup window asks how the computer is used; the menu bar icon shows "Stopped".
2. "A new Owlbot on this computer": the status turns "Running", the hub window opens with the setup form and its code filled in; set a password.
3. Close the hub window: the Dock icon goes, the menu bar icon stays; `curl -s http://127.0.0.1:18080/api/auth/state` still answers.
4. "Open Owlbot" in the menu: the window comes back without a sign-in form.
5. Quit the app (menu), run the same command again with `-- --background`: no window; "Open Owlbot": the hub's UI opens signed in (ticket).
6. "Restart": the status goes "Starting…" then "Running".
7. A link outside the hub (for example a link in a chat message) opens in the default browser.
8. `open "owlbot://pair?hub=http://127.0.0.1:18080&code=WRONG"` while the dev app runs: the link screen appears; "Connect" shows the CLI's error text; "Cancel" closes it.
9. Quit: `curl` gets no answer within 15 s; `ls ~/Library/LaunchAgents` has no `ai.owlbot.app.plist` (dev runs never write it), and `launchctl print gui/$(id -u)/ai.openbot.hub` still shows the user's own (pre-rename) hub running.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src-tauri/src
git commit -m "Desktop app: hub window with automatic sign-in, tray, first run, pairing links"
```

---

### Task 11: Packaging: `.dmg`, `.pkg`, NSIS; remove the old installers

**Files:**
- Create: `packaging/desktop/build.mjs`, `packaging/macos/pkg.mjs`, `packaging/macos/uninstall.sh`, `packaging/windows/generate.mjs`
- Modify: `packaging/macos/generate.mjs`, `packaging/macos/scripts/preinstall`, `packaging/macos/scripts/postinstall`, `packaging/desktop/locales/{en,ru}.json`, `package.json`
- Delete: `packaging/windows/owlbot.iss`, `packaging/windows/build.mjs`, `packaging/windows/tray/`, `packaging/macos/build.mjs`, `packaging/macos/bin/`
- Test: `packages/core/test/desktop-packaging.test.ts`, `packages/core/test/i18n.test.ts`

**Interfaces:**
- Consumes: `stage({ target, skipBuild })`, `npm(args, opts)`, `run(cmd, args)`, `ROOT`, `VERSION` from `stage.mjs`; `loadCatalogs()`, `text()`, `LOCALES` from `locales.mjs`; the Tauri app of Tasks 6–10 (`--quit`, `--background`).
- Produces: `buildPkg({ appBundle, build, out }) -> string`, `nsisString(s) -> string`, `nsisHooks(catalogs) -> string`, `npm run package:desktop`.

- [ ] **Step 1: Write the failing packaging tests**

In `packages/core/test/desktop-packaging.test.ts`:
- replace the import of `packaging/macos/generate.mjs` with `import { distributionXml, installerPage } from "../../../packaging/macos/generate.mjs";` and add `// @ts-ignore` + `import { nsisHooks, nsisString } from "../../../packaging/windows/generate.mjs";`
- delete the tests `"writes AppleScript strings in ASCII"`, `"Owlbot.app: ASCII source, and every message it shows is defined"` and `"Owlbot.app runs the scripts inside itself and asks to be moved out of the disk image"` (and any loop over AppleScript apps left from earlier work)
- rename `describe("macOS installer text")` to `describe("installer text")` and add:

```ts
  it("writes NSIS strings", () => {
    expect(nsisString('Say "hi"\nfor $5')).toBe('"Say $\\"hi$\\"$\\nfor $$5"');
  });

  it("builds the NSIS hooks: the data question in both languages, a start after a silent install", () => {
    const hooks: string = nsisHooks(catalogs);
    expect(hooks).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
    expect(hooks).toContain("${If} $LANGUAGE == 1049");
    expect(hooks).toContain("$LOCALAPPDATA\\Owlbot");
    expect(hooks).toContain("Удалить и ваши данные Owlbot");
    expect(hooks).toContain('Exec \'"$INSTDIR\\Owlbot.exe" --background\'');
    expect(hooks).not.toContain("{dir}");
  });
```

Run: `npx vitest run packages/core/test/desktop-packaging.test.ts`
Expected: FAIL (`packaging/windows/generate.mjs` does not exist).

- [ ] **Step 2: Windows hooks generator**

`packaging/windows/generate.mjs`:

```js
// NSIS hooks for the desktop app's Windows installer (the Tauri bundler's `bundle.windows.nsis.installerHooks`),
// generated from the installer catalogs by packaging/desktop/build.mjs. Pure, so it is tested on any platform.

import { text } from "../desktop/locales.mjs";

/** An NSIS string literal: `$`, quotes and newlines escaped. */
export function nsisString(s) {
  return `"${s.replace(/\$/g, "$$$$").replace(/"/g, '$\\"').replace(/\r?\n/g, "$\\n")}"`;
}

/**
 * The installer goes per user into $LOCALAPPDATA\Owlbot (the template's default), where the hub keeps its data too.
 * The uninstaller removes only the files it installed, so the data stays unless the user deletes it here.
 */
export function nsisHooks(catalogs) {
  const ask = (locale) => nsisString(text(catalogs, locale, "setup.deleteData")).replace("{dir}", "$LOCALAPPDATA\\Owlbot");
  return `; Generated by packaging/desktop/build.mjs from packaging/desktop/locales/*.json. Do not edit.

!macro NSIS_HOOK_POSTINSTALL
  ; A silent install (/S) starts the app in the background unless /NOSTART is given.
  \${If} \${Silent}
    ClearErrors
    \${GetOptions} $CMDLINE "/NOSTART" $R0
    \${If} \${Errors}
      Exec '"$INSTDIR\\Owlbot.exe" --background'
    \${EndIf}
  \${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Not on an update, not when silent: ask (default No) whether the data goes too.
  \${If} $UpdateMode <> 1
  \${AndIfNot} \${Silent}
    \${If} $LANGUAGE == 1049
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 ${ask("ru")} IDNO owl_keep_data
    \${Else}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 ${ask("en")} IDNO owl_keep_data
    \${EndIf}
    RMDir /r "$LOCALAPPDATA\\Owlbot"
    owl_keep_data:
  \${EndIf}
!macroend
`;
}
```

- [ ] **Step 3: macOS: generate.mjs, the package builder and its scripts**

`packaging/macos/generate.mjs`: keep only the header, `PKG_ID`, `MIN_MACOS`, `escapeHtml`, `installerPage` and `distributionXml`. Replace the header with:

```js
// Text the macOS package build generates from the installer catalogs: the Installer pages and the distribution file.
// Pure functions, so they are tested on any platform (packages/core/test/desktop-packaging.test.ts).

import { text } from "../desktop/locales.mjs";
```

and delete `appleScriptText`, `handlerName`, `appleScriptMessages`, `PRELUDE`, `call`, `launcherScript` and `uninstallerScript` (and `SUPPORT_DIR` if still present). Keep `export const PKG_ID = "ai.owlbot.pkg";` and `export const MIN_MACOS = "13.5";`.

`packaging/macos/pkg.mjs`:

```js
// The silent macOS package around the desktop app: the same Owlbot.app into /Applications, for installs over SSH
// or MDM (`sudo installer -pkg owlbot-<version>.pkg -target /`). pkgbuild and productbuild ship with macOS.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, run } from "../desktop/stage.mjs";
import { LOCALES, loadCatalogs } from "../desktop/locales.mjs";
import { PKG_ID, distributionXml, installerPage } from "./generate.mjs";

const HERE = import.meta.dirname;

/** Builds `out` from `appBundle`, using `build` as a scratch folder. Returns `out`. */
export function buildPkg({ appBundle, build, out }) {
  const root = join(build, "pkg-root");
  mkdirSync(join(root, "Applications"), { recursive: true });
  // A clone on APFS: no extra space.
  run("cp", ["-cRp", appBundle, join(root, "Applications")]);

  // The app stays where it is installed: a relocatable bundle would be "upgraded" wherever the user moved a copy.
  const comp = join(build, "component.plist");
  run("pkgbuild", ["--analyze", "--root", root, comp]);
  const bundles = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", comp], { encoding: "utf8" }));
  for (const b of bundles) Object.assign(b, { BundleIsRelocatable: false, BundleIsVersionChecked: false, BundleHasStrictIdentifier: false, BundleOverwriteAction: "upgrade" });
  writeFileSync(comp + ".json", JSON.stringify(bundles));
  run("plutil", ["-convert", "xml1", "-o", comp, comp + ".json"]);

  const scripts = join(build, "pkg-scripts");
  mkdirSync(scripts, { recursive: true });
  for (const f of readdirSync(join(HERE, "scripts"))) {
    copyFileSync(join(HERE, "scripts", f), join(scripts, f));
    chmodSync(join(scripts, f), 0o755);
  }
  const componentPkg = "owlbot-app.pkg";
  run("pkgbuild", ["--root", root, "--install-location", "/", "--identifier", PKG_ID, "--version", VERSION, "--scripts", scripts, "--component-plist", comp, join(build, componentPkg)]);

  // Product archive with the English and Russian Installer pages.
  const resources = join(build, "pkg-resources");
  const catalogs = loadCatalogs();
  for (const locale of LOCALES) {
    const dir = join(resources, `${locale}.lproj`);
    mkdirSync(dir, { recursive: true });
    for (const page of ["welcome", "conclusion"]) writeFileSync(join(dir, `${page}.html`), installerPage(catalogs, locale, page));
  }
  const distribution = join(build, "distribution.xml");
  writeFileSync(distribution, distributionXml({ version: VERSION, componentPkg }));
  run("productbuild", ["--distribution", distribution, "--resources", resources, "--package-path", build, out]);
  return out;
}
```

`packaging/macos/scripts/preinstall`:

```sh
#!/bin/sh
# Runs as root before the files are copied: quits the app of the user at the console (it stops its hub) and removes
# the previous copy, so an upgrade never mixes old and new files. The AppleScript build's LaunchAgent (ai.owlbot.hub)
# goes too. The data in the user's home stays.
APP=/Applications/Owlbot.app
USER_NAME="$(stat -f %Su /dev/console)"
if [ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] && [ "$USER_NAME" != loginwindow ]; then
  USER_ID="$(id -u "$USER_NAME")"
  if [ -x "$APP/Contents/MacOS/Owlbot" ]; then
    launchctl asuser "$USER_ID" sudo -u "$USER_NAME" -H "$APP/Contents/MacOS/Owlbot" --quit 2>/dev/null
    i=0
    while pgrep -f "$APP/Contents/MacOS/Owlbot" >/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
  fi
  launchctl bootout "gui/$USER_ID/ai.owlbot.hub" 2>/dev/null
  rm -f "$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{ print $2 }')/Library/LaunchAgents/ai.owlbot.hub.plist"
fi
rm -rf "$APP"
exit 0
```

`packaging/macos/scripts/postinstall`:

```sh
#!/bin/sh
# Runs as root once the files are in place: opens Owlbot for the user at the console; its first run asks what this
# computer is. With nobody at the console (SSH, MDM) it starts when the user opens it.
APP=/Applications/Owlbot.app
USER_NAME="$(stat -f %Su /dev/console)"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ] || [ "$USER_NAME" = loginwindow ]; then exit 0; fi
launchctl asuser "$(id -u "$USER_NAME")" sudo -u "$USER_NAME" -H open "$APP"
exit 0
```

`packaging/macos/uninstall.sh` (shipped as the app's resource `uninstall.sh`):

```sh
#!/bin/sh
# Removes Owlbot without the Finder (a package install over SSH or MDM); run as root:
#   sudo /Applications/Owlbot.app/Contents/Resources/uninstall.sh <uid> <home> [--delete-data]
# Moving Owlbot.app to the Trash does the same for its user (its start-at-login agent then removes itself). The data
# (~/Library/Application Support/Owlbot) stays unless --delete-data is given.
set -u
USER_ID="$1"
USER_HOME="$2"
BUNDLE="$(cd "$(dirname "$0")/../.." && pwd)"
case "$BUNDLE" in
  *.app) [ -f "$BUNDLE/Contents/Resources/uninstall.sh" ] || exit 1 ;;
  *) echo "uninstall.sh runs from inside Owlbot.app, not from $BUNDLE" >&2; exit 1 ;;
esac
# The app stops its hub when it quits.
launchctl asuser "$USER_ID" sudo -u "#$USER_ID" "$BUNDLE/Contents/MacOS/Owlbot" --quit 2>/dev/null
i=0
while pgrep -f "$BUNDLE/Contents/MacOS/Owlbot" >/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
rm -f "$USER_HOME/Library/LaunchAgents/ai.owlbot.app.plist"
if [ "${3:-}" = --delete-data ]; then
  rm -rf "$USER_HOME/Library/Application Support/Owlbot" "$USER_HOME/Library/Application Support/ai.owlbot.app"
fi
rm -rf "$BUNDLE"
pkgutil --forget ai.owlbot.pkg >/dev/null 2>&1
exit 0
```

Run: `chmod 755 packaging/macos/scripts/preinstall packaging/macos/scripts/postinstall packaging/macos/uninstall.sh`

- [ ] **Step 4: The build script and npm script**

`packaging/desktop/build.mjs`:

```js
// Builds the Owlbot desktop app (packages/desktop, Tauri) and its installers on this OS:
//   npm run package:desktop [-- --skip-build] [-- --skip-stage]
// macOS:   dist/desktop/owlbot-<version>.dmg (drag to Applications) and owlbot-<version>.pkg (silent installs).
//          Universal: needs the aarch64-apple-darwin and x86_64-apple-darwin Rust targets.
// Windows: dist/desktop/owlbot-setup-<version>-x64.exe (NSIS, per user; /S silent, /NOSTART).
// The staged hub (stage.mjs) is the app's resource "app".

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, VERSION, npm, stage } from "./stage.mjs";
import { loadCatalogs } from "./locales.mjs";
import { buildPkg } from "../macos/pkg.mjs";
import { nsisHooks } from "../windows/generate.mjs";

const mac = process.platform === "darwin";
if (!mac && process.platform !== "win32") throw new Error("package:desktop runs on macOS or Windows");
const OUT = join(ROOT, "dist", "desktop");
const TAURI = join(ROOT, "packages", "desktop", "src-tauri");
const target = mac ? "darwin" : "win-x64";

const { values } = parseArgs({ options: { "skip-build": { type: "boolean" }, "skip-stage": { type: "boolean" } } });
const app = values["skip-stage"] ? join(OUT, `stage-${target}`, "app") : await stage({ target, skipBuild: !!values["skip-build"] });
if (!existsSync(join(app, "packaging", "desktop", "launch.mjs"))) throw new Error(`no staged app in ${app}`);
npm(["run", "build:ui", "-w", "@owlbot/desktop"], { cwd: ROOT });

const build = join(OUT, mac ? "build-mac" : "build-win");
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
// A mapped folder keeps its layout under the target (tauri-utils walks it).
const resources = { [app]: "app" };
const config = { bundle: { resources } };
if (mac) {
  resources[join(ROOT, "packaging", "macos", "uninstall.sh")] = "uninstall.sh";
} else {
  const hooks = join(build, "nsis-hooks.nsh");
  writeFileSync(hooks, nsisHooks(loadCatalogs()));
  config.bundle.windows = { nsis: { installerHooks: hooks } };
}
const configFile = join(build, "tauri.build.json");
writeFileSync(configFile, JSON.stringify(config, null, 2));

const triple = mac ? "universal-apple-darwin" : undefined;
npm(["run", "tauri", "-w", "@owlbot/desktop", "--", "build", "--config", configFile, "--bundles", mac ? "app,dmg" : "nsis", ...(triple ? ["--target", triple] : [])], { cwd: ROOT });

const bundle = join(TAURI, "target", ...(triple ? [triple] : []), "release", "bundle");
if (mac) {
  const dmg = join(OUT, `owlbot-${VERSION}.dmg`);
  copyFileSync(join(bundle, "dmg", `Owlbot_${VERSION}_universal.dmg`), dmg);
  const pkg = buildPkg({ appBundle: join(bundle, "macos", "Owlbot.app"), build, out: join(OUT, `owlbot-${VERSION}.pkg`) });
  console.log(`disk image: ${dmg}\npackage:    ${pkg}`);
} else {
  const setup = join(OUT, `owlbot-setup-${VERSION}-x64.exe`);
  copyFileSync(join(bundle, "nsis", `Owlbot_${VERSION}_x64-setup.exe`), setup);
  console.log(`installer: ${setup}`);
}
```

Root `package.json` scripts: delete `"package:win"` and `"package:mac"`, add:

```json
    "package:desktop": "node packaging/desktop/build.mjs"
```

- [ ] **Step 5: Remove the old installers and their texts**

```bash
git rm -r packaging/windows/owlbot.iss packaging/windows/build.mjs packaging/windows/tray packaging/macos/build.mjs packaging/macos/bin
```

`packaging/desktop/locales/en.json` and `ru.json`: delete the keys no code uses any more: `tray.tooltip`, `tray.running`, `tray.restarting`, `tray.failed`, `tray.portBusy`, `tray.noRuntime`, `setup.autostart`, `setup.open`, `mac.notStarted`, `mac.ok`, `mac.moveFirst`, and any `mac.uninstall.*`. Keep `tray.open`, `tray.autostart`, `tray.logs`, `tray.restart`, `tray.quit`, `tray.starting`, `setup.deleteData`, `mac.welcome.*`, `mac.conclusion.*` and the Task 5 keys. Set the package's final page to:

```json
  "mac.conclusion.body": "Owlbot is opening now: choose how this computer is used. Later, open it from Applications or the menu bar.\n\nTo remove it, move Owlbot from Applications to the Trash. Your data stays in ~/Library/Application Support/Owlbot.",
```

```json
  "mac.conclusion.body": "Owlbot сейчас откроется: выберите, как будет работать этот компьютер. Потом открывайте его из «Программ» или из строки меню.\n\nЧтобы удалить его, перетащите Owlbot из «Программ» в Корзину. Ваши данные останутся в ~/Library/Application Support/Owlbot.",
```

Run: `grep -rn "tray.tooltip\|tray.noRuntime\|setup.autostart\|mac.notStarted\|mac.moveFirst\|mac.uninstall" packaging packages --include=*.mjs --include=*.ts --include=*.rs`
Expected: no matches.

- [ ] **Step 6: Run the tests and build on this Mac**

Run: `npx vitest run packages/core/test/desktop-packaging.test.ts packages/core/test/i18n.test.ts && npm run typecheck`
Expected: PASS.

Ask the user before installing the Intel Rust target. With their OK:

```bash
rustup target add x86_64-apple-darwin
npm run package:desktop
```

The disk image step arranges its Finder window through AppleScript: macOS asks once whether the terminal may control Finder. Allow it, or build with `CI=true npm run package:desktop` (the bundler then skips the styling, as on the CI runners).

Expected (several minutes): `disk image: …/dist/desktop/owlbot-0.1.0.dmg` and `package: …/dist/desktop/owlbot-0.1.0.pkg`. Check without installing anything over the user's own install:

```bash
hdiutil attach -nobrowse -readonly -mountpoint /tmp/owl-image dist/desktop/owlbot-0.1.0.dmg
ls /tmp/owl-image
codesign --verify --strict /tmp/owl-image/Owlbot.app && echo signed
codesign -dv /tmp/owl-image/Owlbot.app/Contents/Resources/app/runtime/arm64/bin/node 2>&1 | grep TeamIdentifier
lipo -archs /tmp/owl-image/Owlbot.app/Contents/MacOS/Owlbot
hdiutil detach /tmp/owl-image
pkgutil --payload-files dist/desktop/owlbot-0.1.0.pkg | grep -c "Owlbot.app/Contents/Resources/app/"
```

Expected: `Applications Owlbot.app`; `signed`; `TeamIdentifier=HX7739G8FX`; `x86_64 arm64`; a count in the thousands.

Then run the built app once in isolation (as in Task 10 Step 6, without `OWLBOT_APP_ROOT`): copy it to a scratch folder and start `<scratch>/Owlbot.app/Contents/MacOS/Owlbot` with `OWLBOT_DATA_DIR`/`OWLBOT_NODE_HOME` set; choose the hub; check `curl -s http://127.0.0.1:18080/api/auth/state`; quit from the menu.

- [ ] **Step 7: Commit**

```bash
git add -A packaging package.json packages/core/test/desktop-packaging.test.ts
git commit -m "Desktop installers from the Tauri app: .dmg, silent .pkg, NSIS; the old installers go"
```

---

### Task 12: CI and READMEs

**Files:**
- Modify: `.github/workflows/desktop.yml`, `README.md`, `README.ru.md`

**Interfaces:**
- Consumes: `npm run package:desktop`, the app flags `--mode hub --background` and `--quit`, `uninstall.sh`, the NSIS `/S /NOSTART`.

- [ ] **Step 1: Rewrite the workflow**

`.github/workflows/desktop.yml`:

```yaml
# Builds the desktop app and its installers and checks them on clean runners: install, the hub answers, quit,
# uninstall, the data stays.
name: desktop app

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: ["packaging/**", "packages/desktop/**", "package.json", "package-lock.json", ".github/workflows/desktop.yml"]
  pull_request:
    paths: ["packaging/**", "packages/desktop/**", "package.json", "package-lock.json", ".github/workflows/desktop.yml"]

jobs:
  windows:
    runs-on: windows-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: packages/desktop/src-tauri
      - run: npm ci
      - run: npm run build:ui -w @owlbot/desktop
      - run: cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
      - run: npm run package:desktop
      - name: Install, start, check, quit, uninstall
        shell: pwsh
        run: |
          $ErrorActionPreference = "Stop"
          $setup = (Get-ChildItem dist/desktop/owlbot-setup-*-x64.exe | Select-Object -First 1).FullName
          $p = Start-Process $setup -ArgumentList "/S", "/NOSTART" -PassThru
          $p.WaitForExit(600000) | Out-Null
          if ($p.ExitCode -ne 0) { throw "setup exited with $($p.ExitCode)" }
          $app = "$env:LOCALAPPDATA\Owlbot"
          if (-not (Test-Path "$app\Owlbot.exe")) { throw "Owlbot.exe is missing" }
          if (-not (Test-Path "$app\app\packaging\desktop\launch.mjs")) { throw "the hub is missing" }

          Start-Process "$app\Owlbot.exe" -ArgumentList "--mode", "hub", "--background"
          $state = $null
          for ($i = 0; $i -lt 120 -and -not $state; $i++) {
            try { $state = Invoke-RestMethod http://127.0.0.1:8080/api/auth/state } catch { Start-Sleep 1 }
          }
          if (-not $state) { Get-Content "$app\logs\*.log" -ErrorAction SilentlyContinue; throw "the hub did not answer" }
          if ($state.hasPassword) { throw "a fresh hub has a password" }
          $run = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run")."Owlbot"
          if ($run -ne "`"$app\Owlbot.exe`" --background") { throw "Run value: $run" }

          Start-Process "$app\Owlbot.exe" -ArgumentList "--quit" -Wait
          $down = $false
          for ($i = 0; $i -lt 30 -and -not $down; $i++) {
            try { Invoke-RestMethod http://127.0.0.1:8080/api/auth/state | Out-Null; Start-Sleep 1 } catch { $down = $true }
          }
          if (-not $down) { throw "the hub still answers after --quit" }

          Start-Process "$app\uninstall.exe" -ArgumentList "/S" -Wait
          for ($i = 0; $i -lt 60 -and (Test-Path "$app\Owlbot.exe"); $i++) { Start-Sleep 1 }
          if (Test-Path "$app\Owlbot.exe") { throw "not uninstalled" }
          if (-not (Test-Path "$app\owlbot.db")) { throw "the data is gone" }
          $left = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue)."Owlbot"
          if ($left) { throw "the Run value is still there" }
          "ok"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: windows-installer
          path: dist/desktop/owlbot-setup-*.exe
          if-no-files-found: ignore

  macos:
    runs-on: macos-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: packages/desktop/src-tauri
      - run: npm ci
      - run: npm run build:ui -w @owlbot/desktop
      - run: cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
      - run: npm run package:desktop
      - name: "Disk image: drag to Applications, run, quit"
        run: |
          set -eu
          data="$HOME/Library/Application Support/Owlbot"
          up() { curl -fsS http://127.0.0.1:8080/api/auth/state >state.json 2>/dev/null; }
          down() { ! up; }
          wait_for() { i=0; until "$@"; do i=$((i + 1)); if [ "$i" -ge 120 ]; then echo "timed out: $*"; cat "$data/logs/"*.log || true; exit 1; fi; sleep 1; done; }

          dmg=$(ls dist/desktop/owlbot-*.dmg | head -n 1)
          hdiutil attach -nobrowse -readonly -mountpoint /tmp/owl-image "$dmg"
          test "$(readlink /tmp/owl-image/Applications)" = /Applications
          codesign --verify --strict /tmp/owl-image/Owlbot.app
          codesign -dv /tmp/owl-image/Owlbot.app/Contents/Resources/app/runtime/arm64/bin/node 2>&1 | grep -q "TeamIdentifier=HX7739G8FX"
          lipo -archs /tmp/owl-image/Owlbot.app/Contents/MacOS/Owlbot | grep -q x86_64
          ditto /tmp/owl-image/Owlbot.app /Applications/Owlbot.app
          hdiutil detach /tmp/owl-image

          /Applications/Owlbot.app/Contents/MacOS/Owlbot --mode hub --background &
          wait_for up
          grep -q '"hasPassword":false' state.json
          node /Applications/Owlbot.app/Contents/Resources/app/packaging/desktop/launch.mjs url | grep -Eq '^http://localhost:8080/#setup=[A-Za-z0-9_-]+$'
          grep -q "/Applications/Owlbot.app/Contents/MacOS/Owlbot" "$HOME/Library/LaunchAgents/ai.owlbot.app.plist"

          /Applications/Owlbot.app/Contents/MacOS/Owlbot --quit
          wait_for down
          test -f "$data/owlbot.db"
          # The package check starts from a first run again (the data stays).
          rm -rf /Applications/Owlbot.app "$HOME/Library/Application Support/ai.owlbot.app" "$HOME/Library/LaunchAgents/ai.owlbot.app.plist"
          echo ok
      - name: "Package: silent install, run, uninstall"
        run: |
          set -eu
          data="$HOME/Library/Application Support/Owlbot"
          up() { curl -fsS http://127.0.0.1:8080/api/auth/state >state.json 2>/dev/null; }
          down() { ! up; }
          wait_for() { i=0; until "$@"; do i=$((i + 1)); if [ "$i" -ge 120 ]; then echo "timed out: $*"; cat "$data/logs/"*.log || true; exit 1; fi; sleep 1; done; }

          pkg=$(ls dist/desktop/owlbot-*.pkg | head -n 1)
          pkgutil --payload-files "$pkg" | grep -q "Applications/Owlbot.app/Contents/Resources/uninstall.sh"
          sudo installer -pkg "$pkg" -target /
          test -x /Applications/Owlbot.app/Contents/MacOS/Owlbot
          # The postinstall opened the app at its first run; this makes the choice through it (or starts it).
          /Applications/Owlbot.app/Contents/MacOS/Owlbot --mode hub --background &
          wait_for up

          sudo /bin/sh /Applications/Owlbot.app/Contents/Resources/uninstall.sh "$(id -u)" "$HOME"
          wait_for down
          test ! -e /Applications/Owlbot.app
          test ! -e "$HOME/Library/LaunchAgents/ai.owlbot.app.plist"
          if pkgutil --pkg-info ai.owlbot.pkg >/dev/null 2>&1; then echo "the package receipt is still there"; exit 1; fi
          test -f "$data/owlbot.db"
          echo ok
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: macos-installers
          path: |
            dist/desktop/owlbot-*.dmg
            dist/desktop/owlbot-*.pkg
          if-no-files-found: ignore
```

- [ ] **Step 2: README.md**

Replace the section `### On your computer (Windows, macOS)` up to (not including) `### On a server (Docker)` with:

```markdown
### On your computer (Windows, macOS)

Get the app: `owlbot-setup-<version>-x64.exe` for Windows 10 and 11, `owlbot-<version>.dmg` for macOS 13.5 or later (Apple silicon and Intel). It brings everything it needs: no Node.js, Docker or WSL. To build it yourself, see [Desktop app](#desktop-app).

1. On Windows, run the installer: it installs for your user only and needs no administrator rights. On macOS, open the disk image, drag Owlbot to Applications and open it from there.
2. The app asks how you will use this computer:
   - **A new Owlbot on this computer**: the hub starts here and opens in the app's window. Choose a password and you are in (no setup code to copy). From then on the app signs its window in by itself.
   - **Connect to my Owlbot**: your hub runs elsewhere and this computer becomes one of its machines. Paste the hub's address and the code from its **Machines** page, or click **Connect with the app** there. The window then shows that hub.
3. Closing the window keeps Owlbot running in the background (Telegram, tasks, reminders); its icon in the menu bar or tray has Open, Start at login, Show log, Restart, Set up again… and Quit. It starts by itself when you sign in to your computer.

Claude Code and Codex: if one is already installed on the computer, Owlbot uses it. If not, pressing **Sign in** on its card installs it for Owlbot (a one-time download of a few hundred MB), then the sign-in starts.

Your data stays in `%LOCALAPPDATA%\Owlbot` (Windows) or `~/Library/Application Support/Owlbot` (macOS); upgrading keeps it. To upgrade on macOS, drag the new Owlbot to Applications and replace the old one. To uninstall, use **Settings → Apps** on Windows (it asks before deleting your data) or move Owlbot from Applications to the Trash on macOS (the data stays; delete `~/Library/Application Support/Owlbot` to remove it too). The hub is reachable from this computer only; for your phone, see [Remote access](#remote-access).

The desktop version runs the hub, plugins and CLI brains as your own user: the Docker image's separate Unix users and its kernel-level network block are not there. For the strongest isolation, run Owlbot in Docker.

The app is not signed yet. Windows SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**. If macOS refuses to open it, choose **Open Anyway** in **System Settings → Privacy & Security** (on macOS 13 and 14, Control-clicking the app and choosing **Open** works too).
```

Replace the section `### Desktop installers` up to (not including) `## License` with:

```markdown
### Desktop app

```bash
npm run package:desktop   # on Windows: dist/desktop/owlbot-setup-<version>-x64.exe
                          # on macOS:   dist/desktop/owlbot-<version>.dmg and .pkg
```

The app lives in `packages/desktop` (Tauri 2: Rust in `src-tauri`, its setup screens in `ui`). The build compiles the UIs, stages the hub with its production `node_modules` and the official Node 24 build, checked against the release's SHA-256 (`packaging/desktop/stage.mjs`; `NODE_VERSION` picks another release), and bundles it into the app. It needs Rust from [rustup](https://rustup.rs); on macOS also the Intel target for the universal build (`rustup target add x86_64-apple-darwin`) and Xcode's command line tools. App and installer texts live in `packaging/desktop/locales/{en,ru}.json`.

Silent installs: `owlbot-setup-<version>-x64.exe /S` (add `/NOSTART` to leave it stopped) on Windows; `sudo installer -pkg owlbot-<version>.pkg -target /` on macOS (over SSH or MDM), and `sudo /Applications/Owlbot.app/Contents/Resources/uninstall.sh <uid> <home> [--delete-data]` removes it again. `Owlbot --mode hub --background` makes the first-run choice without a window, `Owlbot --quit` stops the running app. `.github/workflows/desktop.yml` builds both on clean runners and checks that they install, start the hub, quit and uninstall.

To run the app from source without touching an installed Owlbot: stage once (`node packaging/desktop/stage.mjs --skip-build`), then `OWLBOT_APP_ROOT=$PWD/dist/desktop/stage-darwin/app OWLBOT_DATA_DIR=/tmp/owl-data npm run tauri -w @owlbot/desktop -- dev` with `{"port":18080}` in `/tmp/owl-data/desktop.json`. With `OWLBOT_DATA_DIR` set the app writes no start-at-login entries.
```

In the anchor link of the first section (`[Desktop app](#desktop-app)`) the target is this new heading.

- [ ] **Step 3: README.ru.md**

Replace `### На вашем компьютере (Windows, macOS)` up to `### На сервере (Docker)` with:

```markdown
### На вашем компьютере (Windows, macOS)

Возьмите приложение: `owlbot-setup-<version>-x64.exe` для Windows 10 и 11, `owlbot-<version>.dmg` для macOS 13.5 и новее (Apple silicon и Intel). В нём есть всё нужное: Node.js, Docker и WSL не понадобятся. Как собрать его самому, описано в разделе [Приложение для компьютера](#приложение-для-компьютера).

1. В Windows запустите установщик: он ставит Owlbot только для вашего пользователя и не просит прав администратора. В macOS откройте образ диска, перетащите Owlbot в «Программы» и откройте его оттуда.
2. Приложение спросит, как вы будете пользоваться этим компьютером:
   - **Новый Owlbot на этом компьютере**: хаб запустится здесь и откроется в окне приложения. Придумайте пароль, и всё готово (код установки копировать не нужно). Дальше приложение входит в своё окно само.
   - **Подключить к моему Owlbot**: ваш хаб работает в другом месте, а этот компьютер станет одной из его машин. Вставьте адрес хаба и код со страницы **Машины** или нажмите там **Подключить через приложение**. Окно покажет тот хаб.
3. Если закрыть окно, Owlbot продолжит работать в фоне (Telegram, задачи, напоминания); у его значка в строке меню или трее есть пункты «Открыть», «Запускать при входе в систему», «Показать журнал», «Перезапустить», «Настроить заново…» и «Выйти». При входе в систему он запускается сам.

Claude Code и Codex: если один из них уже установлен на компьютере, Owlbot возьмёт его. Если нет, кнопка **Войти** на его карточке установит его для Owlbot (разовая загрузка на несколько сотен МБ), а потом начнётся вход.

Данные лежат в `%LOCALAPPDATA%\Owlbot` (Windows) или `~/Library/Application Support/Owlbot` (macOS); обновление их сохраняет. Чтобы обновить Owlbot в macOS, перетащите новую версию в «Программы» и замените старую. Удалить Owlbot можно в **Параметры → Приложения** в Windows (он спросит, удалять ли ваши данные) или перетащив Owlbot из «Программ» в Корзину в macOS (данные останутся; чтобы удалить и их, удалите `~/Library/Application Support/Owlbot`). Хаб доступен только с этого компьютера; как открыть его с телефона, описано в разделе [Доступ извне](#доступ-извне).

На компьютере хаб, плагины и CLI-мозги работают от вашего пользователя: отдельных Unix-пользователей и блокировки сети на уровне ядра, как в Docker-образе, здесь нет. Для самой строгой изоляции запускайте Owlbot в Docker.

Приложение пока не подписано. Windows SmartScreen может написать «Система Windows защитила ваш компьютер»: нажмите **Подробнее → Выполнить в любом случае**. Если macOS не открывает приложение, нажмите **Все равно открыть** в **Системные настройки → Конфиденциальность и безопасность** (в macOS 13 и 14 можно и щёлкнуть приложение с Control и выбрать **Открыть**).
```

Replace `### Установщики для компьютера` up to `## Лицензия` with:

```markdown
### Приложение для компьютера

```bash
npm run package:desktop   # в Windows: dist/desktop/owlbot-setup-<version>-x64.exe
                          # в macOS:   dist/desktop/owlbot-<version>.dmg и .pkg
```

Приложение лежит в `packages/desktop` (Tauri 2: Rust в `src-tauri`, его экраны настройки в `ui`). Сборка собирает интерфейсы, складывает хаб с production-зависимостями и официальной сборкой Node 24, сверенной с SHA-256 из релиза (`packaging/desktop/stage.mjs`; другой релиз задаёт `NODE_VERSION`), и упаковывает его в приложение. Нужен Rust из [rustup](https://rustup.rs); в macOS ещё цель Intel для универсальной сборки (`rustup target add x86_64-apple-darwin`) и инструменты командной строки Xcode. Тексты приложения и установщиков лежат в `packaging/desktop/locales/{en,ru}.json`.

Тихая установка: `owlbot-setup-<version>-x64.exe /S` (с `/NOSTART` приложение не запустится) в Windows; `sudo installer -pkg owlbot-<version>.pkg -target /` в macOS (по SSH или через MDM), а `sudo /Applications/Owlbot.app/Contents/Resources/uninstall.sh <uid> <home> [--delete-data]` удаляет его. `Owlbot --mode hub --background` делает выбор первого запуска без окна, `Owlbot --quit` останавливает работающее приложение. `.github/workflows/desktop.yml` собирает обе версии на чистых машинах и проверяет, что они ставятся, запускают хаб, выходят и удаляются.

Чтобы запустить приложение из исходников, не трогая установленный Owlbot: один раз подготовьте сборку (`node packaging/desktop/stage.mjs --skip-build`), затем `OWLBOT_APP_ROOT=$PWD/dist/desktop/stage-darwin/app OWLBOT_DATA_DIR=/tmp/owl-data npm run tauri -w @owlbot/desktop -- dev`, а в `/tmp/owl-data/desktop.json` положите `{"port":18080}`. С заданным `OWLBOT_DATA_DIR` приложение не прописывает себя в автозапуск.
```

- [ ] **Step 4: Check the docs and the workflow**

Run: `grep -n "package:win\|package:mac\|Uninstall Owlbot\|Inno Setup 6\|osacompile" README.md README.ru.md .github/workflows/desktop.yml`
Expected: no matches.

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/desktop.yml"); puts "ok"'`
Expected: `ok`. The workflow itself runs once this is pushed (only when the user asks to push).

- [ ] **Step 5: Full check**

Run: `npm run typecheck && npm test && cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
Expected: typecheck clean; vitest passes (the `plugins/browser` tests need Playwright's Chromium: without it three of them fail, as before this work); cargo tests pass.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/desktop.yml README.md README.ru.md
git commit -m "Desktop app: CI builds and checks the installers; README"
```
