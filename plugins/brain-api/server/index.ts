// Builtin plugin "brain-api": the "api" brain — our own agent loop over LLM APIs.
// Variants (brain refs "api:<variant>"): anthropic (Messages API), openai (Responses API), openrouter, the OpenAI-compatible providers
// (settings.ts PROVIDERS: Kimi, DeepSeek, GLM, Qwen, Gemini, Grok, Mistral, Groq) and custom (any OpenAI-compatible
// endpoint: Ollama, LM Studio, vLLM). Tools come from the hub's MCP endpoint.

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrainSessionOptions, ProbeResult } from "@owlbot/shared";
import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import { isSafeSessionId, loadSession, type HistoryMessage } from "./history.ts";
import { request, trimSlash } from "./http.ts";
import { ApiBrainSession, readKey } from "./session.ts";
import { ModelLists } from "./catalog.ts";
import { ANTHROPIC_MODEL_NAMES, VARIANTS, extraModelsFor, resolveSettings, type ApiSettings } from "./settings.ts";

const SESSION_TTL_MS = 30 * 24 * 3600_000;

function pruneOldSessions(ctx: PluginContext): void {
  const dir = join(ctx.dataDir, "sessions");
  if (!existsSync(dir)) return;
  const now = Date.now();
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > SESSION_TTL_MS) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/**
 * What a server on this machine (the default Ollama address) says about its models: "down" when it does not answer,
 * the model ids when it lists them, undefined when it answers otherwise (401, 404). Without this the brain counts as
 * ready on a fresh install, or with a model the server does not have, and the first message fails. Other hosts are
 * not checked: with egress enforcement only the sessions' proxy reaches them.
 */
async function localServerModels(base: string, key?: string): Promise<"down" | string[] | undefined> {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return undefined;
  }
  if (!["localhost", "::1", "[::1]"].includes(host) && !host.startsWith("127.")) return undefined;
  try {
    const r = await request(`${trimSlash(base)}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(2500) });
    const text = await r.text().catch(() => "");
    if (r.status !== 200) return undefined;
    const data = JSON.parse(text)?.data;
    return Array.isArray(data) ? data.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === "string") : undefined;
  } catch (e: any) {
    return e instanceof SyntaxError ? undefined : "down";
  }
}

/** Ollama lists "llama3.1:latest" for the "llama3.1" people write. */
const hasModel = (ids: string[], model: string) => ids.includes(model) || ids.includes(`${model}:latest`);

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    let settings: ApiSettings = resolveSettings(ctx.settings);
    ctx.onSettingsChange((s) => {
      settings = resolveSettings(s);
    });
    pruneOldSessions(ctx);

    const variantOf = (id: string | undefined) => VARIANTS[id ?? settings.defaultVariant];
    const lists = new ModelLists();

    async function probe(variantId?: string): Promise<ProbeResult> {
      const s = settings;
      const v = variantOf(variantId);
      if (!v) {
        return {
          available: false,
          authenticated: false,
          detail: ctx.i18n.t("probe.unknownVariant", { variant: String(variantId), variants: Object.keys(VARIANTS).join(", ") }),
        };
      }
      const def = v.defaultModel(s);
      // Every model it offers (the hub picks one per request), the default and the user's additions too.
      let models = [...new Set([...v.models, def, ...extraModelsFor(v.id, s)])];
      // How it thinks: the models' names, the efforts the provider takes and what each preset means here.
      const thinking = {
        ...(v.protocol === "anthropic" ? { modelNames: ANTHROPIC_MODEL_NAMES } : {}),
        ...(v.efforts.length ? { efforts: v.efforts } : {}),
        presets: v.presets(s),
      };
      const key = await readKey(ctx, v, s);
      if (key.error) return { available: true, authenticated: false, models, model: def, ...thinking, detail: key.error };
      if (v.id === "custom") {
        const url = v.baseUrl(s);
        const listed = await localServerModels(url, key.key);
        if (listed === "down") return { available: true, authenticated: false, models, model: def, ...thinking, detail: ctx.i18n.t("probe.serverDown", { url }) };
        if (listed && !hasModel(listed, def)) {
          const detail = ctx.i18n.t(listed.length ? "probe.modelMissing" : "probe.noModels", { model: def, url, models: listed.join(", ") });
          return { available: true, authenticated: false, models: listed, model: def, ...thinking, detail };
        }
        if (listed) models = listed;
        return { available: true, authenticated: true, models, model: def, ...thinking, detail: v.baseUrl(s) };
      }
      // What the provider offers now (its /models), over the built-in list; the user's additions stay in.
      const fresh = await lists.get(v, s, key.key);
      if (!fresh?.length) return { available: true, authenticated: true, models, model: def, ...thinking };
      const extra = extraModelsFor(v.id, s).filter((m) => !fresh.some((p) => p.id === m));
      return { available: true, authenticated: true, models: [...fresh.map((p) => p.id), ...extra], catalog: fresh, model: def, ...thinking };
    }

    async function createSession(opts: BrainSessionOptions): Promise<ApiBrainSession> {
      const v = variantOf(opts.variant);
      if (!v) throw new Error(ctx.i18n.t("error.unknownVariant", { variant: String(opts.variant) }));
      if (!isSafeSessionId(opts.sessionId)) throw new Error(`invalid session id: ${opts.sessionId}`);
      let history: HistoryMessage[] = [];
      let prefixHash: string | undefined;
      if (opts.resume) {
        try {
          const saved = loadSession(ctx.dataDir, opts.resume);
          if (saved) {
            history = saved.messages;
            prefixHash = saved.prefixHash;
          } else ctx.log.warn(`no saved history for ${opts.resume}, starting over`);
        } catch (e: any) {
          ctx.log.warn(`could not load the history of ${opts.resume}: ${e?.message ?? e}`);
        }
      }
      return new ApiBrainSession({ ctx, opts, variant: v, settings: () => settings, history, prefixHash });
    }

    ctx.brains.register({ id: "api", label: "API", variants: Object.keys(VARIANTS), probe, createSession });
  },
};

export default plugin;
