// Builtin plugin "brain-api": the "api" brain — our own agent loop over LLM APIs.
// Variants (brain refs "api:<variant>"): anthropic (Messages API), openai, openrouter, custom (any
// OpenAI-compatible endpoint: Ollama, LM Studio, vLLM). Tools come from the hub's MCP endpoint.

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrainSessionOptions, ProbeResult } from "@openbot/shared";
import type { PluginContext, PluginModule } from "@openbot/plugin-sdk";
import { isSafeSessionId, loadSession, type HistoryMessage } from "./history.ts";
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
        return { available: false, authenticated: false, detail: `Неизвестный вариант «${variantId}». Доступны: ${Object.keys(VARIANTS).join(", ")}` };
      }
      const def = v.defaultModel(s);
      const models = v.protocol === "anthropic" ? [...new Set([...ANTHROPIC_MODELS, def])] : [def];
      const key = await readKey(ctx, v, s);
      if (key.error) return { available: true, authenticated: false, models, detail: key.error };
      return { available: true, authenticated: true, models, ...(v.id === "custom" ? { detail: v.baseUrl(s) } : {}) };
    }

    async function createSession(opts: BrainSessionOptions): Promise<ApiBrainSession> {
      const v = variantOf(opts.variant);
      if (!v) throw new Error(`Неизвестный вариант API-мозга: ${opts.variant}`);
      if (!isSafeSessionId(opts.sessionId)) throw new Error(`недопустимый идентификатор сессии: ${opts.sessionId}`);
      let history: HistoryMessage[] = [];
      let prefixHash: string | undefined;
      if (opts.resume) {
        try {
          const saved = loadSession(ctx.dataDir, opts.resume);
          if (saved) {
            history = saved.messages;
            prefixHash = saved.prefixHash;
          } else ctx.log.warn(`нет сохранённой истории для ${opts.resume}, начинаю заново`);
        } catch (e: any) {
          ctx.log.warn(`не удалось загрузить историю ${opts.resume}: ${e?.message ?? e}`);
        }
      }
      return new ApiBrainSession({ ctx, opts, variant: v, settings: () => settings, history, prefixHash });
    }

    ctx.brains.register({ id: "api", label: "API", probe, createSession });
  },
};

export default plugin;
