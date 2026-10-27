// Minimal Telegram Bot API client over global fetch (the hub's egress proxy applies through env).

export class TelegramError extends Error {
  code: number;
  retryAfter?: number;
  constructor(code: number, description: string, retryAfter?: number) {
    super(description);
    this.name = "TelegramError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
  /** Token revoked or wrong. */
  get unauthorized(): boolean {
    return this.code === 401 || this.code === 404;
  }
  get parseError(): boolean {
    return this.code === 400 && /can't parse entities|unsupported start tag|can't find end tag|unexpected end tag/i.test(this.message);
  }
  get notModified(): boolean {
    return this.code === 400 && /message is not modified/i.test(this.message);
  }
}

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  date: number;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number; url?: string; language?: string }>;
  reply_markup?: { inline_keyboard?: InlineButton[][] };
  [k: string]: unknown;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  [k: string]: unknown;
}

export type InlineButton = { text: string; callback_data?: string; url?: string };

/** A file uploaded with a multipart request; the params refer to it as `attach://<field>` (or pass it as the field itself). */
export interface UploadFile {
  field: string;
  data: Uint8Array;
  name: string;
  type: string;
}

export class TelegramApi {
  base: string;
  private token: string;
  constructor(baseUrl: string, token: string) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    return this.post<T>(method, { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }, opts);
  }

  /** A multipart/form-data call: files go up as parts, other params as JSON-encoded fields. */
  async upload<T = any>(method: string, params: Record<string, unknown>, files: UploadFile[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.append(k, typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
    }
    for (const f of files) form.append(f.field, new Blob([f.data as Uint8Array<ArrayBuffer>], { type: f.type }), f.name);
    return this.post<T>(method, { body: form }, { timeoutMs: 120_000, ...opts });
  }

  private async post<T>(method: string, init: { headers?: Record<string, string>; body: string | FormData }, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 30_000)];
    if (opts.signal) signals.push(opts.signal);
    let res: Response;
    try {
      res = await fetch(`${this.base}/bot${this.token}/${method}`, { method: "POST", ...init, signal: AbortSignal.any(signals) });
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      // Never include the URL (it contains the token).
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? "";
      throw new TelegramError(0, `network unreachable${cause ? ` (${cause})` : ""}`);
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null;
    if (!body?.ok) throw new TelegramError(body?.error_code ?? res.status, body?.description ?? `HTTP ${res.status}`, body?.parameters?.retry_after);
    return body.result as T;
  }

  /** A file the user sent, by its file_id: getFile, then the download (bots get files up to 20 MB). */
  async download(fileId: string, opts: { maxBytes: number; signal?: AbortSignal }): Promise<{ data: Uint8Array; path: string }> {
    const f = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }, { signal: opts.signal });
    if (!f.file_path) throw new TelegramError(400, "the file is not available for download");
    if (f.file_size && f.file_size > opts.maxBytes) throw new TelegramError(400, "file is too big");
    const signals = [AbortSignal.timeout(120_000)];
    if (opts.signal) signals.push(opts.signal);
    let res: Response;
    try {
      res = await fetch(`${this.base}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.any(signals) });
    } catch (e: any) {
      // Never include the URL (it contains the token).
      throw new TelegramError(0, `download failed${e?.cause?.code ? ` (${e.cause.code})` : ""}`);
    }
    if (!res.ok) throw new TelegramError(res.status, `download failed (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length > opts.maxBytes) throw new TelegramError(400, "file is too big");
    return { data, path: f.file_path };
  }

  /** Same as call() (upload() when there are files), but waits and retries once when Telegram asks to slow down (429). */
  async send<T = any>(method: string, params: Record<string, unknown>, files: UploadFile[] = []): Promise<T> {
    const go = () => (files.length ? this.upload<T>(method, params, files) : this.call<T>(method, params));
    try {
      return await go();
    } catch (e) {
      if (e instanceof TelegramError && e.code === 429 && e.retryAfter && e.retryAfter <= 30) {
        await new Promise((r) => setTimeout(r, e.retryAfter! * 1000));
        return go();
      }
      throw e;
    }
  }
}
