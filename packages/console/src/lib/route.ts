// Hash routing: #/approvals, #/approvals/<id>, #/vault, #/rules, #/audit, #/account.
// The main app and Telegram link to `${consoleUrl}/#/approvals/<id>`.

export const PAGES = ["approvals", "vault", "rules", "audit", "account"] as const;
export type Page = (typeof PAGES)[number];

export interface Route {
  page: Page;
  /** Second path segment, e.g. the approval id. */
  id?: string;
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "").split("?")[0];
  const [first, second] = path.split("/");
  const page = (PAGES as readonly string[]).includes(first) ? (first as Page) : "approvals";
  let id: string | undefined;
  if (second && page === first) {
    try {
      id = decodeURIComponent(second);
    } catch {
      id = second;
    }
  }
  return id ? { page, id } : { page };
}

export function routeHref(page: Page, id?: string): string {
  return id ? `#/${page}/${encodeURIComponent(id)}` : `#/${page}`;
}
