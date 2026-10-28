# Agents that know themselves, the team, the time and the place

Date: 2026-10-29. Status: built (hub main ea178af, owlbot-ios main 5a56a96).

## Why

A photo critic agent was editing a shot in a task. The assistant asked it in a thread what it was doing, and it answered "nothing". Each brain session only knew itself. Owlbot's agents are meant to be a team of personalities: each one knows where it runs and what it is doing in all its sessions. It knows its teammates and what they are busy with, the time, and where the user is when the phone shares it. Talking to them should feel like talking to a person, and the interface stays minimal.

## What agents get

**`[You now]` block** (`packages/core/src/situation.ts`). It comes before a turn's input, after the `[Now: …]` line. Every session gets it whenever it changed since that session last saw it, and the first turn always gets it. It holds:
- this session: dialog, group, task or thread, and the computer it runs on;
- the agent's other work: open tasks and threads (who started each, where, since when, state) and its dialog or groups mid-turn;
- each teammate: free, or what it is busy with;
- the computers, when there is more than one;
- where the user is, when the phone shares it.

The system prompt says all sessions are one person and the block is current. `task_agents` adds a "Busy now" list.

**The queue.**
- A task's or thread's turn that finds its brains at `brainConcurrency` waits for one to finish instead of failing.
- After about 3 s, whoever started it gets a note: "X is busy (working on “…”), your message waits in line".
- The user's own conversations (dialogs, groups) never wait for tasks.

**Messages in a row.**
- What the user writes while a turn runs, when the brain cannot take it mid-turn, waits for the next turn.
- Everything written before that turn starts reaches the agent together, as one turn.

**Reports reply to the request.** A task's or thread's result comes back to the dialog. If the user wrote more since the request, the agent's reply carries a `reply_to` part. The chat shows the request's words above the reply, and a click scrolls to it.

## Maps

`show_map` takes a symbol (`MapIcon`) and a note per place, and a `route`:
- mode `walk`, `drive`, `bike` or `transit`;
- the stops as marker indexes, all markers in order by default.

The hub asks OSRM for walking, driving and cycling lines (OpenStreetMap Germany's servers, `OWLBOT_ROUTER_URL`). It simplifies the line to at most 400 points and stores length and time. Transit, and any route the router could not find, is drawn straight between the stops, and the tool result says so.

The card is minimal:
- the map and one caption line: title, then length and time or the way of travel;
- a full-screen button;
- zoom and "show everything" buttons only once the map is in use;
- the list of places only full screen.

"Open in…" builds links for the chosen place, else the route, else the place:
- built in: Apple Maps, Google Maps (with the stops between) and OpenStreetMap;
- plugins add apps through `ui.maps.addApp({ id, title, place, route? })`;
- an app without route links opens the route's destination;
- the builtin UI-only plugin `yandex-2gis` adds Yandex Maps and 2GIS.

## Where the user is

The iOS app's Hub tab has the switch "Share my location with agents", off by default. It works like this:
1. iOS's significant-change service wakes the app when the phone moves (no GPS stream). The app also asks for a fresh fix when it comes to the foreground.
2. The app reports at most every 150 m or 15 minutes.
3. MapKit names the place on the phone (`MKReverseGeocodingRequest`).
4. The app sends `POST /api/devices/location` with `{lat, lon, accuracy, at, place}`.
5. The hub keeps only the last place (`user-location.ts`, settings key `userLocation`).

Turning the switch off sends `DELETE` and the hub forgets the place. A place from a phone that was unpaired is dropped. Agents see the place in `[You now]`, marked "last known… may be out of date" after six hours. They get the exact point from the `user_location` tool, for routes from where the user is.

## Language

The Russian UI calls a brain «интеллект» (not «мозг»), everywhere: catalogs, plugins, CLI, the iOS app and the Russian docs. Code and English text keep "brain".
