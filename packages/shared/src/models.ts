// What a model is like, for choosing one per request (core/src/model-router.ts): how capable, how quick, how costly
// and what it is good at. A brain publishes the profiles of the models it offers (ProbeResult.catalog); for model
// families it does not describe, the table below fills in. A new provider plugs in by publishing its catalog: the
// router reads profiles, never provider names.

/** What a model is especially good at (ModelProfile.good lists them strongest first). */
export type ModelSkill = "code" | "reasoning" | "writing" | "vision";
export const MODEL_SKILLS: readonly ModelSkill[] = ["code", "reasoning", "writing", "vision"];

export interface ModelProfile {
  /** The id the brain takes (an alias such as "sonnet" for Claude Code). */
  id: string;
  /** For people. */
  name?: string;
  /** How capable: 1 (a small local model) … 5 (the best there is). */
  tier: number;
  /** How quick to answer: 1 (slow, thinks long) … 3 (fast). */
  speed: number;
  /** How costly: 1 (cheap or free) … 3 (expensive). */
  cost: number;
  /** Strongest first. */
  good?: ModelSkill[];
}

type Traits = Omit<ModelProfile, "id" | "name">;

/**
 * Known model families by id, first match wins (more specific patterns first). Reasonable as of late 2026; a brain's
 * own catalog and the plugin's settings come before it.
 */
export const KNOWN_MODELS: ReadonlyArray<readonly [RegExp, Traits]> = [
  // Anthropic
  [/fable/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "writing", "code", "vision"] }],
  [/opus/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "writing", "code", "vision"] }],
  [/sonnet/i, { tier: 4, speed: 2, cost: 2, good: ["writing", "code", "vision"] }],
  [/haiku/i, { tier: 2, speed: 3, cost: 1, good: ["vision"] }],
  // OpenAI. GPT-6 Astra is the flagship; the GPT-5.6 line goes by size: Sol, Terra, then Luna, the small quick one.
  [/gpt-?6[\w.]*-?(mini|nano|luna)/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/gpt-?6/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "code", "writing", "vision"] }],
  [/gpt-?[\d.]*-?luna/i, { tier: 2, speed: 3, cost: 1 }],
  [/gpt-?[\d.]*-?terra/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/gpt-?[\d.]*-?sol\b/i, { tier: 4, speed: 2, cost: 2, good: ["code", "reasoning", "writing"] }],
  [/codex[-_.]?(mini|spark)/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/codex/i, { tier: 4, speed: 2, cost: 2, good: ["code", "reasoning"] }],
  [/gpt-?5[\w.]*-?nano/i, { tier: 2, speed: 3, cost: 1 }],
  [/gpt-?5[\w.]*-?mini/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/gpt-?5[\w.]*-?pro/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "code", "writing"] }],
  [/gpt-?5/i, { tier: 5, speed: 2, cost: 2, good: ["reasoning", "code", "writing", "vision"] }],
  [/gpt-?4\.1-?(mini|nano)|gpt-?4o-?mini/i, { tier: 2, speed: 3, cost: 1, good: ["vision"] }],
  [/gpt-?4/i, { tier: 3, speed: 2, cost: 2, good: ["writing", "vision"] }],
  [/^o\d(-mini)?/i, { tier: 4, speed: 1, cost: 2, good: ["reasoning", "code"] }],
  [/gpt-?oss-?20b/i, { tier: 2, speed: 3, cost: 1 }],
  [/gpt-?oss/i, { tier: 3, speed: 3, cost: 1, good: ["reasoning"] }],
  // Google
  [/gemini[\w.-]*flash[-_]?lite/i, { tier: 2, speed: 3, cost: 1, good: ["vision"] }],
  [/gemini[\w.-]*flash/i, { tier: 3, speed: 3, cost: 1, good: ["vision", "code"] }],
  [/gemini[\w.-]*pro/i, { tier: 5, speed: 2, cost: 2, good: ["reasoning", "code", "vision", "writing"] }],
  [/gemma/i, { tier: 2, speed: 3, cost: 1 }],
  // Moonshot (Kimi)
  [/kimi[\w.-]*(thinking|k2\.5|k3)/i, { tier: 4, speed: 1, cost: 1, good: ["reasoning", "code"] }],
  [/kimi|moonshot/i, { tier: 4, speed: 2, cost: 1, good: ["code", "writing"] }],
  // DeepSeek
  [/deepseek[\w.-]*(reasoner|r1|r2)/i, { tier: 4, speed: 1, cost: 1, good: ["reasoning", "code"] }],
  [/deepseek[\w.-]*coder/i, { tier: 3, speed: 2, cost: 1, good: ["code"] }],
  [/deepseek/i, { tier: 4, speed: 2, cost: 1, good: ["code", "writing"] }],
  // Zhipu (GLM)
  [/glm[\w.-]*(flash|air)/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/glm/i, { tier: 4, speed: 2, cost: 1, good: ["code", "reasoning"] }],
  // Alibaba (Qwen)
  [/qwen[\w.-]*coder/i, { tier: 4, speed: 2, cost: 1, good: ["code"] }],
  [/qwen[\w.-]*(max|235b|480b)/i, { tier: 4, speed: 2, cost: 2, good: ["reasoning", "writing"] }],
  [/qwen[\w.-]*(turbo|flash|[0-9]b\b|1[0-4]b\b)/i, { tier: 2, speed: 3, cost: 1 }],
  [/qwen/i, { tier: 3, speed: 2, cost: 1, good: ["writing"] }],
  // xAI (Grok)
  [/grok[\w.-]*code/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/grok[\w.-]*(fast|mini)/i, { tier: 3, speed: 3, cost: 1, good: ["reasoning"] }],
  [/grok/i, { tier: 5, speed: 1, cost: 3, good: ["reasoning", "writing"] }],
  // Mistral
  [/codestral|devstral/i, { tier: 3, speed: 3, cost: 1, good: ["code"] }],
  [/mistral[\w.-]*(large|medium)|magistral/i, { tier: 4, speed: 2, cost: 2, good: ["writing", "reasoning"] }],
  [/mistral|ministral|mixtral/i, { tier: 2, speed: 3, cost: 1 }],
  // Meta and other open models (often local)
  [/llama[\w.-]*(405b|maverick)/i, { tier: 3, speed: 2, cost: 1 }],
  [/llama/i, { tier: 2, speed: 3, cost: 1 }],
  [/phi|smollm|tinyllama/i, { tier: 1, speed: 3, cost: 1 }],
  // Aggregators choosing for themselves
  [/openrouter\/auto/i, { tier: 4, speed: 2, cost: 2 }],
];

const UNKNOWN: Traits = { tier: 3, speed: 2, cost: 2 };

/** Whether the table knows the model's family. */
export function isKnownModel(id: string, name?: string): boolean {
  return KNOWN_MODELS.some(([re]) => re.test(id) || (!!name && re.test(name)));
}

/** A model's profile by its id (and name): from the table, or a middling one for a model nobody describes. */
export function profileOf(id: string, name?: string): ModelProfile {
  const hit = KNOWN_MODELS.find(([re]) => re.test(id) || (!!name && re.test(name)));
  const traits = hit ? hit[1] : UNKNOWN;
  return { id, ...(name ? { name } : {}), tier: traits.tier, speed: traits.speed, cost: traits.cost, ...(traits.good ? { good: [...traits.good] } : {}) };
}

/** A brain's catalog: its own profiles where it gave them, the table's for the rest of its models. */
export function catalogOf(models: readonly string[], names: Record<string, string> = {}, own: readonly ModelProfile[] = []): ModelProfile[] {
  const ids = [...new Set([...own.map((p) => p.id), ...models])];
  return ids.map((id) => own.find((p) => p.id === id) ?? profileOf(id, names[id]));
}

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** A model's name for people: "claude-sonnet-5-5" → "Sonnet 5.5", "opus" → "Opus"; other ids as they are. */
export function modelLabel(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/i.exec(id);
  if (claude) return `${capital(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  if (/^(fable|opus|sonnet|haiku)$/i.test(id)) return capital(id.toLowerCase());
  return id;
}
