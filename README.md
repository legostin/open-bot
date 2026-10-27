# Owlbot

[Русский](README.ru.md)

A friendly, proactive personal agent that lives on your own hardware. Owlbot is an open-source alternative to Grok, Meta Muse and OpenAI Dots: an installer for your computer or one Docker image for a server, the subscriptions you already pay for, your own computers, and security from day one. It speaks English and Russian.

## Features

- **Your subscriptions are the brains.** Claude Code (Claude subscription) and Codex (ChatGPT subscription) run as harnesses; the Anthropic, OpenAI and OpenRouter APIs, or any OpenAI-compatible server, act as fallbacks. When a subscription hits its limit, the agent moves on to the next brain and switches back once the limit resets.
- **Proactive.** Reminders, schedules, and watching pages and feeds. Background tasks decide for themselves whether something deserves your attention: stay silent, add it to the digest, send a notification, or ask you.
- **Multiple agents and group chats.** Delegate work and run tasks in parallel. Put several agents into one chat: they see each other's replies, answer when you `@mention` them and hand the floor to each other. Agents are markdown files, each with its own list of brains and tools.
- **A lively chat.** Replies with formatting (headings, lists, tables, code) in the web UI and in Telegram alike. An agent can show a picture, a photo carousel or an OpenStreetMap map right in its message. Send it files, photos and screenshots the same way: the paperclip, a paste or a drop in the web UI, or simply in Telegram, where voice messages, albums and places work too. Voice messages are transcribed before the agent answers: with a Groq key (free tier), an OpenAI key, or your own Whisper server (**Settings → Voice messages**); the assistant offers to set it up when the first one arrives. Forms in the chat fold into a single line once saved, out of your way.
- **Memory.** Long-term memory about you, kept as markdown facts with git history and full-text search. Facts picked up in untrusted sessions wait for your review.
- **MCP and skills.** Connect any MCP server, skill or command. Claude Code and Codex plugins install as they are.
- **Built-in browser.** Chromium inside the container (outside Docker it installs itself on first use): websites, forms, screenshots, sign-in with passwords from the vault, and a live view where you can take over.
- **A network of machines.** Other computers join as nodes. The agent runs commands and works with files on them, and can use their subscriptions (Claude Code or Codex on your laptop).
- **Security.** A vault for passwords and personal data: the model only ever sees `vault://` references. External actions need your approval in a separate console. Plugins and CLI brains run in a sandbox under dedicated Unix users, and all their traffic goes through an egress filter. The audit log is protected by a hash chain.
- **Everything is a plugin, including the UI.** Panels, tabs, tool-result renderers, the composer, channels, brains, tools. See [docs/plugins.md](docs/plugins.md).
- **Channels.** The app for Windows and macOS, the iPhone app (see [Phone](#phone)), the web UI and Telegram.
- **Access from anywhere.** One permanent link to your hub for any browser and the phone app, through Owlbot's own Tailscale node: nothing to install on the phone, no ports to open (see [Access from anywhere](#access-from-anywhere)).

## Quick start

### On your computer (Windows, macOS)

Get the app: `owlbot-setup-<version>-x64.exe` for Windows 10 and 11, `owlbot-<version>.dmg` for macOS 13.5 or later (Apple silicon and Intel). It brings everything it needs: no Node.js, Docker or WSL. To build it yourself, see [Desktop app](#desktop-app).

1. On Windows, run the installer: it installs for your user only and needs no administrator rights. On macOS, open the disk image, drag Owlbot to Applications and open it from there.
2. The app asks how you will use this computer:
   - **A new Owlbot on this computer**: the hub starts here and opens in the app's window. Choose a password and you are in (no setup code to copy). From then on the app signs its window in by itself.
   - **Connect to my Owlbot**: your hub runs elsewhere and this computer becomes one of its machines. Paste the hub's address and the code from its **Machines** page, or click **Connect with the app** there. The window then shows that hub.
3. Closing the window keeps Owlbot running in the background (Telegram, tasks, reminders); its icon in the menu bar or tray has Open, Start at login, Show log, Restart, Set up again…, Reset Owlbot… and Quit. It starts by itself when you sign in to your computer.

Claude Code and Codex: if one is already installed on the computer and signed in, Owlbot uses it, sign-in included — no need to sign in again. If not, pressing **Sign in** on its card installs it for Owlbot (a one-time download of a few hundred MB), then the sign-in starts.

To start from scratch, choose **Reset Owlbot…** in the icon's menu. The app lists what goes: chats, agents, memory, the vault with your secrets, plugins, settings, this computer's connection to a hub and the start-at-login entry. Once you confirm, it deletes all of it and either offers the first-run setup again or quits. Your Claude Code and Codex sign-ins stay: they belong to those tools, not to Owlbot.

Your data stays in `%LOCALAPPDATA%\Owlbot` (Windows) or `~/Library/Application Support/Owlbot` (macOS); upgrading keeps it. To upgrade on macOS, drag the new Owlbot to Applications and replace the old one. To uninstall, use **Settings → Apps** on Windows (it asks before deleting your data) or move Owlbot from Applications to the Trash on macOS (the data stays; to remove it too, first choose **Reset Owlbot… → Delete and quit** in the icon's menu). The hub listens on `http://localhost:41780` (console `:41781`, egress proxy `:41789`), away from ports other tools tend to hold (8080, OpenClaw's 18789); another port goes into `desktop.json` in the data folder as `{"port": 19000}`. It is reachable from this computer only; for your phone, see [Phone](#phone).

The desktop version runs the hub, plugins and CLI brains as your own user: the Docker image's separate Unix users and its kernel-level network block are not there. For the strongest isolation, run Owlbot in Docker.

The app is not signed yet. Windows SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**. If macOS refuses to open it, choose **Open Anyway** in **System Settings → Privacy & Security** (on macOS 13 and 14, Control-clicking the app and choosing **Open** works too).

### On a server (Docker)

```bash
git clone <repo> owlbot && cd owlbot
docker compose up -d --build
docker compose logs owlbot | grep -A1 "Owlbot:"
```

1. Open http://localhost:8080, enter the **setup code** from the logs and choose a password. Your browser's language becomes the hub language (see [Languages](#languages)).
2. Until a brain works, the chat shows a setup card: sign Claude Code or Codex in with your subscription (on a desktop install the hub can install a missing CLI first), or give an API key (see below). Whatever you write meanwhile is answered as soon as a brain is connected.
3. Then the assistant leads the rest of the setup in the chat, one step at a time and only when you agree: Telegram, a backup brain, other computers, and getting to know you. Say "not now" to skip a step, "let's continue the setup" to come back to it. When something needs a key or a token, the assistant shows a secure field in the chat: the value goes straight into the encrypted vault and the model only ever sees `vault://id`. You can also just paste a token into a message: the hub recognises known formats, takes it out of the message and stores it.

Everything is stored in the `owlbot-data` volume (`/data`): the database, the vault, workspaces, CLI logins and plugins.

## Languages

- The **hub language** is taken from the first user's browser during setup. You can pin it with `OWLBOT_LANG=en` or `OWLBOT_LANG=ru`, and change it later in **Settings**. It is used for notifications, Telegram, approval cards, and as the default language of the web UI.
- Each browser can switch the interface language on its own; this does not change the hub language.
- Agents reply in the language you write to them.

## Connecting brains

**Claude Code (Claude Pro/Max subscription) and Codex (ChatGPT subscription)** sign in from the chat. Press **Sign in** next to the brain on the setup card, or ask the assistant ("connect Codex"): a card shows the sign-in page to open.

- **Codex:** enter the one-time code from the card on that page.
- **Claude Code:** sign in, copy the code the page shows and paste it into the card (not into the chat).

The card turns green once the brain is signed in. The login is kept on the server in `/data/home/agent`, so there is nothing to run in a terminal. The **Brains** page has the same buttons.

Claude Code can also use a long-lived token instead: run `claude setup-token` on any computer with Claude Code and paste the token into the chat. It is stored in the vault as **`claude_code_token`** and the Claude Code brain picks it up.

**API keys** (fallback brains, web search): ask the assistant ("connect Brave search") or paste the key into the chat. They are stored in the vault under these ids:

| id | Used for |
|---|---|
| `anthropic_api_key` | the `api:anthropic` brain |
| `openai_api_key` | the `api:openai` brain, Codex with an API key |
| `openrouter_api_key` | the `api:openrouter` brain |
| `custom_llm_api_key` | the `api:custom` brain (Ollama, LM Studio, vLLM or another OpenAI-compatible server), only if your server needs a key |
| `brave_api_key` or `tavily_api_key` | `web_search`; without a key, point the Web plugin settings at your own SearXNG (DuckDuckGo often answers with a bot check) |
| `telegram_bot_token` | the Telegram channel |

The address and model of an OpenAI-compatible server are set in the API brain plugin settings. A server on your local network also has to be listed in the `brainEgressAllow` setting (localhost is always reachable).

The **Brains** page shows the state of every brain: installed, signed in, rate-limited until a given time. The order in which brains are tried is set per agent.

## Group chats

Invite several agents into one chat: in the sidebar, under **Groups**, choose **New group**, give it a name and pick two to eight agents. The first one you pick leads.

- A message without a mention goes to the lead.
- `@name` asks a particular agent: type `@` and the chat suggests the members.
- `@all` has everyone answer in turn, each seeing what was said before.
- An agent can hand the floor to another by mentioning it in its reply (at most three hand-offs per message of yours).

Change a group's name and members with the button next to its name. Group chats live in the app and the web UI; Telegram does not mirror them.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and ask the assistant to connect Telegram: its card takes the token. The bot connects by itself.
2. In the same card, tap **Open the bot in Telegram** and press Start: that links your chat. The bot only answers the private chat it was linked from.

Telegram receives replies (with formatting: bold, lists, code, tables), notifications, the digest, and approval cards with buttons. Pictures in a reply arrive as photos or an album, a map as a location pin. Send the bot photos, albums, files and voice messages up to 20 MB (Telegram's limit for bots) or share a place: the agent gets them in its working folder. A forwarded message or a reply tells the agent where it came from or what it answers. Chat commands: `/help`, `/tasks`, `/stop`. The full details of an action are shown only in the console unless you turn on the `channelApprovalDetails` setting.

## Integrations

**Settings → Integrations** lists the services your agents work with, as cards: access from anywhere, Google Calendar, Telegram, web search and the browser for now. Each card shows its status and the one button that moves it forward. You can also just ask the assistant ("connect my Google Calendar"): it shows the same card in the chat.

**Google Calendar.** Press **Connect with Google**, choose your account and allow access. Google sends the browser back to the hub. If the hub runs on a server or you sign in on a phone, the return page does not open: copy its address from the browser's address bar into the card. The sign-in is kept in the vault, so create or unlock the vault first (the card offers it). Then the agents see your events and free time, can book, move and delete events (each change asks for your approval), and the morning digest lists the day's plan, a later digest tomorrow's.

Owlbot signs in with its own Google client. To use your own instead, create one in [Google Cloud](https://console.cloud.google.com/): a project with the Google Calendar API enabled, the OAuth consent screen (External, In production), and an OAuth client of type **Desktop app**. Then set `OWLBOT_GOOGLE_CLIENT_ID` and `OWLBOT_GOOGLE_CLIENT_SECRET`. Until Google verifies a client's calendar access, the sign-in shows an "unverified app" warning.

## Other computers

1. On the **Machines** page, connect a new machine to get a one-time code (valid for 10 minutes).
2. On the other computer (it only needs Node.js 24.5+), download the daemon from the hub and pair the machine:
   ```bash
   curl -fsSLo owlbot-node.mjs https://your-hub-url/download/owlbot-node.mjs
   node owlbot-node.mjs pair https://your-hub-url <code> --name laptop
   node owlbot-node.mjs run
   ```
3. The node appears in the list. Its local Claude Code and Codex become the brains `claude-code@<machine>` and `codex@<machine>`. What the agent may do on the machine (folders, commands, brains) is decided by the machine's owner in `~/.owlbot-node/policy.json`; commands are off by default. Running the daemon as a service with systemd, launchd or Task Scheduler is covered in [packages/node/README.md](packages/node/README.md).

Under the team in the sidebar (and in the phone app's **Hub** tab) every machine shows whether it is online and, while agents work there, who works on what and what they are doing right now: running a command, reading or editing files, on the web, writing, or waiting for your approval. A row opens that chat or task.

## Phone

The Owlbot iOS app (repository `owlbot-ios`) is the hub in your pocket: your team of agents, the chats with every card, tasks, notifications, and approvals that need Face ID. The phone runs no brains; it connects to this hub.

1. In **Settings → Devices**, press **Connect a phone** and scan the QR code with the app, or open its link on the phone. You can also ask the assistant to "connect my phone", or run `owlbot devices pair` on the server to get the QR in the terminal.
2. Confirm on the phone with Face ID.

The QR gives the phone every address it can use, and the phone takes whichever answers: the hub's own HTTPS port for phones on the home network (the hub's port + 2: 41782 in the desktop app, 8082 on a server; `OWLBOT_DEVICE_PORT`; only this port opens to the network, the web UI stays where it was), the computer's Tailscale address, and the link from [access from anywhere](#access-from-anywhere) (a phone paired before the link learns it on its next connection). `OWLBOT_DEVICES=0` closes the home-network port; phones then use the link alone. The phone pins the hub's own certificate from the QR, so no domain or CA is involved. Its token is revoked in one click in **Devices**; approving an action needs a signature by a key that stays in the phone's Secure Enclave, so a stolen token cannot approve anything. Rules, the vault's items and the audit stay in the security console. In Docker, publish the device port and list the addresses phones should use: `OWLBOT_DEVICE_URLS=https://192.168.1.10:8082`.

## Access from anywhere

**Settings → Integrations → Access from anywhere** gives the hub one permanent link, `https://owlbot.<your-tailnet>.ts.net`. It opens the web UI in any browser and serves the phone app away from home; nothing needs installing on the phone or that other computer. Owlbot runs its own [Tailscale](https://tailscale.com) node (`packages/tailnet`) and opens the link with Tailscale Funnel.

1. Press **Turn on**.
2. **Sign in to Tailscale**: a free account (Google, Apple, GitHub or Microsoft) is enough. The `owlbot` node joins your tailnet.
3. **Allow Funnel**: Tailscale asks the tailnet's admin once.

Through the link come the web UI (sign in with your Owlbot password: passkeys belong to the computer's own address), the phone app and other machines (`owlbot-node pair <link> <code>`). Never through it: the first-run setup, the security console and plugin webhooks; brains on machines paired through the link reach the hub's tools there with their own session tokens. Wrong passwords are counted per address and, through the link, also together: 30 within an hour pause signing in from outside for an hour and notify you, while signing in on the computer keeps working. The node keeps its keys in `<data>/tailnet`; **Forget the node** signs it out of Tailscale and deletes them. Tailscale asks a node to sign in again after 180 days by default: the card warns two weeks ahead, and you can turn key expiry off for `owlbot` in Tailscale's admin console. Owlbot does not send Tailscale its node logs.

The desktop app and the Docker image include the node. When you run from source, build it with `npm run build:tailnet` (needs Go); without it the card says it is unavailable.

### Your own Tailscale or proxy

Don't publish the ports to the internet directly. To reach the security console from elsewhere too, install [Tailscale](https://tailscale.com) on the host and let `tailscale serve` put HTTPS in front of both ports (HTTPS certificates must be enabled for your tailnet):

```bash
tailscale serve --bg --https=8080 http://127.0.0.1:8080
tailscale serve --bg --https=8081 http://127.0.0.1:8081
```

Then tell the hub its addresses:

```yaml
environment:
  OWLBOT_PUBLIC_URL: https://my-box.tailnet.ts.net:8080
  OWLBOT_CONSOLE_URL: https://my-box.tailnet.ts.net:8081
```

Passkeys (passwordless sign-in) need HTTPS or `localhost`; `tailscale serve` takes care of the certificate.

## Security model

- **Two origins.** The chat and plugins live on `:8080`. Approvals, the vault, rules and the audit log live on `:8081`, with their own cookie, a strict CSP and `frame-ancestors 'none'`. Plugin code on the main page cannot read or click anything in the console.
- **Vault.** Secrets are encrypted with XChaCha20-Poly1305 under a data key, which in turn is wrapped by a key derived with Argon2id. Models only ever see `vault://id`. A plugin gets an item only if the item is declared in its permissions **and** the item's scope allows that plugin, domain or agent. Secret values are stripped from everything that goes to models, channels and logs. After a restart the vault is sealed, unless you ticked "unlock automatically" (the passphrase is then kept in `/data/vault.passphrase`, readable by the hub only) or pass a passphrase file through `OWLBOT_VAULT_PASSPHRASE_FILE` (a Docker secret).
- **Tool policy.** Every tool has an effect: `read`, `local-write` or `external`. External actions need approval by default. "Always allow" creates a narrow rule (one recipient, one domain). Once a session has read untrusted content (web, mail), new recipients need approval again. Background tasks of agents with an initiative below 2 can only read and notify.
- **Sandbox.** The hub runs as the `owlbot` user, CLI brains as `agent`, other plugins and MCP servers as `plugin`. Their traffic goes through an egress proxy with allowlists. With `cap_add: [NET_ADMIN]` and `OWLBOT_EGRESS_ENFORCED=iptables`, the kernel blocks direct network access for `agent` and `plugin`.
- **Nodes.** Nodes authenticate with an Ed25519 key created during one-time pairing. Every action on a machine has to pass both the hub policy and the node's local policy.
- **Audit.** Every tool call, policy decision, vault access and sign-in is recorded in a hash-chained log. Check its integrity with `docker exec owlbot owlbot-entrypoint audit-verify` or in the console.

## Container commands

```bash
docker exec owlbot owlbot-entrypoint reset-password 'new-password'
docker exec owlbot owlbot-entrypoint pairing-code laptop
docker exec owlbot owlbot-entrypoint backup /data/backups
docker exec owlbot owlbot-entrypoint audit-verify
```

- `reset-password` sets a new password (at least 8 characters) and signs out every session.
- `pairing-code [name]` issues a one-time code for connecting a machine.
- `backup [dir]` copies the databases, agents, skills, commands and plugins with their data; the vault stays encrypted.
- `audit-verify` checks the audit log's hash chain and exits with code 2 if it is broken.

## Environment variables

| Variable | Default | |
|---|---|---|
| `OWLBOT_PUBLIC_URL` | `http://localhost:8080` | address of the chat UI, used for links and the Origin check |
| `OWLBOT_CONSOLE_URL` | same host, port 8081 | address of the security console |
| `OWLBOT_ALLOWED_HOSTS` | — | extra host names, comma-separated |
| `OWLBOT_LANG` | — | pins the hub language: `en` or `ru` |
| `OWLBOT_VAULT_PASSPHRASE_FILE` | — | unlocks the vault automatically |
| `OWLBOT_EGRESS_ENFORCED` | `proxy` | `iptables` blocks direct network access outright (needs `NET_ADMIN`) |
| `OWLBOT_SETUP_TOKEN` | random | sets the setup code in advance |
| `OWLBOT_TRUST_PROXY` | — | `1` trusts `X-Forwarded-*` from a reverse proxy |
| `OWLBOT_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | listen address |
| `OWLBOT_PORT`, `OWLBOT_CONSOLE_PORT`, `OWLBOT_EGRESS_PORT` | `8080`, `8081`, `8089` | ports of the chat UI, the console and the egress proxy |
| `OWLBOT_DEVICE_PORT`, `OWLBOT_DEVICE_HOST` | port + 2 (`8082`), `0.0.0.0` | the phones' HTTPS port and where it listens |
| `OWLBOT_DEVICES` | — | `0` closes the phones' port on the network: phones then reach the hub only through the link |
| `OWLBOT_DEVICE_URLS` | detected | addresses for the pairing QR, comma-separated, ahead of the detected ones |
| `OWLBOT_DATA_DIR` | `.data/` (`/data` in the image) | data directory |
| `OWLBOT_INSTALL_CLIS` | — (`1` in the desktop installers) | `1` lets **Sign in** install a missing Claude Code or Codex into `<data>/tools` |
| `OWLBOT_GOOGLE_CLIENT_ID`, `OWLBOT_GOOGLE_CLIENT_SECRET` | Owlbot's client | your own Google OAuth client (type Desktop app) for Google integrations |
| `OWLBOT_TAILNET_BIN` | `packages/tailnet/bin/<platform>-<arch>/owlbot-tailnet` | the hub's Tailscale node for access from anywhere |
| `OWLBOT_TAILNET_HOSTNAME` | `owlbot` | the node's name in your tailnet: the link's first label |
| `TZ` | system time zone (`UTC` in the image) | default time zone for reminders, quiet hours and the digest |

Most behaviour is configured in **Settings** in the web UI: language, time zone, quiet hours, digest times, `channelApprovalDetails` (full action details in Telegram) and `brainEgressAllow` (extra hosts brains may reach). One hub setting has no field on that page yet: `egressPrivateAllow`, the local-network hosts plugins and brains may reach (for example `searxng` or `nas.local`); set it through `PATCH /api/settings`.

## Development

```bash
npm install
npm run build        # web UI, console, UI plugins, node daemon bundle
npm run build:tailnet  # the hub's Tailscale node (Go; --all for every platform)
npm run dev          # hub on :8080 / :8081, egress proxy on :8089 (data in .data/)
npm test             # unit and integration tests
npm run typecheck
```

You need Node.js 24.5+ (TypeScript runs without a build step). Outside Docker the browser plugin downloads Playwright's Chromium by itself the first time it starts without one (a one-time download into Playwright's cache, or `PLAYWRIGHT_BROWSERS_PATH`); browser calls made meanwhile wait for it. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to turn that off and install it yourself with `npx playwright install chromium`. The project layout and conventions are described in [CLAUDE.md](CLAUDE.md), the design in [docs/superpowers/specs](docs/superpowers/specs/2026-10-26-open-bot-design.md) (in Russian). Core messages live in `packages/core/src/locales/{en,ru}.ts`, plugin messages in `.owlbot-plugin/locales/{en,ru}.json`; `npm test` checks that every translation matches English.

### Desktop app

```bash
npm run package:desktop   # on Windows: dist/desktop/owlbot-setup-<version>-x64.exe
                          # on macOS:   dist/desktop/owlbot-<version>.dmg and .pkg
```

The app lives in `packages/desktop` (Tauri 2: Rust in `src-tauri`, its setup screens in `ui`). The build compiles the UIs, stages the hub with its production `node_modules` and the official Node 24 build, checked against the release's SHA-256 (`packaging/desktop/stage.mjs`; `NODE_VERSION` picks another release), and bundles it into the app. It needs Rust from [rustup](https://rustup.rs); on macOS also the Intel target for the universal build (`rustup target add x86_64-apple-darwin`) and Xcode's command line tools. App and installer texts live in `packaging/desktop/locales/{en,ru}.json`.

Silent installs: `owlbot-setup-<version>-x64.exe /S` (add `/NOSTART` to leave it stopped) on Windows; `sudo installer -pkg owlbot-<version>.pkg -target /` on macOS (over SSH or MDM), and `sudo /Applications/Owlbot.app/Contents/Resources/uninstall.sh <uid> <home> [--delete-data]` removes it again. `Owlbot --mode hub --background` makes the first-run choice without a window, `Owlbot --quit` stops the running app. `.github/workflows/desktop.yml` builds both on clean runners and checks that they install, start the hub, quit and uninstall.

To try a build next to an installed Owlbot, add `-- --test`: it makes **Owlbot Test** (`owlbot-test-<version>.dmg`, `owlbot-test-setup-<version>-x64.exe`) with its own data, machine pairing, start-at-login entry and ports right after the app's (41790, console 41791, egress proxy 41799). Its window titles, tray menu and setup screens say it is a test build.

To run the app from source without touching an installed Owlbot: stage once (`node packaging/desktop/stage.mjs --skip-build`), then `OWLBOT_APP_ROOT=$PWD/dist/desktop/stage-darwin/app OWLBOT_DATA_DIR=/tmp/owl-data npm run tauri -w @owlbot/desktop -- dev` with `{"port":18080}` in `/tmp/owl-data/desktop.json`. With `OWLBOT_DATA_DIR` set the app writes no start-at-login entries.

## License

Apache-2.0
