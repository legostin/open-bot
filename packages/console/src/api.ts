// Console API client. Same origin only; every authenticated call carries the x-csrf header.
// Non-GET calls always send a JSON body (the server rejects anything else).

import type {
  ApprovalView,
  AuditEntry,
  AuditVerify,
  AuthState,
  Passkey,
  PluginInfo,
  Rule,
  RuleCondition,
  RuleDraft,
  ToolInfo,
  VaultItem,
  VaultItemMeta,
  VaultScope,
  VaultState,
  VaultUpsert,
  VaultView,
} from "./types.ts";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The console session is gone (idle timeout, logout elsewhere, password change). */
export class SessionLostError extends ApiError {
  constructor() {
    super(401, "Сессия пульта завершена — войдите снова");
  }
}

let csrf: string | undefined;
let sessionLost: (() => void) | undefined;

export function setCsrf(token: string | undefined): void {
  csrf = token;
}

export function onSessionLost(fn: () => void): void {
  sessionLost = fn;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  /** Auth endpoints: a 401 there means "wrong credentials", not "session expired". */
  public?: boolean;
  retried?: boolean;
}

async function send(method: Method, path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (csrf) headers["x-csrf"] = csrf;
  let payload: string | undefined;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body ?? {});
  }
  try {
    return await fetch(path, { method, headers, body: payload, credentials: "same-origin", cache: "no-store", redirect: "error" });
  } catch {
    throw new ApiError(0, "Нет связи с хабом. Проверьте, что он запущен, и повторите.");
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = "";
  let code: string | undefined;
  try {
    const j = (await res.json()) as { error?: string; message?: string; code?: string };
    message = j.error ?? j.message ?? "";
    code = typeof j.code === "string" ? j.code : undefined;
  } catch {
    /* not JSON */
  }
  if (!message) message = res.status === 429 ? "Слишком много попыток. Подождите и попробуйте снова." : `Ошибка ${res.status}`;
  return new ApiError(res.status, message, code);
}

export async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, body);
  if (res.ok) {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const err = await errorFrom(res);
  if (!opts.public && (res.status === 401 || (res.status === 403 && /csrf/i.test(err.message)))) {
    // A 401 can also be a credential error (e.g. wrong current password): ask whether the session is still alive.
    let state: AuthState | undefined;
    try {
      state = await authState();
    } catch {
      state = undefined;
    }
    if (!state?.authenticated) {
      csrf = undefined;
      sessionLost?.();
      throw new SessionLostError();
    }
    csrf = state.csrf;
    if (res.status === 403 && !opts.retried) return request<T>(method, path, body, { ...opts, retried: true });
  }
  throw err;
}

const enc = encodeURIComponent;

export function authState(): Promise<AuthState> {
  return request<AuthState>("GET", "/console-api/auth/state", undefined, { public: true });
}

export const api = {
  // ---------- auth ----------
  state: authState,
  login: (password: string) => request<{ ok: true; csrf: string }>("POST", "/console-api/auth/login", { password }, { public: true }),
  passkeyLoginOptions: () => request<any>("POST", "/console-api/auth/passkey/options", {}, { public: true }),
  passkeyLoginVerify: (response: unknown) => request<{ ok: true; csrf: string }>("POST", "/console-api/auth/passkey/verify", { response }, { public: true }),
  logout: () => request<{ ok: true }>("POST", "/console-api/auth/logout", {}, { public: true }),

  // ---------- vault ----------
  vault: () => request<VaultView>("GET", "/console-api/vault"),
  vaultInit: (passphrase: string) => request<{ state: VaultState }>("POST", "/console-api/vault/init", { passphrase }),
  vaultUnlock: (passphrase: string) => request<{ state: VaultState }>("POST", "/console-api/vault/unlock", { passphrase }),
  vaultSeal: () => request<{ state: VaultState }>("POST", "/console-api/vault/seal", {}),
  vaultPassphrase: (oldPassphrase: string, newPassphrase: string) => request<{ ok: true }>("POST", "/console-api/vault/passphrase", { oldPassphrase, newPassphrase }),
  vaultItem: (id: string) => request<VaultItem>("GET", `/console-api/vault/items/${enc(id)}`),
  vaultUpsert: (item: VaultUpsert) => request<VaultItemMeta>("PUT", "/console-api/vault/items", item),
  vaultScope: (id: string, scope: Partial<VaultScope>) => request<VaultItemMeta>("PATCH", `/console-api/vault/items/${enc(id)}/scope`, scope),
  vaultRemove: (id: string) => request<{ ok: true }>("DELETE", `/console-api/vault/items/${enc(id)}`, {}),

  // ---------- approvals ----------
  approvals: (status: string = "pending") => request<ApprovalView[]>("GET", `/console-api/approvals?status=${enc(status)}`),
  resolveApproval: (id: string, body: { decision: "approve" | "deny"; remember?: boolean; rule?: RuleDraft }) =>
    request<ApprovalView>("POST", `/console-api/approvals/${enc(id)}`, body),

  // ---------- rules ----------
  rules: () => request<Rule[]>("GET", "/console-api/rules"),
  createRule: (r: RuleDraft) => request<Rule>("POST", "/console-api/rules", r),
  /** `null` clears agentId / note (the server merges the patch over the stored rule). */
  updateRule: (id: string, r: { tool: string; agentId: string | null; conditions: RuleCondition[]; decision: "allow" | "deny"; note: string | null }) =>
    request<Rule>("PATCH", `/console-api/rules/${enc(id)}`, r),
  removeRule: (id: string) => request<{ ok: true }>("DELETE", `/console-api/rules/${enc(id)}`, {}),
  tools: () => request<ToolInfo[]>("GET", "/console-api/tools"),

  // ---------- audit ----------
  audit: (q: { limit: number; before?: number; action?: string }) => {
    const p = new URLSearchParams({ limit: String(q.limit) });
    if (q.before) p.set("before", String(q.before));
    if (q.action) p.set("action", q.action);
    return request<AuditEntry[]>("GET", `/console-api/audit?${p}`);
  },
  auditVerify: () => request<AuditVerify>("GET", "/console-api/audit/verify"),

  // ---------- account ----------
  passkeys: () => request<Passkey[]>("GET", "/console-api/passkeys"),
  passkeyRegisterOptions: () => request<any>("POST", "/console-api/passkeys/options", {}),
  passkeyRegister: (response: unknown, name: string) => request<Passkey[]>("POST", "/console-api/passkeys/register", { response, name }),
  passkeyRemove: (id: string) => request<Passkey[]>("DELETE", `/console-api/passkeys/${enc(id)}`, {}),
  changePassword: (oldPassword: string, newPassword: string) => request<{ ok: true }>("POST", "/console-api/password", { oldPassword, newPassword }),
  plugins: () => request<PluginInfo[]>("GET", "/console-api/plugins"),
  /** Vault items granted to a plugin beyond its manifest (ids; a vault:// prefix is accepted). */
  pluginVault: (id: string, items: string[]) => request<{ ok: true; extraVault: string[] }>("PUT", `/console-api/plugins/${enc(id)}/vault`, { items }),
};

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
