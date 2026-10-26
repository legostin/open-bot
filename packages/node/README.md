# openbot-node: connect a computer to your open-bot hub

[Русский](README.ru.md)

`openbot-node` is a small daemon that connects your computer (a laptop, a workstation, a home server) to an open-bot hub. Once it is connected, the hub's agents can:

- run **brains on this machine's subscriptions**: the Claude Code and Codex you are already signed in to here (`claude-code@<machine>`, `codex@<machine>`);
- **read, write and list files** in the folders you allow (`machine_read_file`, `machine_write_file`, `machine_list_dir`);
- **run commands** (`machine_exec`), but only if you explicitly turn that on.

What is allowed is decided by the **machine's owner** in the local file `~/.openbot-node/policy.json`, not by the hub. The daemon checks every request itself.

The daemon runs on Windows, macOS and Linux. It connects to the hub over an outgoing WebSocket, so you don't need to open any ports on this machine.

## Installation

**The easiest way is a single file from the hub.** All you need is Node.js 24.5+:

```sh
curl -fsSLo openbot-node.mjs https://bot.example.com/download/openbot-node.mjs
node openbot-node.mjs help
```

From then on, type `node openbot-node.mjs` wherever this guide says `openbot-node`.

**From source.** You need Node.js 24.5+ and git.

```sh
git clone <repo> open-bot
cd open-bot
npm install
npx openbot-node help        # run straight from the source folder
```

To make `openbot-node` available in any folder, install the package globally **from this same checkout** (npm links to the folder, so don't delete it):

```sh
npm install -g ./packages/node
openbot-node help
```

Brains run through the CLIs installed on this machine. Install the ones you need and sign in to them the usual way:

- Claude Code: `claude` (sign in with your Claude subscription: `claude`, then `/login`);
- Codex: `npm i -g @openai/codex`, then `codex login`.

The daemon only reports the CLIs that are actually installed (it checks at startup and on every connection).

## Language

The CLI and its log speak English or Russian. The language comes from `OPENBOT_LANG` (`en` or `ru`), then from `LC_ALL`, `LC_MESSAGES` and `LANG`; anything else means English. On Windows, where `LANG` is usually unset, set `OPENBOT_LANG=ru` to get Russian. A service picks the language up from its own environment.

## Pairing

1. In the hub's web UI, go to the **Machines** page, connect a new machine and copy the one-time code (valid for 10 minutes). You can also get one on the hub's command line: `node packages/core/src/cli.ts pairing-code`, or `docker exec openbot openbot-entrypoint pairing-code laptop` in Docker.
2. On this machine:

```sh
openbot-node pair https://bot.example.com AB12CD34 --name laptop
```

The daemon creates an Ed25519 key, sends **only the public key** to the hub and saves:

| File | Contents |
| --- | --- |
| `~/.openbot-node/config.json` | hub address, machine id and name |
| `~/.openbot-node/key.json` | the private key (mode 0600; never share it) |
| `~/.openbot-node/policy.json` | the local policy (created with safe defaults) |
| `~/.openbot-node/brains/` | brain session bookkeeping |

You can move the folder with the `OPENBOT_NODE_HOME` variable.

On every connection the hub sends a random string and the daemon signs it with the key; that is how the hub recognizes the machine. You can revoke the machine in the web UI with one click: the daemon gets a refusal (close code 4401), says so in the log and exits with code 1. To connect the machine again, repeat `pair` with a new code.

## Running

```sh
openbot-node run       # in the terminal, with a log; Ctrl+C stops it
openbot-node status    # pairing, policy, installed CLIs, hub reachability
openbot-node policy    # path and contents of policy.json
```

`run` keeps reconnecting to the hub with a growing pause (up to 60 s), so a hub restart or a network outage needs no attention. Every request from the hub is logged on one line: what, where and the outcome, **without file contents or request text**. For example:

```
[14:02:11] connected to hub https://bot.example.com as "laptop"
[14:02:40] fs.write /home/me/openbot-workspace/report.md (2048 B) → 2048 B (3 ms)
[14:03:05] exec.run npm test → denied: running commands on this machine is disabled (exec.enabled = false in policy.json)
```

## Running as a service

The examples assume the source checkout is in `~/open-bot`; adjust the paths to match yours. The service must see `claude`/`codex` in its `PATH` and run as **your** user, so the CLIs use your sign-in.

### Linux (systemd user service)

`~/.config/systemd/user/openbot-node.service`:

```ini
[Unit]
Description=open-bot node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node %h/open-bot/packages/node/src/cli.ts run
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=10
# Exit code 1: the machine was revoked, is not paired, or policy.json is broken. Don't restart blindly.
RestartPreventExitStatus=1

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now openbot-node
loginctl enable-linger "$USER"          # keep running without a login session
journalctl --user -u openbot-node -f    # log
```

If Node is installed through nvm, use the full path to `node` (`which node`).

### macOS (launchd)

`~/Library/LaunchAgents/dev.openbot.node.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.openbot.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/me/open-bot/packages/node/src/cli.ts</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/openbot-node.log</string>
  <key>StandardErrorPath</key><string>/Users/me/Library/Logs/openbot-node.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.openbot.node.plist
launchctl kickstart -k gui/$(id -u)/dev.openbot.node    # restart
launchctl bootout gui/$(id -u)/dev.openbot.node         # stop (for example, after the machine was revoked)
```

On Intel Macs, `node` usually lives in `/usr/local/bin/node`.

### Windows (Task Scheduler)

In PowerShell, as your own user:

```powershell
$node = (Get-Command node).Source
$cli  = "$HOME\open-bot\packages\node\src\cli.ts"
$log  = "$HOME\.openbot-node\node.log"
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$node`" `"$cli`" run >> `"$log`" 2>&1`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
            -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "openbot-node" -Action $action -Trigger $trigger -Settings $settings -Description "open-bot node"
Start-ScheduledTask -TaskName "openbot-node"
```

The log goes to `%USERPROFILE%\.openbot-node\node.log`. The task starts when you sign in; to run it without a console window and before sign-in, choose "Run whether user is logged on or not" in the task's properties. To remove it: `Unregister-ScheduledTask -TaskName openbot-node`.

## Machines on different networks: Tailscale

If the hub and this machine are on different networks, the simplest fix is to join them with [Tailscale](https://tailscale.com):

1. Install Tailscale on the hub machine and on this one, and sign both in to the same tailnet (`tailscale up`).
2. On the hub, make it listen on its tailnet address and know its name, for example
   `OPENBOT_HOST=0.0.0.0`, `OPENBOT_PUBLIC_URL=http://hub.tailnet-name.ts.net:8080`,
   `OPENBOT_ALLOWED_HOSTS=hub.tailnet-name.ts.net` (on a non-local address the hub needs a password to be set).
   Even easier: run `tailscale serve --bg 8080` on the hub machine to get `https://hub.tailnet-name.ts.net` with TLS.
3. Pair the machine using its tailnet address: `openbot-node pair https://hub.tailnet-name.ts.net <code>`.

Nothing is exposed to the internet this way. The daemon also uses the same address to connect open-bot's tools to the brains (MCP), so there is nothing else to configure.

## Policy (`~/.openbot-node/policy.json`)

The file is created on first start. The daemon re-reads it on the fly: changes are picked up within a couple of seconds, no restart is needed, and the hub receives the updated list of brains and folders. If you save the file with a mistake, the daemon says so in the log and keeps working with the previous version.

Defaults:

```json
{
  "allowedDirs": ["/home/me/openbot-workspace"],
  "exec": { "enabled": false, "allowCommands": [] },
  "fs": { "read": true, "write": true },
  "brains": {
    "claude-code": {
      "enabled": true,
      "allowedTools": ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill", "mcp__openbot"]
    },
    "codex": { "enabled": true, "sandbox": "workspace-write" }
  },
  "workspacesRoot": "/home/me/openbot-workspace"
}
```

| Field | Meaning |
| --- | --- |
| `allowedDirs` | Folders the hub may access. Absolute paths; `~` is allowed. Every path in a request is resolved (symlinks included) and must stay inside one of these folders; paths with `..` are rejected. Relative paths start from the first folder. |
| `fs.read`, `fs.write` | Allow reading/listing and writing files in those folders. Only text files are read, up to 5 MB; a single write is limited to 10 MB. |
| `exec.enabled` | Allow running commands. **Off by default.** |
| `exec.allowCommands` | Patterns of allowed commands (`*` is any run of characters, `?` a single one), for example `["git status", "git log*", "npm test*"]`. An empty list allows any command. When the list is set, commands may not contain `; & | $ < > ^`, `` ` ``, `%VAR%` or line breaks, so nothing can be "glued" onto an allowed command. |
| `exec.shell` | Shell for commands (default `/bin/sh`, `cmd.exe` on Windows), for example `"powershell.exe"`. |
| `exec.maxTimeoutMs` | Time limit for a single command (default 30 minutes). On timeout the whole process tree is killed; output is capped at 1 MB. |
| `brains.claude-code.enabled` / `brains.codex.enabled` | Which of this machine's brains may be used. |
| `brains.claude-code.allowedTools` | Built-in Claude Code tools allowed without asking (everything else is denied). **`Bash` is not included by default.** You can narrow them with Claude Code rules, for example `"Read(//home/me/openbot-workspace/**)"`. |
| `brains.codex.sandbox` | Codex sandbox: `read-only`, `workspace-write` (default: writes only to the session's working folder) or `danger-full-access`. |
| `brains.*.command` | Optional: a custom command or the full path to the CLI if it is not in `PATH`. |
| `workspacesRoot` | Where brain session folders are created: `<workspacesRoot>/<agent>/<task>`. The hub only passes a relative key; keys with `..` and absolute paths are rejected. |

Things to understand:

- **Commands (`exec`) mean full shell access** with your user's rights. The folder restriction only applies to the working directory, not to what the command does. Turn `exec` on deliberately and, where possible, with an `allowCommands` list. By default the hub asks for approval on every `machine_exec` and `machine_write_file`.
- **Brains run with your user's rights** and your subscriptions. What they may do is set by `allowedTools` (Claude Code) and `sandbox` (Codex). Environment variables from the hub are not passed on (except `TZ`, `LANG`, `LANGUAGE` and `LC_*`), and the hub's internal paths are ignored.
- **The `~/.openbot-node` folder is off limits** to the hub's file and command tools, even if it falls inside `allowedDirs`: the hub cannot read the key or rewrite the policy.
- Only the machine's owner edits the policy. The hub never sees all of it; it only receives the list of allowed folders and installed brains.

## Troubleshooting

- **The machine is not paired**: run `openbot-node pair <hub-url> <code>`.
- **The hub rejected pairing because the code is wrong or expired**: codes are single-use and live for 10 minutes; get a new one.
- **Could not reach the hub, connection refused**: the hub is not running, or it listens only on `127.0.0.1` or on another port. Open the address in a browser on this machine to check.
- **The hub does not accept the address**: add the host name to `OPENBOT_ALLOWED_HOSTS` on the hub.
- **The hub rejected the connection (unauthorized)**: the machine was revoked or its key was replaced; pair it again.
- **A brain is missing from the hub's list**: `openbot-node status` shows whether the CLI was found and whether you are signed in; check the service's `PATH`.
