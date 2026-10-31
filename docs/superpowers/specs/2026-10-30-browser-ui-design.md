# Browser UI: tabs, toolbar, search, history, phone layout

Approved by the person on 2026-10-30. The browser stays in the live view window (`plugins/browser`); the mini window
in the corner stays as it is. Everything below is about the expanded view.

## Desktop (wide view)

- **Tab strip** like Chrome's: favicon (a spinner while loading), title, × (on hover and on the active tab), middle
  click closes, "+" opens a new tab. The active tab joins the toolbar.
- **Toolbar** with icons (lucide, as in the rest of the app): back, forward (dimmed when there is nowhere to go),
  reload that turns into stop while loading, the address bar, History, a "⋯" menu (copy link, open in your own
  browser), Take / Return control.
- **Address bar**: without focus a lock and the URL with the host emphasized; with focus the full URL, selected.
  Words that are not an address open a search in the engine from the settings (`searchEngine`: DuckDuckGo by
  default, Google, Yandex, Bing). Suggestions while typing: first "Search … for «…»" or "Go to …", then open tabs
  that match ("Switch to tab"), then history. Arrows, Enter, Escape; Cmd/Ctrl+L focuses it.
- **History** in a side panel: search, pages by day with the time and who opened them (you or the agent's name),
  delete a row, "Clear history" (a second press confirms), "Show more". A click opens the page in the current tab.
- **New tab** (an about:blank tab): a search field and tiles of the most visited sites instead of a white page.

## Phone (view narrower than 640 px)

- On top a short address (the host); a tap opens the address input over the whole view with the suggestions.
- At the bottom a thumb bar: back, forward, tabs (with the count), keyboard (while in control), take/return control.
- Tabs open as a full-view list of cards with "New tab" and "History"; history opens full-view too.
- Gestures (any touch screen): pinch zooms the picture 100–400 % around the fingers; one finger pans the zoomed
  picture and, at its edge, scrolls the page (in control); a tap clicks where the finger is, through the zoom;
  double tap zooms only in view mode (clicks are not delayed); a "200 % ⟲" chip resets. A trackpad pinch
  (ctrl + wheel) zooms the same way on a computer.
- **Keyboard opens by itself** when a text field on the page gets focus and hides when focus leaves it. iOS shows a
  keyboard only inside a touch: while the finger is down the hub checks what is under it (an isolated world, no
  script in the page's own world), and if it is a text field the keyboard opens as the finger lifts. When the
  answer comes too late the keyboard button lights up (Android opens it anyway). Opening it always on iOS needs a
  change in piomio-ios (later, separately).

## Hub side

- History of every main-frame navigation (the person's and the agents'), kept 90 days, at most 10 000 visits, in
  `<dataDir>/history.json`; who opened a page: the UI's own navigations and the person in control are "user",
  otherwise the agent running a tool (or the last one who acted).
- State for the UI per tab: favicon URL (the page's `<link rel=icon>`, read from Playwright's isolated world, else
  `/favicon.ico`; shown through the hub's image proxy), loading; for the active tab can go back / forward.
- UI messages: `navigate { text }` (address or words), `stop`, `probe { x, y }` → `probe` event, `focus` event after
  the person's clicks and keys.
- Plugin HTTP: `GET /history`, `GET /suggest`, `GET /top`, `DELETE /history[?id=]`.
- Chat first: `browser_history` (read: find pages in the history) and `browser_history_clear` (external: the
  person approves it on a card).

## Not doing

Dragging tabs, bookmarks, find in page, swipe back from the edge, a mobile-sized remote window (sites and the agent
would see the window change size mid-session), Chrome's own History database (locked while Chrome runs, does not
know who opened a page).
