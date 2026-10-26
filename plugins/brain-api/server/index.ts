// Builtin plugin "brain-api": the "api" brain — our own agent loop over LLM APIs.
// Variants (brain refs "api:<variant>"): anthropic (Messages API), openai, openrouter, custom (any
// OpenAI-compatible endpoint: Ollama, LM Studio, vLLM). Tools come from the hub's MCP endpoint.

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrainSessionOptions, ProbeResult } from "@owlbot/shared";
import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import { isSafeSessionId, loadSession, type HistoryMessage } from "./history.ts";
import { request, trimSlash } from "./http.ts";
import { ApiBrainSession, readKey } from "./session.ts";
import { ANTHROPIC_MODELS, VARIANTS, resolveSettings, type ApiSettings } from "./settings.ts";

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
 * True when a server on this machine (the default Ollama address) does not answer. Without this the brain counts
 * as ready on a fresh install and the first message fails. Other hosts are not checked: with egress enforcement
 * only the sessions' proxy reaches them.
 */
async function localServerDown(base: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return false;
  }
  if (!["localhost", "::1", "[::1]"].includes(host) && !host.startsWith("127.")) return false;
  try {
    const r = await request(`${trimSlash(base)}/models`, { signal: AbortSignal.timeout(2500) });
    await r.text().catch(() => "");
    return false; // any answer, even 401 or 404, means something is listening
  } catch {
    return true;
  }
}

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    let settings: ApiSettings = resolveSettings(ctx.settings);
    ctx.onSettingsChange((s) => {
      settings = resolveSettings(s);
    });
    pruneOldSessions(ctx);

    const variantOf = (id: string | undefined) => VARIANTS[id ?? settings.defaultVariant];

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
      const models = v.protocol === "anthropic" ? [...new Set([...ANTHROPIC_MODELS, def])] : [def];
      const key = await readKey(ctx, v, s);
      if (key.error) return { available: true, authenticated: false, models, detail: key.error };
      if (v.id === "custom" && (await localServerDown(v.baseUrl(s)))) {
        return { available: true, authenticated: false, models, detail: ctx.i18n.t("probe.serverDown", { url: v.baseUrl(s) }) };
      }
      return { available: true, authenticated: true, models, ...(v.id === "custom" ? { detail: v.baseUrl(s) } : {}) };
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

    ctx.brains.register({ id: "api", label: "API", variants: ["anthropic", "openai", "openrouter", "custom"], probe, createSession });
  },
};

export default plugin;
