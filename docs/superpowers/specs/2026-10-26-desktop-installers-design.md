# Desktop installers for Windows and macOS

Approved 2026-10-26. Docker stays the server install; desktop users get a normal installer.

## Goal

Double-click, done: the hub runs in the background, starts at login and the browser opens the web UI for first-run
setup. No system Node, npm, Docker or WSL.

## Layout

Both installers ship the same app tree, staged by `packaging/desktop/stage.mjs`:

- the repo's runtime files (backend TypeScript sources, built web UI, console, node bundle and UI plugins, builtin
  plugins and agents) and the production `node_modules`;
- the official Node 24 runtime (checked against the release's SHA-256), `runtime/` on Windows, `runtime/arm64` and
  `runtime/x64` on macOS;
- `packaging/desktop/launch.mjs`, the one entry point both platforms run.

npm workspaces link `node_modules/@openbot/*` to `packages/*`, and Node strips types only outside `node_modules`. The
installers carry no links: the stage removes them, and `packaging/desktop/resolve.mjs` (a `module.registerHooks`
resolve hook) maps `@openbot/*` to the workspace folders. The launcher imports it and passes it on through
`NODE_OPTIONS=--import=…`, so plugin processes resolve the same way. Links were tried first: on Windows they are
junctions, and processes Inno Setup starts run under its redirection guard (inherited by children), which refuses to
follow junctions.

## Launcher (`launch.mjs`)

- `node launch.mjs`: sets `OPENBOT_DATA_DIR` (default `%LOCALAPPDATA%\open-bot`, `~/Library/Application Support/open-bot`),
  `OPENBOT_PUBLIC_URL=http://localhost:<port>` (passkeys need a host name), ports from `<data>/desktop.json`, a setup
  code kept in `<data>/setup-code` until the owner is set up, then runs `packages/core/src/cli.ts start` in-process.
  A `stop` line on stdin stops the hub cleanly (Windows has no SIGTERM).
- `node launch.mjs url`: waits for the hub and prints the address to open, `http://localhost:<port>/#setup=<code>` while
  nobody is set up. The web setup form reads the code from the fragment, which never reaches the server.

## Windows

- Inno Setup 6, per-user (`PrivilegesRequired=lowest`), English and Russian, into `%LOCALAPPDATA%\Programs\open-bot`;
  listed in Apps & Features; upgrades in place (same AppId) and keep the data.
- `open-bot.exe`: a tray app in C# compiled with the .NET Framework `csc.exe` every Windows ships. One instance; it runs
  the hub with no window inside a job object (the hub, plugins and CLIs end with it), restarts it after a crash, writes
  `<data>/logs/hub.log`. Menu: Open, Start at login, Restart, Quit. Autostart is the HKCU Run value `open-bot`.
- After the install, Setup starts the tray through `explorer.exe`, not as its own child, so the redirection guard
  does not reach the hub and the CLIs it runs (pnpm workspaces use junctions too).
- Options: `/PORT=18080` writes `<data>/desktop.json` (a second hub next to Docker), `/NOSTART` leaves the tray stopped
  after a silent install.
- Uninstall stops the tray, removes the app and the Run value and asks (default No) before deleting the data dir; a
  silent uninstall keeps it.

## macOS

- A product archive (`pkgbuild` + `productbuild`, English and Russian Installer pages) installing
  `/Applications/open-bot/open-bot.app` (opens the web UI, starts the hub if needed), `Uninstall open-bot.app`, and the
  hub with its scripts in `/Library/Application Support/open-bot/{app,bin}`. The hub stays outside the app bundles, so
  they stay small and their ad-hoc signature valid. Both apps are AppleScript applets (`osacompile`); their text comes
  from the catalogs as ASCII source (`character id {…}`).
- `bin/agent.sh` writes `~/Library/LaunchAgents/ai.openbot.hub.plist` (RunAtLoad, KeepAlive on a crash) and
  bootstraps it; the agent runs `bin/hub.sh`, which picks `runtime/arm64` or `runtime/x64` and logs to
  `<data>/logs/hub.log`. The preinstall stops the hub and removes the old code; the postinstall runs `agent.sh install`
  for the console user and opens the app, which opens the browser. Nobody at the console (SSH): the app sets itself up
  on first open.
- The uninstaller asks, then runs `bin/uninstall.sh` once with administrator rights (agent, plist, both folders, the
  receipt, and the data dir only if the user chose so). Cancelling the password prompt changes nothing.

## Claude Code and Codex

Not bundled (Claude Code may not be redistributed; each is hundreds of MB; both update often). A CLI already on PATH is
used as is. Otherwise, when the user presses Sign in on the chat card, the hub installs the official npm package into
`<data>/tools` with the bundled npm (the card shows "Installing…"), then the usual sign-in runs. Only outside user
isolation: the Docker image already has both CLIs. Plugin installs use the bundled npm too.

## Build and checks

- `npm run package:win` (Windows) → `dist/desktop/open-bot-setup-<version>-x64.exe`.
- `npm run package:mac` (macOS only) → `dist/desktop/open-bot-<version>.pkg`.
- `.github/workflows/desktop.yml` builds both, installs silently, checks `/api/auth/state` and the setup URL,
  uninstalls and checks what is left (the data only).
- Installer text lives in `packaging/desktop/locales/{en,ru}.json`; the i18n parity test covers it.

## Not covered

Code signing and notarization (no certificates yet), Windows on ARM (x64 runs under emulation), a macOS menu-bar app.
