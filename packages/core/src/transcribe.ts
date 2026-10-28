// Speech to text for voice messages: an OpenAI-compatible POST <base>/audio/transcriptions (OpenAI, Groq, or the
// user's own server, e.g. a local whisper). The hub calls it itself, so API keys never leave the core. Errors are
// English text for the model.

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

export type TranscriptionProvider = "auto" | "openai" | "groq" | "custom" | "off";

export interface TranscriptionSettings {
  provider: TranscriptionProvider;
  /** The model to ask for (default: the provider's). */
  model?: string;
  /** custom: the server's base URL, e.g. http://127.0.0.1:8000/v1. */
  baseUrl?: string;
  /** custom: a vault:// reference to its key, if it needs one. */
  keyRef?: string;
}

export const DEFAULT_TRANSCRIPTION: TranscriptionSettings = { provider: "auto" };
export const TRANSCRIPTION_PROVIDERS: readonly TranscriptionProvider[] = ["auto", "openai", "groq", "custom", "off"];

/** The hosted services and the vault ids of their keys. */
export const HOSTED = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", key: "openai_api_key" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", key: "groq_api_key" },
} as const;

/** The services' upload limit. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
/** Longer recordings are not transcribed on their own (the agent can still ask with transcribe_audio). */
export const MAX_AUTO_TRANSCRIBE_SEC = 600;
const TIMEOUT_MS = 120_000;

export interface Engine {
  label: string;
  baseUrl: string;
  model: string;
  keyRef?: string;
}

export class TranscribeError extends Error {}

/** The service that transcribes, or undefined when none is set up. `hasSecret` says whether the open vault holds an id. */
export function pickEngine(s: TranscriptionSettings, hasSecret: (id: string) => boolean): Engine | undefined {
  const hosted = (p: keyof typeof HOSTED): Engine | undefined =>
    hasSecret(HOSTED[p].key) ? { label: HOSTED[p].label, baseUrl: HOSTED[p].baseUrl, model: (s.provider === p && s.model) || HOSTED[p].model, keyRef: `vault://${HOSTED[p].key}` } : undefined;
  switch (s.provider) {
    case "off":
      return undefined;
    case "openai":
    case "groq":
      return hosted(s.provider);
    case "custom": {
      if (!s.baseUrl || !s.model) return undefined;
      let label = s.baseUrl;
      try {
        label = new URL(s.baseUrl).host;
      } catch {
        return undefined;
      }
      return { label, baseUrl: s.baseUrl, model: s.model, ...(s.keyRef ? { keyRef: s.keyRef } : {}) };
    }
    default:
      return hosted("openai") ?? hosted("groq");
  }
}

/** Checks a settings value from the user; returns the cleaned settings or an English error. */
export function cleanTranscription(v: unknown): TranscriptionSettings | string {
  if (!v || typeof v !== "object") return "transcription must be an object";
  const o = v as Record<string, unknown>;
  const provider = o.provider ?? "auto";
  if (!TRANSCRIPTION_PROVIDERS.includes(provider as TranscriptionProvider)) return `transcription.provider must be one of ${TRANSCRIPTION_PROVIDERS.join(", ")}`;
  const out: TranscriptionSettings = { provider: provider as TranscriptionProvider };
  const str = (k: string, max: number) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim().slice(0, max) : undefined);
  const model = str("model", 100);
  const baseUrl = str("baseUrl", 500);
  const keyRef = str("keyRef", 200);
  if (model) out.model = model;
  if (baseUrl) {
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) return "transcription.baseUrl must be an http(s) address";
    out.baseUrl = baseUrl;
  }
  if (keyRef) {
    if (!/^vault:\/\/[\w.-]+$/.test(keyRef)) return "transcription.keyRef must be a vault:// reference";
    out.keyRef = keyRef;
  }
  if (out.provider === "custom" && (!out.baseUrl || !out.model)) return "transcription with provider custom needs baseUrl and model";
  return out;
}

const ACCEPTED = new Set([".flac", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".wav", ".webm"]);
const BY_TYPE: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/** A file name the services accept: they go by the extension (Telegram's .oga is Ogg). */
export function uploadName(file: string, mimeType?: string): string {
  const name = basename(file);
  if (ACCEPTED.has(extname(name).toLowerCase())) return name;
  return `audio${(mimeType && BY_TYPE[mimeType.toLowerCase()]) ?? ".ogg"}`;
}

export interface TranscriberDeps {
  settings: () => TranscriptionSettings;
  hasSecret: (id: string) => boolean;
  /** The value of a vault:// reference (throws when it cannot be read). */
  secret: (ref: string) => string;
}

export class Transcriber {
  private d: TranscriberDeps;
  constructor(d: TranscriberDeps) {
    this.d = d;
  }

  engine(): Engine | undefined {
    return pickEngine(this.d.settings() ?? DEFAULT_TRANSCRIPTION, this.d.hasSecret);
  }

  /** The words of an audio file; throws TranscribeError with the reason. */
  async transcribe(file: string, mimeType?: string): Promise<string> {
    const e = this.engine();
    if (!e) throw new TranscribeError("no speech-to-text is set up");
    const st = await stat(file).catch(() => undefined);
    if (!st?.isFile()) throw new TranscribeError("the audio file is missing");
    if (st.size > MAX_TRANSCRIBE_BYTES) throw new TranscribeError("the audio is larger than 25 MB");
    let key: string | undefined;
    if (e.keyRef) {
      try {
        key = this.d.secret(e.keyRef);
      } catch (err: any) {
        throw new TranscribeError(`the ${e.label} key cannot be read (${err?.message ?? err})`);
      }
    }
    const form = new FormData();
    form.append("file", new Blob([await readFile(file)], { type: mimeType ?? "application/octet-stream" }), uploadName(file, mimeType));
    form.append("model", e.model);
    form.append("response_format", "json");
    let res: Response;
    try {
      res = await fetch(`${e.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new TranscribeError(`${e.label} is unreachable (${err?.cause?.code ?? err?.name ?? "network error"})`);
    }
    const body = (await res.json().catch(() => undefined)) as { text?: unknown; error?: { message?: unknown } | string } | undefined;
    if (!res.ok) {
      const why = typeof body?.error === "string" ? body.error : typeof body?.error?.message === "string" ? body.error.message : res.statusText;
      throw new TranscribeError(`${e.label} answered ${res.status}${why ? `: ${String(why).slice(0, 300)}` : ""}`);
    }
    if (typeof body?.text !== "string") throw new TranscribeError(`${e.label} gave no text`);
    return body.text.trim();
  }
}
