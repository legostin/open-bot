// The desktop app (packages/desktop) opens its window at `/#desktop=<ticket>`, a one-time sign-in ticket (see
// packages/core/src/desktop-login.ts), and connects its computer to a hub from an `owlbot://pair` link.

/** The sign-in ticket in an address fragment, if any. */
export function desktopTicketFrom(hash: string): string | undefined {
  return /^#desktop=([\w-]{32,128})$/.exec(hash)?.[1];
}

/** The link that makes the desktop app connect its computer to this hub as a machine. */
export function pairLink(hubUrl: string, code: string): string {
  return `owlbot://pair?${new URLSearchParams({ hub: hubUrl, code })}`;
}
