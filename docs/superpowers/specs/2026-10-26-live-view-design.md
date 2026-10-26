# Live view: a floating window onto an agent's screen

Approved design (2026-10-26). Replaces the browser plugin's tab in the right side pane.

## Goal

When an agent works in a browser (later: a desktop app, another machine's screen), the user sees it in a compact
picture-in-picture window without looking for it, can expand it and take over, and is not bothered when nothing
happens. The window belongs to the core; plugins contribute content and activity through a typed contract.

## Behaviour

- **Compact window** (≈320 px wide on desktop, ≈half the width on phones), bottom-right by default. Title bar: the
  contributor's icon, the working agent's avatar and name, a one-line status, buttons Expand / Minimize / Close.
  Clicking the picture expands. Dragging the title bar snaps it to the nearest corner (remembered per browser).
  Bottom corners stay above the chat composer (measured), so the send button is never covered, phones included.
- **Opens on its own** when a contributor reports `active` (or `attention`, or `userControl`).
- **Grace**: 20 s after activity stops the window turns into a pill; the pill disappears 60 s later. Short gaps
  between tool calls therefore do not flicker. While the user is in control the view stays live.
- **Minimize** turns it into a pill with a live dot; clicking the pill brings it back. **Close** hides it until the
  next stretch of work. Both are remembered per "burst" (a burst starts when an idle view becomes busy, or when it
  starts asking for the user), so a new burst shows the window again.
- **Attention** (captcha, sign-in): the window reopens even if minimized or closed, highlighted ("Needs you").
- **Expanded**: an overlay over the app (full screen on phones) with the plugin's full controls. Esc or the
  collapse button returns to the corner; it never closes by itself. The plugin content stays mounted across
  compact ↔ expanded (same React position), so a stream does not restart.
- Several live views at once: a switcher in the title bar; pills for each.
- Command palette: "Show live view: <title>" opens the expanded view even with no activity (e.g. to sign in to a site
  in the agent's browser ahead of time).

## Contract (`@openbot/ui`)

```ts
ui.liveView.register({ id, title, icon?, component }): LiveViewHandle
interface LiveViewHandle { update(a: Partial<LiveViewActivity>): void; dispose(): void }
interface LiveViewActivity { active: boolean; attention?: boolean; userControl?: boolean; agentId?: string; status?: string }
interface LiveViewProps extends SlotProps { mode: "mini" | "expanded"; expand(): void; collapse(): void }
```

The plugin reports the truth (busy or not); the core owns timing (grace, pill), position, the frame and the overlay.
The component is mounted only while the compact window or the overlay is visible: a plugin starts streaming on mount
and stops on unmount. `slots.register("live.view", …)` registers a view without an activity handle.

## Browser plugin

- Server: an `activity` event `{ running, busy, agentId, url, control, attention }` on every change, whether or not
  anyone watches (the `state` event stays viewer-only). The calling agent comes from the tool call context.
  `attention` is set when `open`/`snapshot` find a captcha and cleared when the user takes control, a later check
  finds none, or the browser closes. A `{ type: "activity" }` UI message asks for the current value.
- UI: one component; compact mode shows only the picture, expanded mode adds the address bar, tabs and
  take/return control. Leaving the expanded view while in control hands control back to the agent.
- The `pane.right` contribution is removed (the slot stays for other plugins). Model-facing hints say "live view".

## Testing

Pure logic (phases, bursts, which view and mode to show) is unit-tested; the browser plugin test checks `activity`
events (agent id, busy, attention on a captcha page). Manual check against a test hub on spare ports.
