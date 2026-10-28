# Owlbot polish: style, rich chat, group chats, reset

2026-10-27, from the user's brief for the morning build: a polished app in a new Owlbot style with a 0_0 logo in white
on black, group chats, markdown in every channel, a reset that deletes all app data, images and carousels in the
chat, and OpenStreetMap maps. Builds on `2026-10-26-desktop-app-design.md`.

## Style

- **Mark.** `0_0` drawn as shapes (two rounded-rectangle zeros and an underscore), white on a black rounded square:
  `packages/web/public/favicon.svg` (also the console's). `packaging/assets/app-icon.svg` puts it on Apple's icon grid
  for the macOS `.icns`; `packaging/assets/tray.svg` is the glyph alone, a template image for the macOS menu bar.
  `packaging/desktop/make-icons.mjs` renders all icons from these.
- **Palette.** Ink on paper: neutral greys, black (light) or white (dark) as the accent and the user's bubble
  (`--user-bubble`, `--user-bubble-fg`), muted semantic colours. Same in the console (neutral accent scale) and the
  desktop setup screens.
- **Forms lock when done.** A secret request collapses once saved; a plugin's setup card that is done and a brain's
  sign-in card that is signed in fold into one locked line (the setup card keeps a Change button).
- **Layout.** The settings panel sits next to the chat from 1280px; narrower, it is a sheet over the chat. The chat's
  top bar is a container: its badges, plugin status items, brain picker and settings button show by the bar's own
  width, so the agent's name stays readable next to the panel and on a phone.
- **Installers.** The `.dmg` window has a background with an arrow to Applications (`packaging/assets/dmg-background.svg`,
  rendered to a Retina TIFF). Tauri applies it through Finder, a step it skips with `CI=true`.

## Rich chat (images, carousels, maps)

- Message parts `images` (`items: {src, alt?, caption?}[]`; one item is an image, more a carousel) and `map`
  (`lat, lon, zoom?, title?, markers?`). `src` is an http(s) URL or `file:<path under the workspaces>`.
- Every agent has the tools `show_images` and `show_map`; the runner attaches the part to the message being written
  and `deliver()` sends it to channels as `media`.
- The CSP stays `'self'`: external images go through `GET /api/media?url=` (authenticated, http(s) only, private
  addresses refused, image types only, size limit, disk cache) and map tiles through `GET /api/map/tiles/:z/:x/:y.png`
  (OpenStreetMap's tile server, an identifying User-Agent, a disk cache, the OSM attribution on every map).
- The web shows an image with a lightbox, a carousel with scroll-snap, buttons, dots and swipe, a Leaflet map loaded on
  demand. Markdown images from other sites render through the media proxy.
- Telegram: `sendPhoto` / `sendMediaGroup` (by URL or uploaded), `sendLocation` for a map.

## Markdown in every channel

The web renders markdown (react-markdown + GFM) in the agents' replies and in the user's own messages, where line breaks
stay as typed and `vault://` references stay lock chips. Telegram converts it to its HTML; tables become aligned
monospace blocks, task lists ☐/☑, images 🖼 links.

## Group chats

A conversation kind `group` with `members` (2–8 agents, the first is the lead). A message without a mention goes to
the lead; `@id` / `@name` picks agents, `@all` / `@все` asks everyone in turn; an agent that writes `@id` in its answer
hands the floor on (three hand-offs at most per message). Before its turn each agent gets what it has not seen yet as
`[Name]: text` lines (pictures and maps as `[showed …]`), and its system prompt names the participants. Stop ends the
current turn and drops the members still waiting. The sidebar lists groups and creates them; the header edits the
title and members; the composer completes `@mentions` (`@все` in the Russian UI). Groups are not mirrored to channels.
The sidebar previews a reply that only shows pictures or a map as 🖼 or 📍 with its caption or title.

## Reset

Tray → "Reset Owlbot…" asks in the setup window: what goes (chats, agents, memory, the vault, plugins, settings, the
machine pairing, the start-at-login entry) and what stays (the user's Claude Code and Codex logins). Confirmed, the app
stops the hub, clears the window's browsing data, deletes the data and starts at the first run again, or quits. On
Windows the installer shares the data folder, so the app's own files there stay (`reset.rs`).

The hub's settings page offers the same in the app's window ("This app": Quit and Reset Owlbot…). The hub window
announces the app as `window.owlbotDesktop`; the page asks with a `<scheme>://reset` or `<scheme>://quit` link, which the
window runs itself and the system never sees (`deeplink.rs`). Reset still asks in the app's own window.

## Test build

`npm run package:desktop -- --test`: "Owlbot Test" (`ai.owlbot.test`) with its own data, pairing, start-at-login entry
and ports 41790–41799, marked as a test build in its windows, tray and setup screens (`flavor.rs`).
