// Plugin settings (defaults applied here: the hub stores only what the user changed) and API variants.

export interface ApiSettings {
  defaultVariant: string;
  anthropicModel: string;
  openaiModel: string;
  openrouterModel: string;
  customModel: string;
  maxTokens: number;
  maxSteps: number;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  openrouterBaseUrl: string;
  customBaseUrl: string;
  customKeyRef: string;
  customVision: boolean;
  /** "" = the model's default effort. */
  anthropicEffort: string;
  anthropicRefusalFallback: boolean;
  anthropicEagerToolStreaming: boolean;
  historyTokenBudget: number;
  customHistoryTokenBudget: number;
  /** Cap for one tool result text sent to the model (characters). */
  maxToolResultChars: number;
}

export const DEFAULT_SETTINGS: ApiSettings = {
  defaultVariant: "anthropic",
  anthropicModel: "claude-opus-5-5",
  openaiModel: "gpt-5",
  openrouterModel: "openrouter/auto",
  customModel: "llama3.1",
  maxTokens: 16000,
  maxSteps: 40,
  anthropicBaseUrl: "https://api.anthropic.com",
  openaiBaseUrl: "https://api.openai.com/v1",
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  customBaseUrl: "http://127.0.0.1:11434/v1",
  customKeyRef: "",
  customVision: false,
  anthropicEffort: "",
  anthropicRefusalFallback: true,
  anthropicEagerToolStreaming: true,
  historyTokenBudget: 150_000,
  customHistoryTokenBudget: 24_000,
  maxToolResultChars: 200_000,
};

export function resolveSettings(raw: Record<string, unknown> | undefined): ApiSettings {
  const out: ApiSettings = { ...DEFAULT_SETTINGS };
  const r = raw ?? {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof ApiSettings>) {
    const v = r[key];
    const def = DEFAULT_SETTINGS[key];
    if (v === undefined || v === null) continue;
    if (typeof def === "number") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) (out as any)[key] = Math.floor(n);
    } else if (typeof def === "boolean") {
      (out as any)[key] = v === true || v === "true";
    } else if (typeof v === "string") {
      // Empty strings fall back to defaults, except where "" is meaningful.
      if (v.trim() || key === "customKeyRef" || key === "anthropicEffort") (out as any)[key] = v.trim();
    }
  }
  return out;
}

export type Protocol = "anthropic" | "openai";

export interface VariantInfo {
  id: string;
  label: string;
  protocol: Protocol;
  baseUrl: (s: ApiSettings) => string;
  defaultModel: (s: ApiSettings) => string;
  /** Vault reference of the API key; undefined = no key needed. */
  keyRef: (s: ApiSettings) => string | undefined;
  /** Whether a missing key makes the variant unusable. */
  keyRequired: boolean;
  vision: (s: ApiSettings) => boolean;
  historyBudget: (s: ApiSettings) => number;
}

export const VARIANTS: Record<string, VariantInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: (s) => s.anthropicBaseUrl,
    defaultModel: (s) => s.anthropicModel,
    keyRef: () => "anthropic_api_key",
    keyRequired: true,
    vision: () => true,
    historyBudget: (s) => s.historyTokenBudget,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: (s) => s.openaiBaseUrl,
    defaultModel: (s) => s.openaiModel,
    keyRef: () => "openai_api_key",
    keyRequired: true,
    vision: () => true,
    historyBudget: (s) => s.historyTokenBudget,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: (s) => s.openrouterBaseUrl,
    defaultModel: (s) => s.openrouterModel,
    keyRef: () => "openrouter_api_key",
    keyRequired: true,
    vision: () => true,
    historyBudget: (s) => s.historyTokenBudget,
  },
  custom: {
    id: "custom",
    label: "OpenAI-совместимый сервер",
    protocol: "openai",
    baseUrl: (s) => s.customBaseUrl,
    defaultModel: (s) => s.customModel,
    keyRef: (s) => s.customKeyRef || undefined,
    keyRequired: false,
    vision: (s) => s.customVision,
    historyBudget: (s) => s.customHistoryTokenBudget,
  },
};

export const CLAUDE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
};

export const ANTHROPIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

const looksClaude = (m: string) => m in CLAUDE_ALIASES || /^claude-/i.test(m);

/**
 * Model for a session: the agent's model when it fits the variant (Claude aliases/ids for Anthropic,
 * anything else for OpenAI-compatible variants), otherwise the variant's default from settings.
 */
export function resolveModel(variant: VariantInfo, requested: string | undefined, s: ApiSettings): string {
  const m = requested?.trim();
  if (!m) return variant.defaultModel(s);
  if (variant.protocol === "anthropic") {
    const key = m.toLowerCase();
    if (key in CLAUDE_ALIASES) return CLAUDE_ALIASES[key];
    return /^claude-/i.test(m) ? m : variant.defaultModel(s);
  }
  return looksClaude(m.toLowerCase()) ? variant.defaultModel(s) : m;
}

/** "vault://x" or "x" → "x". */
export function vaultId(ref: string): string {
  return ref.replace(/^vault:\/\//, "");
}
