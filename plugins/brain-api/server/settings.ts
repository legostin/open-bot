// Plugin settings (defaults applied here: the hub stores only what the user changed) and API variants.

import type { ProbeResult } from "@piomio/shared";

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
  /** More models to offer, beyond each provider's list: lines of "provider: model, model". */
  extraModels: string;
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
  extraModels: "",
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
      if (v.trim() || key === "customKeyRef" || key === "anthropicEffort" || key === "extraModels") (out as any)[key] = v.trim();
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
  /** Reasoning efforts the provider takes, least first (none: it takes no effort). */
  efforts: string[];
  /** What the presets mean here: a model (unset: the variant's default) and an effort. */
  presets: (s: ApiSettings) => NonNullable<ProbeResult["presets"]>;
  /** The models it offers, for the hub to choose from per request (the default model and extraModels join them). */
  models: string[];
  /**
   * OpenAI's own Responses API (POST /responses) instead of Chat Completions: the newest OpenAI models take function
   * tools together with a reasoning effort only there.
   */
  responses?: boolean;
}

const OPENAI_EFFORTS = ["low", "medium", "high"];
const OPENAI_PRESETS = { fast: { effort: "low" }, balanced: { effort: "medium" }, deep: { effort: "high" } };

/**
 * OpenAI-compatible providers, one line each: a new one is a new line here (and its key and host in plugin.json).
 * Models are the provider's main ones as of late 2026, cheapest first; the hub picks among them per request by what
 * they are like (shared/models.ts), and `extraModels` adds newer ones without a release.
 */
export const PROVIDERS: ReadonlyArray<{ id: string; label: string; baseUrl: string; key: string; models: string[]; vision?: boolean }> = [
  { id: "moonshot", label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.ai/v1", key: "moonshot_api_key", models: ["kimi-k2-turbo-preview", "kimi-k2-0905-preview", "kimi-k2-thinking"] },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", key: "deepseek_api_key", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "zhipu", label: "GLM (Z.ai)", baseUrl: "https://api.z.ai/api/paas/v4", key: "zhipu_api_key", models: ["glm-4.5-flash", "glm-4.5-air", "glm-4.6"] },
  { id: "qwen", label: "Qwen (Alibaba)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", key: "qwen_api_key", models: ["qwen-flash", "qwen-plus", "qwen3-coder-plus", "qwen3-max"] },
  { id: "gemini", label: "Gemini (Google)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: "gemini_api_key", models: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"], vision: true },
  { id: "xai", label: "Grok (xAI)", baseUrl: "https://api.x.ai/v1", key: "xai_api_key", models: ["grok-code-fast-1", "grok-4-fast-reasoning", "grok-4"], vision: true },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", key: "mistral_api_key", models: ["mistral-small-latest", "codestral-latest", "mistral-medium-latest", "mistral-large-latest"] },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", key: "groq_api_key", models: ["openai/gpt-oss-20b", "llama-3.3-70b-versatile", "openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct-0905"] },
];

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
    efforts: ["low", "medium", "high", "xhigh", "max"],
    // Fast: Sonnet with little thinking; balanced: the default model at medium effort; deep: Opus at extra-high effort.
    presets: (s) => ({ fast: { model: "claude-sonnet-5-5", effort: "low" }, balanced: { model: s.anthropicModel, effort: "medium" }, deep: { model: "claude-opus-5-5", effort: "xhigh" } }),
    models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"],
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
    efforts: OPENAI_EFFORTS,
    presets: () => OPENAI_PRESETS,
    models: ["gpt-5-nano", "gpt-5-mini", "gpt-5"],
    responses: true,
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
    efforts: OPENAI_EFFORTS,
    presets: () => OPENAI_PRESETS,
    // One key for every provider: the main models of each, so the hub can choose across them.
    models: ["openrouter/auto", "deepseek/deepseek-chat", "moonshotai/kimi-k2-0905", "z-ai/glm-4.6", "qwen/qwen3-max", "google/gemini-2.5-flash", "x-ai/grok-4-fast", "openai/gpt-5-mini"],
  },
  custom: {
    id: "custom",
    label: "OpenAI-compatible server",
    protocol: "openai",
    baseUrl: (s) => s.customBaseUrl,
    defaultModel: (s) => s.customModel,
    keyRef: (s) => s.customKeyRef || undefined,
    keyRequired: false,
    vision: (s) => s.customVision,
    historyBudget: (s) => s.customHistoryTokenBudget,
    efforts: [],
    presets: () => ({}),
    models: [],
  },
  ...Object.fromEntries(
    PROVIDERS.map((p): [string, VariantInfo] => [
      p.id,
      {
        id: p.id,
        label: p.label,
        protocol: "openai",
        baseUrl: () => p.baseUrl,
        defaultModel: () => p.models[Math.min(1, p.models.length - 1)],
        keyRef: () => p.key,
        keyRequired: true,
        vision: () => !!p.vision,
        historyBudget: (s) => s.historyTokenBudget,
        // Their reasoning parameters differ from OpenAI's: here depth is the choice of model.
        efforts: [],
        presets: () => ({ fast: { model: p.models[0] }, balanced: { model: p.models[Math.min(1, p.models.length - 1)] }, deep: { model: p.models[p.models.length - 1] } }),
        models: p.models,
      },
    ]),
  ),
};

/** `extraModels` for one provider: "deepseek: deepseek-v4, deepseek-v4-reasoner" lines. */
export function extraModelsFor(variant: string, s: ApiSettings): string[] {
  const out: string[] = [];
  for (const line of s.extraModels.split(/\n|;/)) {
    // Only the first ":" splits: model ids may have their own ("llama3.1:8b").
    const at = line.indexOf(":");
    if (at < 0 || line.slice(0, at).trim().toLowerCase() !== variant) continue;
    for (const m of line.slice(at + 1).split(",")) if (m.trim()) out.push(m.trim());
  }
  return out;
}

export const CLAUDE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
};

export const ANTHROPIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
export const ANTHROPIC_MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-fable-5-1": "Fable 5.1",
};

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
