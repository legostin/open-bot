# open-bot

[Русский](README.ru.md)

A friendly, proactive personal agent that lives on your own hardware. open-bot is an open-source alternative to Grok, Meta Muse and OpenAI Dots: an installer for your computer or one Docker image for a server, the subscriptions you already pay for, your own computers, and security from day one. It speaks English and Russian.

## Features

- **Your subscriptions are the brains.** Claude Code (Claude subscription) and Codex (ChatGPT subscription) run as harnesses; the Anthropic, OpenAI and OpenRouter APIs, or any OpenAI-compatible server, act as fallbacks. When a subscription hits its limit, the agent moves on to the next brain and switches back once the limit resets.
- **Proactive.** Reminders, schedules, and watching pages and feeds. Background tasks decide for themselves whether something deserves your attention: stay silent, add it to the digest, send a notification, or ask you.
- **Multiple agents.** Delegate work and run tasks in parallel. Agents are markdown files, each with its own list of brains and tools.
- **Memory.** Long-term memory about you, kept as markdown facts with git history and full-text search. Facts picked up in untrusted sessions wait for your review.
- **MCP and skills.** Connect any MCP server, skill or command. Claude Code and Codex plugins install as they are.
- **Built-in browser.** Chromium inside the container (outside Docker it installs itself on first use): websites, forms, screenshots, sign-in with passwords from the vault, and a live view where you can take over.
- **A network of machines.** Other computers join as nodes. The agent runs commands and works with files on them, and can use their subscriptions (Claude Code or Codex on your laptop).
- **Security.** A vault for passwords and personal data: the model only ever sees `vault://` references. External actions need your approval in a separate console. Plugins and CLI brains run in a sandbox under dedicated Unix users, and all their traffic goes through an egress filter. The audit log is protected by a hash chain.
- **Everything is a plugin, including the UI.** Panels, tabs, tool-result renderers, the composer, channels, brains, tools. See [docs/plugins.md](docs/plugins.md).
- **Channels.** Web UI and Telegram. Mobile and desktop apps will come later.

## Quick start

### On your computer (Windows, macOS)

Use the installer: `open-bot-setup-<version>-x64.exe` for Windows 10 and 11, `open-bot-<version>.pkg` for macOS 13.5 or later (Apple silicon and Intel). It brings everything it needs: no Node.js, Docker or WSL. To build one yourself, see [Desktop installers](#desktop-installers).

1. Run the installer. On Windows it installs for your user only and needs no administrator rights; on macOS it asks for your password, like any package.
2. open-bot starts in the background and opens in your browser. Choose a password and you are in (no setup code to copy).
3. From then on it starts when you sign in to your computer. On Windows it lives in the tray (Open, Start at login, Show log, Restart, Quit); on macOS open it from **Applications → open-bot**.

Claude Code and Codex: if one is already installed on the computer, open-bot uses it. If not, pressing **Sign in** on its card installs it for open-bot (a one-time download of a few hundred MB), then the sign-in starts.

Your data stays in `%LOCALAPPDATA%\open-bot` (Windows) or `~/Library/Application Support/open-bot` (macOS); upgrading keeps it. To uninstall, use **Settings → Apps** on Windows or **Applications → open-bot → Uninstall open-bot** on macOS: both ask before deleting your data. The hub is reachable from this computer only; for your phone, see [Remote access](#remote-access).

The desktop version runs the hub, plugins and CLI brains as your own user: the Docker image's separate Unix users and its kernel-level network block are not there. For the strongest isolation, run open-bot in Docker.

The installers are not signed yet. Windows SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**. If macOS blocks the package, Control-click it and choose **Open**, or allow it in **System Settings → Privacy & Security**.

### On a server (Docker)

```bash
git clone <repo> open-bot && cd open-bot
docker compose up -d --build
docker compose logs openbot | grep -A1 "open-bot:"
```

1. Open http://localhost:8080, enter the **setup code** from the logs and choose a password. Your browser's language becomes the hub language (see [Languages](#languages)).
2. Until a brain works, the chat shows a setup card: sign Claude Code or Codex in with your subscription (on a desktop install the hub can install a missing CLI first), or give an API key (see below). Whatever you write meanwhile is answered as soon as a brain is connected.
3. Then the assistant leads the rest of the setup in the chat, one step at a time and only when you agree: Telegram, a backup brain, other computers, and getting to know you. Say "not now" to skip a step, "let's continue the setup" to come back to it. When something needs a key or a token, the assistant shows a secure field in the chat: the value goes straight into the encrypted vault and the model only ever sees `vault://id`. You can also just paste a token into a message: the hub recognises known formats, takes it out of the message and stores it.

Everything is stored in the `openbot-data` volume (`/data`): the database, the vault, workspaces, CLI logins and plugins.

## Languages

- The **hub language** is taken from the first user's browser during setup. You can pin it with `OPENBOT_LANG=en` or `OPENBOT_LANG=ru`, and change it later in **Settings**. It is used for notifications, Telegram, approval cards, and as the default language of the web UI.
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

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and ask the assistant to connect Telegram: its card takes the token. The bot connects by itself.
2. In the same card, tap **Open the bot in Telegram** and press Start: that links your chat. The bot only answers the private chat it was linked from.

Telegram receives replies, notifications, the digest, and approval cards with buttons. Chat commands: `/help`, `/tasks`, `/stop`. The full details of an action are shown only in the console unless you turn on the `channelApprovalDetails` setting.

## Other computers

1. On the **Machines** page, connect a new machine to get a one-time code (valid for 10 minutes).
2. On the other computer (it only needs Node.js 24.5+), download the daemon from the hub and pair the machine:
   ```bash
   curl -fsSLo openbot-node.mjs https://your-hub-url/download/openbot-node.mjs
   node openbot-node.mjs pair https://your-hub-url <code> --name laptop
   node openbot-node.mjs run
   ```
3. The node appears in the list. Its local Claude Code and Codex become the brains `claude-code@<machine>` and `codex@<machine>`. What the agent may do on the machine (folders, commands, brains) is decided by the machine's owner in `~/.openbot-node/policy.json`; commands are off by default. Running the daemon as a service with systemd, launchd or Task Scheduler is covered in [packages/node/README.md](packages/node/README.md).

## Remote access

Don't publish the ports to the internet directly. The easiest option is [Tailscale](https://tailscale.com): install it on the host and let `tailscale serve` put HTTPS in front of both ports (HTTPS certificates must be enabled for your tailnet):

```bash
tailscale serve --bg --https=8080 http://127.0.0.1:8080
tailscale serve --bg --https=8081 http://127.0.0.1:8081
```

Then tell the hub its addresses:

```yaml
environment:
  OPENBOT_PUBLIC_URL: https://my-box.tailnet.ts.net:8080
  OPENBOT_CONSOLE_URL: https://my-box.tailnet.ts.net:8081
```

Passkeys (passwordless sign-in) need HTTPS or `localhost`; `tailscale serve` takes care of the certificate.

## Security model

- **Two origins.** The chat and plugins live on `:8080`. Approvals, the vault, rules and the audit log live on `:8081`, with their own cookie, a strict CSP and `frame-ancestors 'none'`. Plugin code on the main page cannot read or click anything in the console.
- **Vault.** Secrets are encrypted with XChaCha20-Poly1305 under a data key, which in turn is wrapped by a key derived with Argon2id. Models only ever see `vault://id`. A plugin gets an item only if the item is declared in its permissions **and** the item's scope allows that plugin, domain or agent. Secret values are stripped from everything that goes to models, channels and logs. After a restart the vault is sealed, unless you ticked "unlock automatically" (the passphrase is then kept in `/data/vault.passphrase`, readable by the hub only) or pass a passphrase file through `OPENBOT_VAULT_PASSPHRASE_FILE` (a Docker secret).
- **Tool policy.** Every tool has an effect: `read`, `local-write` or `external`. External actions need approval by default. "Always allow" creates a narrow rule (one recipient, one domain). Once a session has read untrusted content (web, mail), new recipients need approval again. Background tasks of agents with an initiative below 2 can only read and notify.
- **Sandbox.** The hub runs as the `openbot` user, CLI brains as `agent`, other plugins and MCP servers as `plugin`. Their traffic goes through an egress proxy with allowlists. With `cap_add: [NET_ADMIN]` and `OPENBOT_EGRESS_ENFORCED=iptables`, the kernel blocks direct network access for `agent` and `plugin`.
- **Nodes.** Nodes authenticate with an Ed25519 key created during one-time pairing. Every action on a machine has to pass both the hub policy and the node's local policy.
- **Audit.** Every tool call, policy decision, vault access and sign-in is recorded in a hash-chained log. Check its integrity with `docker exec openbot openbot-entrypoint audit-verify` or in the console.

## Container commands

```bash
docker exec openbot openbot-entrypoint reset-password 'new-password'
docker exec openbot openbot-entrypoint pairing-code laptop
docker exec openbot openbot-entrypoint backup /data/backups
docker exec openbot openbot-entrypoint audit-verify
```

- `reset-password` sets a new password (at least 8 characters) and signs out every session.
- `pairing-code [name]` issues a one-time code for connecting a machine.
- `backup [dir]` copies the databases, agents, skills, commands and plugins with their data; the vault stays encrypted.
- `audit-verify` checks the audit log's hash chain and exits with code 2 if it is broken.

## Environment variables

| Variable | Default | |
|---|---|---|
| `OPENBOT_PUBLIC_URL` | `http://localhost:8080` | address of the chat UI, used for links and the Origin check |
| `OPENBOT_CONSOLE_URL` | same host, port 8081 | address of the security console |
| `OPENBOT_ALLOWED_HOSTS` | — | extra host names, comma-separated |
| `OPENBOT_LANG` | — | pins the hub language: `en` or `ru` |
| `OPENBOT_VAULT_PASSPHRASE_FILE` | — | unlocks the vault automatically |
| `OPENBOT_EGRESS_ENFORCED` | `proxy` | `iptables` blocks direct network access outright (needs `NET_ADMIN`) |
| `OPENBOT_SETUP_TOKEN` | random | sets the setup code in advance |
| `OPENBOT_TRUST_PROXY` | — | `1` trusts `X-Forwarded-*` from a reverse proxy |
| `OPENBOT_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | listen address |
| `OPENBOT_PORT`, `OPENBOT_CONSOLE_PORT`, `OPENBOT_EGRESS_PORT` | `8080`, `8081`, `8089` | ports of the chat UI, the console and the egress proxy |
| `OPENBOT_DATA_DIR` | `.data/` (`/data` in the image) | data directory |
| `OPENBOT_INSTALL_CLIS` | — (`1` in the desktop installers) | `1` lets **Sign in** install a missing Claude Code or Codex into `<data>/tools` |
| `TZ` | system time zone (`UTC` in the image) | default time zone for reminders, quiet hours and the digest |

Most behaviour is configured in **Settings** in the web UI: language, time zone, quiet hours, digest times, `channelApprovalDetails` (full action details in Telegram) and `brainEgressAllow` (extra hosts brains may reach). One hub setting has no field on that page yet: `egressPrivateAllow`, the local-network hosts plugins and brains may reach (for example `searxng` or `nas.local`); set it through `PATCH /api/settings`.

## Development

```bash
npm install
npm run build        # web UI, console, UI plugins, node daemon bundle
npm run dev          # hub on :8080 / :8081, egress proxy on :8089 (data in .data/)
npm test             # unit and integration tests
npm run typecheck
```

You need Node.js 24.5+ (TypeScript runs without a build step). Outside Docker the browser plugin downloads Playwright's Chromium by itself the first time it starts without one (a one-time download into Playwright's cache, or `PLAYWRIGHT_BROWSERS_PATH`); browser calls made meanwhile wait for it. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to turn that off and install it yourself with `npx playwright install chromium`. The project layout and conventions are described in [CLAUDE.md](CLAUDE.md), the design in [docs/superpowers/specs](docs/superpowers/specs/2026-10-26-open-bot-design.md) (in Russian). Core messages live in `packages/core/src/locales/{en,ru}.ts`, plugin messages in `.openbot-plugin/locales/{en,ru}.json`; `npm test` checks that every translation matches English.

### Desktop installers

```bash
npm run package:win   # on Windows: dist/desktop/open-bot-setup-<version>-x64.exe
npm run package:mac   # on macOS:   dist/desktop/open-bot-<version>.pkg
```

Both build the UIs, then stage the hub with its production `node_modules` and the official Node 24 build, checked against the release's SHA-256 (`packaging/desktop/stage.mjs`; `NODE_VERSION` picks another release). The Windows build needs Inno Setup 6 (`winget install JRSoftware.InnoSetup`) and compiles the tray app with the C# compiler that ships with Windows; the macOS build uses `pkgbuild`, `productbuild` and `osacompile` from macOS. Installer text lives in `packaging/desktop/locales/{en,ru}.json`.

The Windows installer takes Inno Setup's `/VERYSILENT` plus `/PORT=18080` (another port, say for a second hub next to Docker) and `/NOSTART` (don't start after a silent install). `.github/workflows/desktop.yml` builds both installers on clean runners and checks that they install, start the hub and uninstall.

## License

Apache-2.0
