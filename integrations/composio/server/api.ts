// Composio's REST API v3.1, the part the integration uses: apps (toolkits), sign-ins (auth configs, connect links,
// connected accounts), tools and running them. Every request carries the key as x-api-key; failures come back as a
// ComposioError whose kind says what the person or the agent can do about it.

import type { JsonSchema } from "@owlbot/shared";

export const DEFAULT_API = "https://backend.composio.dev/api/v3.1";

/**
 * key: the key was refused (401); limit: the plan's calls are used up (402); rate: too many calls just now (429);
 * down: Composio is unreachable or failing; other: the request itself (403 is an account without access to that
 * channel or repository, not a bad key).
 */
export type ComposioErrorKind = "key" | "limit" | "rate" | "down" | "other";

export class ComposioError extends Error {
  status: number;
  kind: ComposioErrorKind;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.kind = status === 401 ? "key" : status === 402 ? "limit" : status === 429 ? "rate" : status === 0 || status >= 500 ? "down" : "other";
  }
}

/** An app of Composio's (a toolkit). `managed`: Composio signs in to it with its own OAuth app. */
export interface Toolkit {
  slug: string;
  name: string;
  description: string;
  managed: boolean;
}

export interface ComposioTool {
  /** "SLACK_SEND_MESSAGE". */
  slug: string;
  /** "Send message". */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  tags: string[];
  version?: string;
  toolkit: string;
}

/** A connected account: ACTIVE works; INITIATED / INITIALIZING wait for the sign-in; anything else stopped working. */
export interface Account {
  id: string;
  status: string;
  toolkit: string;
  reason?: string;
}

export interface Link {
  url: string;
  accountId: string;
  expiresAt?: string;
}

export interface ComposioApi {
  toolkits(search: string, limit?: number): Promise<Toolkit[]>;
  toolkit(slug: string): Promise<Toolkit>;
  createAuthConfig(slug: string): Promise<string>;
  link(authConfigId: string, userId: string): Promise<Link>;
  account(id: string): Promise<Account>;
  deleteAccount(id: string): Promise<void>;
  tools(slug: string, opts: { important?: boolean; query?: string; limit: number }): Promise<ComposioTool[]>;
  execute(tool: string, opts: { userId: string; accountId: string; args: Record<string, unknown>; version?: string }): Promise<{ ok: boolean; data: unknown; error?: string }>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toolkitOf(t: any): Toolkit {
  return {
    slug: str(t?.slug).toLowerCase(),
    name: str(t?.name) || str(t?.slug),
    description: str(t?.meta?.description),
    managed: Array.isArray(t?.composio_managed_auth_schemes) && t.composio_managed_auth_schemes.length > 0,
  };
}

function toolOf(t: any): ComposioTool {
  const schema = t?.input_parameters && typeof t.input_parameters === "object" ? t.input_parameters : { type: "object", properties: {} };
  return {
    slug: str(t?.slug),
    name: str(t?.name) || str(t?.slug),
    description: str(t?.description) || str(t?.human_description),
    inputSchema: { type: "object", ...schema },
    tags: Array.isArray(t?.tags) ? t.tags.filter((x: unknown) => typeof x === "string") : [],
    ...(str(t?.version) ? { version: str(t.version) } : {}),
    toolkit: str(t?.toolkit?.slug).toLowerCase(),
  };
}

function accountOf(a: any): Account {
  return { id: str(a?.id), status: str(a?.status).toUpperCase(), toolkit: str(a?.toolkit?.slug).toLowerCase(), ...(str(a?.status_reason) ? { reason: str(a.status_reason) } : {}) };
}

/** The API at `base` with the key `key()` gives (read from the vault on every request, so a new key works at once). */
export function composioApi(base: string, key: () => Promise<string>): ComposioApi {
  const root = base.replace(/\/+$/, "");
  async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method,
        headers: { "x-api-key": await key(), accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      throw new ComposioError(0, e?.cause?.message ?? e?.message ?? String(e));
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!res.ok) throw new ComposioError(res.status, str(json?.error?.message) || str(json?.message) || str(json?.error) || `HTTP ${res.status}`);
    return json as T;
  }
  const q = (params: Record<string, string | number | boolean | undefined>) =>
    new URLSearchParams(Object.entries(params).flatMap(([k, v]): Array<[string, string]> => (v === undefined || v === "" ? [] : [[k, String(v)]]))).toString();

  return {
    async toolkits(search, limit = 10) {
      const r = await req("GET", `/toolkits?${q({ search, limit })}`);
      return (Array.isArray(r?.items) ? r.items : []).map(toolkitOf).filter((t: Toolkit) => t.slug);
    },
    async toolkit(slug) {
      return toolkitOf(await req("GET", `/toolkits/${encodeURIComponent(slug)}`));
    },
    async createAuthConfig(slug) {
      const r = await req("POST", "/auth_configs", { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } });
      const id = str(r?.auth_config?.id) || str(r?.id);
      if (!id) throw new ComposioError(500, "Composio created no auth config");
      return id;
    },
    async link(authConfigId, userId) {
      const r = await req("POST", "/connected_accounts/link", { auth_config_id: authConfigId, user_id: userId });
      const url = str(r?.redirect_url);
      const accountId = str(r?.connected_account_id);
      if (!url || !accountId) throw new ComposioError(500, "Composio gave no sign-in link");
      return { url, accountId, ...(str(r?.expires_at) ? { expiresAt: str(r.expires_at) } : {}) };
    },
    async account(id) {
      return accountOf(await req("GET", `/connected_accounts/${encodeURIComponent(id)}`));
    },
    async deleteAccount(id) {
      try {
        await req("DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!(e instanceof ComposioError && e.status === 404)) throw e;
      }
    },
    async tools(slug, opts) {
      const r = await req("GET", `/tools?${q({ toolkit_slug: slug, important: opts.important ? "true" : undefined, query: opts.query, limit: opts.limit })}`);
      return (Array.isArray(r?.items) ? r.items : []).map(toolOf).filter((t: ComposioTool) => t.slug);
    },
    async execute(tool, opts) {
      const r = await req("POST", `/tools/execute/${encodeURIComponent(tool)}`, {
        connected_account_id: opts.accountId,
        user_id: opts.userId,
        arguments: opts.args,
        ...(opts.version ? { version: opts.version } : {}),
      });
      return { ok: r?.successful !== false && !r?.error, data: r?.data ?? null, ...(r?.error ? { error: typeof r.error === "string" ? r.error : JSON.stringify(r.error) } : {}) };
    },
  };
}
