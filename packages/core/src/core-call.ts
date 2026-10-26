// Core API exposed to plugins (each method must be granted in the plugin's permissions.core).

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreMethod } from "@openbot/shared";
import { parseBrainRef } from "@openbot/shared";
import type { Hub } from "./app.ts";

/** Largest file a plugin may hand to a workspace. */
const MAX_DELIVER_BYTES = 1024 * 1024 * 1024;

/** Plain file name: no path separators, control characters or leading dots. */
export function safeFileName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 150);
  return clean || "file";
}

export function createCoreCall(hub: Hub) {
  return async (pluginId: string, method: CoreMethod, p: any): Promise<unknown> => {
    p = p ?? {};
    switch (method) {
      case "conversations.post": {
        const conv = p.conversationId ? hub.store.getConversation(p.conversationId) : hub.store.agentConversation(hub.settings.get().defaultAgent);
        if (!conv) throw new Error("conversation not found");
        const role = p.role === "assistant" ? "assistant" : "system";
        const m = hub.store.addMessage({ conversationId: conv.id, role, parts: [{ type: "text", text: String(p.text ?? "") }], status: "complete", channel: `plugin:${pluginId}` });
        return { messageId: m.id, conversationId: conv.id };
      }
      case "channels.inbound": {
        // Channels (Telegram) talk to the default agent, in its dialog.
        const conv = p.conversationId ? hub.store.getConversation(p.conversationId) : hub.store.agentConversation(hub.settings.get().defaultAgent);
        if (!conv) throw new Error("conversation not found");
        const text = String(p.text ?? "").trim();
        if (!text) return { ignored: true };
        if (text === "/stop") return { interrupted: hub.runner.interrupt(conv.id) };
        const m = await hub.runner.userMessage(conv.id, text, { channel: String(p.channel ?? pluginId) });
        return { messageId: m.id, conversationId: conv.id };
      }
      case "tasks.create": {
        const agentId = p.agentId ?? hub.settings.get().defaultAgent;
        if (!hub.agents.get(agentId)) throw new Error(`unknown agent ${agentId}`);
        const t = hub.runner.createTask({
          agentId,
          goal: String(p.goal ?? ""),
          title: String(p.title ?? String(p.goal ?? "").slice(0, 60)),
          background: p.background !== false,
          createdBy: p.triggerId ? "trigger" : "user",
          triggerId: p.triggerId,
          parentConversationId: p.parentConversationId,
        });
        return t;
      }
      case "tasks.get":
        return hub.store.getTask(String(p.id)) ?? null;
      case "tasks.list":
        return hub.store.listTasks({ status: p.status, limit: p.limit ?? 50 });
      case "notify": {
        const n = await hub.notifier.notify({ level: p.level ?? "notify", title: String(p.title ?? ""), body: String(p.body ?? ""), triggerId: p.triggerId, agentId: p.agentId, taskId: p.taskId });
        return { id: n.id, level: n.effectiveLevel };
      }
      case "approvals.resolve": {
        if (!p.token) throw new Error("token is required");
        const a = hub.approvals.resolveByToken(String(p.id), p.decision === "approve" ? "approve" : "deny", String(p.token), "telegram");
        return { id: a.id, status: a.status, summary: a.summary };
      }
      case "settings.get": {
        const s = hub.settings.get();
        return {
          timezone: s.timezone,
          language: s.language,
          quietHours: s.quietHours,
          digestTimes: s.digestTimes,
          defaultAgent: s.defaultAgent,
          publicUrl: hub.config.publicUrl,
          consoleUrl: hub.config.consoleUrl,
        };
      }
      case "agents.list":
        return hub.agents.list().map((a) => ({ id: a.id, name: a.name, description: a.description, initiative: a.initiative }));
      case "ui.emit":
        hub.bus.emit("plugin.event", { pluginId, channel: String(p.channel ?? "default"), payload: hub.vault.redactor.value(p.payload) });
        return {};
      case "vault.check": {
        const id = String(p.ref ?? "").replace(/^vault:\/\//, "");
        const m = hub.vault.getMeta(id);
        return { exists: !!m, state: hub.vault.state(), type: m?.type, hints: m?.hints };
      }
      case "machines.list":
        return hub.machines.list().map((m) => ({ id: m.id, name: m.name, status: m.status }));
      case "notifications.feedback": {
        const n = hub.notifier.feedback(String(p.id), p.value, String(p.token ?? ""));
        return { id: n.id, feedback: n.feedback };
      }
      case "files.deliver": {
        // Plugins run as another unix user: files they fetch for an agent are copied into its workspace by the hub.
        const s = hub.store.getSession(String(p.sessionId ?? ""));
        if (!s) throw new Error("session not found");
        if (parseBrainRef(s.brainRef).machineId !== "local") throw new Error("files can only be delivered to a workspace on the hub");
        const data = Buffer.from(String(p.data ?? ""), "base64");
        const dir = join(hub.runner.workspacePath(s), "downloads");
        mkdirSync(dir, { recursive: true });
        let rel: string;
        if (p.path) {
          rel = String(p.path);
          const name = rel.startsWith("downloads/") ? rel.slice("downloads/".length) : "";
          if (!name || safeFileName(name) !== name || !existsSync(join(dir, name))) throw new Error("invalid path");
          if (statSync(join(dir, name)).size + data.length > MAX_DELIVER_BYTES) throw new Error("file too large");
          appendFileSync(join(dir, name), data);
        } else {
          const name = safeFileName(String(p.name ?? ""));
          const dot = name.lastIndexOf(".");
          const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
          let candidate = name;
          for (let i = 1; existsSync(join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
          writeFileSync(join(dir, candidate), data, { mode: 0o640 });
          rel = `downloads/${candidate}`;
        }
        return { path: rel, absolutePath: join(hub.runner.workspacePath(s), rel) };
      }
      default:
        throw new Error(`unknown core method ${method}`);
    }
  };
}
