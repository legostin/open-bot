// The models each provider offers now, from its own list (GET /models): the hub chooses among current ones by what
// the provider says of them (descriptions, prices, deprecations; shared/models.ts), and an older generation next to a
// newer one is marked. Asked through the plugin's egress proxy, kept for six hours per provider and key; the
// built-in list (settings.ts) stands in until the first answer, and whenever the provider cannot be asked.

import type { ModelMeta, ModelProfile } from "@piomio/shared";
import { markLegacy, profileFrom } from "@piomio/shared/models";
import { proxyEnvFrom, request, trimSlash } from "./http.ts";
import type { ApiSettings, VariantInfo } from "./settings.ts";

const TTL_MS = 6 * 3600_000;
/** Lists longer than this (OpenRouter has hundreds) keep the newest. */
const MAX_MODELS = 80;

/** Models that do not chat: embeddings, speech, images, moderation, search and the like. */
const NOT_CHAT = /embed|whisper|tts|dall-e|gpt-image|image|audio|realtime|moderation|transcri|speech|rerank|ocr|guard|search|computer-use|babbage|davinci|instruct$/i;

interface Listed {
  meta: ModelMeta;
  created?: number;
}

/** One provider's /models answer as models that chat, newest first when it says when they came out. */
export function parseModels(protocol: VariantInfo["protocol"], body: unknown): Listed[] {
  const data = (body as { data?: unknown[]; models?: unknown[] })?.data ?? (body as { models?: unknown[] })?.models;
  if (!Array.isArray(data)) return [];
  const out: Listed[] = [];
  for (const raw of data) {
    const x = (raw ?? {}) as Record<string, any>;
    const id = typeof x.id === "string" ? x.id.replace(/^models\//, "") : typeof x.name === "string" ? x.name.replace(/^models\//, "") : "";
    if (!id || NOT_CHAT.test(id)) continue;
    // OpenRouter: what comes out of it; Mistral: whether it chats.
    const outputs = x.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    if (x.capabilities && x.capabilities.completion_chat === false) continue;
    const name = typeof x.display_name === "string" ? x.display_name : typeof x.name === "string" && x.name !== id && !x.name.startsWith("models/") ? x.name : undefined;
    const description = typeof x.description === "string" ? x.description.slice(0, 400) : undefined;
    const prompt = Number(x.pricing?.prompt);
    const completion = Number(x.pricing?.completion);
    const price = Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 ? { input: prompt * 1e6, output: completion * 1e6 } : undefined;
    const deprecated = !!(x.deprecation || x.deprecated || x.expiration_date);
    const inputs = x.architecture?.input_modalities;
    const images = Array.isArray(inputs) && inputs.includes("image");
    const created = typeof x.created === "number" ? x.created : typeof x.created_at === "string" ? Date.parse(x.created_at) / 1000 : undefined;
    out.push({ meta: { id, ...(name ? { name } : {}), ...(description ? { description } : {}), ...(price ? { price } : {}), ...(deprecated ? { deprecated } : {}), ...(images ? { images } : {}) }, ...(created ? { created } : {}) });
  }
  if (protocol === "anthropic") return out;
  return out.sort((a, z) => (z.created ?? 0) - (a.created ?? 0));
}

/** The lineup as profiles, with older generations marked. */
export function catalogFrom(listed: Listed[]): ModelProfile[] {
  return markLegacy(listed.slice(0, MAX_MODELS).map((l) => profileFrom(l.meta)));
}

/** Fresh lineups per provider and key, asked again after six hours. */
export class ModelLists {
  private lists = new Map<string, { at: number; catalog: ModelProfile[] }>();
  private asking = new Map<string, Promise<ModelProfile[] | undefined>>();

  /** The provider's current lineup, or undefined when it cannot be asked now (the built-in list stands in). */
  async get(v: VariantInfo, s: ApiSettings, key: string | undefined, waitMs = 4000): Promise<ModelProfile[] | undefined> {
    const k = `${v.id}|${v.baseUrl(s)}|${key ?? ""}`;
    const have = this.lists.get(k);
    if (have && Date.now() - have.at < TTL_MS) return have.catalog;
    let asking = this.asking.get(k);
    if (!asking) {
      asking = fetchList(v, s, key)
        .then((catalog) => {
          if (catalog?.length) this.lists.set(k, { at: Date.now(), catalog });
          return catalog;
        })
        .catch(() => undefined)
        .finally(() => this.asking.delete(k));
      this.asking.set(k, asking);
    }
    // The first answer is worth a short wait; after that the old list serves while a new one comes.
    if (have) return have.catalog;
    return Promise.race([asking, new Promise<undefined>((r) => setTimeout(() => r(undefined), waitMs).unref?.())]);
  }
}

async function fetchList(v: VariantInfo, s: ApiSettings, key: string | undefined): Promise<ModelProfile[] | undefined> {
  const base = trimSlash(v.baseUrl(s));
  const anthropic = v.protocol === "anthropic";
  const url = anthropic ? `${base}/v1/models?limit=100` : `${base}/models`;
  const headers: Record<string, string> = anthropic
    ? { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
    : key
      ? { authorization: `Bearer ${key}` }
      : {};
  const r = await request(url, { headers, proxyEnv: proxyEnvFrom(process.env as Record<string, string>), signal: AbortSignal.timeout(10_000) });
  if (r.status !== 200) return undefined;
  const listed = parseModels(v.protocol, JSON.parse(await r.text()));
  return listed.length ? catalogFrom(listed) : undefined;
}
