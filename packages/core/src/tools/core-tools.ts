// Tools implemented by the core itself (owner "core").

import type { ToolDescriptor, ToolResult } from "@openbot/shared";
import type { ToolRegistry } from "./registry.ts";
import type { SkillIndex } from "../skills.ts";
import type { VaultService } from "../vault/service.ts";
import type { Store } from "../store.ts";
import type { Notifier } from "../notifier.ts";
import type { AgentRegistry } from "../agents.ts";

export interface CoreToolDeps {
  registry: ToolRegistry;
  skills: SkillIndex;
  vault: VaultService;
  store: Store;
  notifier: Notifier;
  agents: AgentRegistry;
  createTask: (t: { agentId: string; goal: string; title: string; parentConversationId?: string; parentTaskId?: string; background: boolean; createdBy: "agent" }) => { id: string; title: string };
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export function registerCoreTools(d: CoreToolDeps): void {
  const reg = (spec: Omit<ToolDescriptor, "owner">, fn: (input: any, ctx: any) => Promise<ToolResult> | ToolResult) =>
    d.registry.register({ ...spec, owner: "core" }, async (input, ctx) => fn(input ?? {}, ctx));

  reg(
    {
      name: "notify",
      description:
        "Tell the user something proactively. level: silent (log only), digest (goes into the next summary), notify (deliver now — interrupts the user), ask (needs the user's decision). Use sparingly.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["silent", "digest", "notify", "ask"] },
          title: { type: "string", description: "Short headline (≤ 80 chars)" },
          body: { type: "string", description: "Concise details" },
        },
        required: ["level", "title"],
      },
    },
    async (i, ctx) => {
      const task = ctx.taskId ? d.store.getTask(ctx.taskId) : undefined;
      const n = await d.notifier.notify({
        level: i.level,
        title: String(i.title ?? "").slice(0, 200),
        body: String(i.body ?? ""),
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        triggerId: task?.triggerId,
        conversationId: ctx.conversationId,
      });
      return text(`Уведомление записано (уровень: ${n.effectiveLevel}${n.reason ? `, ${n.reason}` : ""}).`);
    },
  );

  reg(
    {
      name: "task_delegate",
      description: "Start a separate task for an agent (yourself or a specialist). It runs in parallel and reports back here when done. Returns the task id.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Complete, self-contained instructions" },
          title: { type: "string" },
          agent: { type: "string", description: "Agent id (default: same agent). See task_agents." },
        },
        required: ["goal"],
      },
    },
    (i, ctx) => {
      const agentId = i.agent ? String(i.agent) : ctx.agentId;
      if (!d.agents.get(agentId)) return text(`Нет агента ${agentId}`, true);
      const t = d.createTask({
        agentId,
        goal: String(i.goal),
        title: String(i.title ?? String(i.goal).slice(0, 60)),
        parentConversationId: ctx.conversationId,
        parentTaskId: ctx.taskId,
        background: ctx.background,
        createdBy: "agent",
      });
      return text(`Задача создана: ${t.id} «${t.title}». Результат придёт сюда сообщением.`);
    },
  );

  reg(
    { name: "task_agents", description: "List available agents you can delegate to.", effect: "read", inputSchema: { type: "object", properties: {} } },
    () => text(d.agents.list().map((a) => `- ${a.id}: ${a.name} — ${a.description}`).join("\n")),
  );

  reg(
    {
      name: "task_status",
      description: "Get status and result of a task by id.",
      effect: "read",
      inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    },
    (i) => {
      const t = d.store.getTask(String(i.taskId));
      if (!t) return text("Задача не найдена", true);
      return text(JSON.stringify({ id: t.id, title: t.title, status: t.status, result: t.result, error: t.error }, null, 2));
    },
  );

  reg(
    {
      name: "skill_load",
      description: "Load the full instructions (SKILL.md) of a skill by name.",
      effect: "read",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    (i) => {
      const s = d.skills.load(String(i.name));
      return s ? text(s) : text(`Скилл ${i.name} не найден`, true);
    },
  );

  reg(
    {
      name: "vault_list",
      description: "List vault items (ids, names, types, non-secret hints). Never returns secret values. Pass `vault://<id>` to tools that accept secrets.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const items = d.vault.list();
      if (!items.length) return text("Vault пуст.");
      return text(
        `Vault: ${d.vault.state()}\n` +
          items.map((m) => `- vault://${m.id} (${m.type}) «${m.name}»${Object.keys(m.hints).length ? ` ${JSON.stringify(m.hints)}` : ""}${m.scope.revealToModel ? " [можно прочитать: vault_reveal]" : ""}`).join("\n"),
      );
    },
  );

  reg(
    {
      name: "vault_reveal",
      description: "Read the fields of a vault item that the user explicitly allowed to show to the model (revealToModel). Other items are refused.",
      effect: "read",
      inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    },
    (i, ctx) => {
      const id = String(i.ref).replace(/^vault:\/\//, "");
      const meta = d.vault.getMeta(id);
      if (!meta) return text(`Нет записи vault://${id}`, true);
      if (!meta.scope.revealToModel) return text("Эту запись нельзя показывать модели. Используйте ссылку vault:// в инструментах.", true);
      const fields = d.vault.access(id, { actor: `agent:${ctx.agentId}`, agentId: ctx.agentId, tool: "vault_reveal" });
      return text(JSON.stringify(fields, null, 2));
    },
  );
}
