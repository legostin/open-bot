// HTTP client for the hub API. Every request names the interface language (x-openbot-locale) so the hub answers
// in it; non-GET requests carry the CSRF token and a JSON body ({} when empty).

import type { HubApi } from "@openbot/ui";
import { locale, t } from "../i18n";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let csrfToken = "";
let unauthorizedHandler: (() => void) | undefined;

export function setCsrf(token: string): void {
  csrfToken = token;
}

/** Called on 401 from an authenticated endpoint (session expired → back to login). */
export function onUnauthorized(cb: () => void): void {
  unauthorizedHandler = cb;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function request<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "x-openbot-locale": locale };
  const init: RequestInit = {
    method,
    headers,
    credentials: "same-origin",
    // The page is served with `Referrer-Policy: no-referrer`, which would make the browser send `Origin: null`
    // on same-origin POSTs. The hub checks Origin for state-changing requests, so opt back in per request.
    referrerPolicy: "same-origin",
  };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-csrf"] = csrfToken;
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, t("app.offline"));
  }
  const text = await res.text();
  let data: any = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) unauthorizedHandler?.();
    const msg = (data && typeof data === "object" && typeof data.error === "string" && data.error) || (typeof data === "string" && data.length < 300 ? data : "") || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api: HubApi = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  patch: (path, body) => request("PATCH", path, body),
  del: (path) => request("DELETE", path),
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
