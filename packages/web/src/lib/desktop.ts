// The desktop app (packages/desktop) opens its window at `/#desktop=<ticket>`, a one-time sign-in ticket (see
// packages/core/src/desktop-login.ts), and connects its computer to a hub from an `owlbot://pair` link. Its hub window
// announces itself as `window.owlbotDesktop` and runs links of its scheme itself: `<scheme>://reset`, `<scheme>://quit`,
// and `<scheme>://approval?id=…&decision=…`: the app answers an approval card itself, after Touch ID, and tells the
// page how it went with an `owlbot-desktop` event ({type: "approval", id, outcome}).

export interface DesktopApp {
  /** "owlbot", or "owlbot-test" in the test build. */
  scheme: string;
  test: boolean;
  /** The app answers approval cards with Touch ID (newer apps on macOS). */
  approvals: boolean;
}

/** The desktop app whose window shows this page, if any. */
export function desktopApp(w: unknown = globalThis): DesktopApp | undefined {
  const d = (w as { owlbotDesktop?: Partial<DesktopApp> }).owlbotDesktop;
  return d && typeof d.scheme === "string" && /^owlbot(-test)?$/.test(d.scheme) ? { scheme: d.scheme, test: d.test === true, approvals: d.approvals === true } : undefined;
}

export const DESKTOP_EVENT = "owlbot-desktop";

/** How the app's answer to an approval card went: done, the person backed out of Touch ID, or it failed. */
export interface DesktopApprovalEvent {
  type: "approval";
  id: string;
  outcome: "done" | "cancelled" | "failed";
  error?: string;
}

/** The link that makes the app answer an approval card (Touch ID first for a yes). */
export function approvalLink(app: DesktopApp, id: string, decision: "approve" | "deny", remember = false): string {
  return `${app.scheme}://approval?${new URLSearchParams({ id, decision, ...(remember ? { remember: "1" } : {}) })}`;
}

/** The sign-in ticket in an address fragment, if any. */
export function desktopTicketFrom(hash: string): string | undefined {
  return /^#desktop=([\w-]{32,128})$/.exec(hash)?.[1];
}

/** The link that makes the desktop app connect its computer to this hub as a machine. */
export function pairLink(hubUrl: string, code: string, scheme = desktopApp()?.scheme ?? "owlbot"): string {
  return `${scheme}://pair?${new URLSearchParams({ hub: hubUrl, code })}`;
}

/** The web UI is open on a computer other than the hub's (not its own window, not a phone): that computer's desktop
 * app can be connected right here. */
export function onAnotherComputer(hostname: string, userAgent: string, w: unknown = globalThis): boolean {
  if (desktopApp(w)) return false;
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return false;
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname);
}

/** Asks the desktop app around this page to quit, or to reset (it confirms that in its own window first). */
export function desktopAction(app: DesktopApp, what: "reset" | "quit"): void {
  location.href = `${app.scheme}://${what}`;
}
