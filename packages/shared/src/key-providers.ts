// Providers a machine's CLI brain can use with a key the hub keeps, through the machine's gateway
// (packages/node/src/gateway.ts). Claude Code speaks the Anthropic wire, Codex the OpenAI Responses wire.
// The vault ids are the ones the API brain uses (plugins/brain-api/server/settings.ts), so one key serves both.

import type { MachineBrainId, MachineModel } from "./types.ts";

export type KeyWire = "anthropic" | "openai";

export interface KeyProvider {
  id: string;
  label: string;
  wire: KeyWire;
  /** Requests go to `${baseUrl}${path}`, the path as the CLI sent it (/v1/messages, /v1/responses…). */
  baseUrl: string;
  /** How the key travels: Anthropic's own header, or a bearer token (the compatible endpoints). */
  auth: "x-api-key" | "bearer";
  vaultId: string;
}

export const KEY_PROVIDERS: readonly KeyProvider[] = [
  { id: "anthropic", label: "Anthropic", wire: "anthropic", baseUrl: "https://api.anthropic.com", auth: "x-api-key", vaultId: "anthropic_api_key" },
  { id: "deepseek", label: "DeepSeek", wire: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", auth: "bearer", vaultId: "deepseek_api_key" },
  { id: "moonshot", label: "Kimi (Moonshot)", wire: "anthropic", baseUrl: "https://api.moonshot.ai/anthropic", auth: "bearer", vaultId: "moonshot_api_key" },
  { id: "zhipu", label: "GLM (Z.ai)", wire: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", auth: "bearer", vaultId: "zhipu_api_key" },
  // Codex appends /responses to its provider's base URL.
  { id: "openai", label: "OpenAI", wire: "openai", baseUrl: "https://api.openai.com/v1", auth: "bearer", vaultId: "openai_api_key" },
];

export const keyProvider = (id: string): KeyProvider | undefined => KEY_PROVIDERS.find((p) => p.id === id);

/** The wire a machine brain speaks. */
export const brainWire = (brain: MachineBrainId): KeyWire => (brain === "codex" ? "openai" : "anthropic");

/** Token counts of one model call. Input counts only tokens read fresh (not from or into the cache). */
export interface CallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Dollars a call cost at a price per million tokens: cache reads at 10 % of input, cache writes at 125 %. */
export function costOf(t: CallTokens, price: MachineModel["price"]): number {
  if (!price) return 0;
  const usd = (t.input * price.input + t.cacheRead * price.input * 0.1 + t.cacheWrite * price.input * 1.25 + t.output * price.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** The cheapest model of a list (by input plus output price; unpriced last). */
export function cheapestModel<T extends MachineModel>(models: readonly T[]): T | undefined {
  const cost = (m: MachineModel) => (m.price ? m.price.input + m.price.output : Number.POSITIVE_INFINITY);
  return [...models].sort((a, b) => cost(a) - cost(b))[0];
}
