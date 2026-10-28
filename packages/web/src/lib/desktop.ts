// The desktop app (packages/desktop) opens its window at `/#desktop=<ticket>`, a one-time sign-in ticket (see
// packages/core/src/desktop-login.ts), and connects its computer to a hub from an `owlbot://pair` link. Its hub window
// announces itself as `window.owlbotDesktop` and runs links of its scheme itself: `<scheme>://reset`, `<scheme>://quit`.

export interface DesktopApp {
  /** "owlbot", or "owlbot-test" in the test build. */
  scheme: string;
  test: boolean;
}

/** The desktop app whose window shows this page, if any. */
export function desktopApp(w: unknown = globalThis): DesktopApp | undefined {
  const d = (w as { owlbotDesktop?: Partial<DesktopApp> }).owlbotDesktop;
  return d && typeof d.scheme === "string" && /^owlbot(-test)?$/.test(d.scheme) ? { scheme: d.scheme, test: d.test === true } : undefined;
}

/** The sign-in ticket in an address fragment, if any. */
export function desktopTicketFrom(hash: string): string | undefined {
  return /^#desktop=([\w-]{32,128})$/.exec(hash)?.[1];
}

/** The link that makes the desktop app connect its computer to this hub as a machine. */
export function pairLink(hubUrl: string, code: string, scheme = desktopApp()?.scheme ?? "owlbot"): string {
  return `${scheme}://pair?${new URLSearchParams({ hub: hubUrl, code })}`;
}

/** Asks the desktop app around this page to quit, or to reset (it confirms that in its own window first). */
export function desktopAction(app: DesktopApp, what: "reset" | "quit"): void {
  location.href = `${app.scheme}://${what}`;
}
