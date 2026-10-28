// The single path every tool call takes: agent allowlist → hooks → policy → approval → invoke → redact → taint → audit.

import type { AgentDef, Approval, ToolCallContext, ToolDescriptor, ToolResult } from "@owlbot/shared";
import { matchesAny, newId, parseBrainRef, renderTemplate, truncate } from "@owlbot/shared";
import type { Store, SessionRow } from "../store.ts";
import type { ToolRegistry } from "./registry.ts";
import type { HookRegistry } from "../hooks.ts";
import type { RuleStore } from "../policy/rules.ts";
import type { ApprovalService } from "../approvals.ts";
import type { AuditLog } from "../audit.ts";
import type { Redactor } from "../vault/redact.ts";
import type { Settings } from "../settings.ts";
import { BACKGROUND_ALWAYS_ALLOWED, decide } from "../policy/engine.ts";
import { HUB_TOOL_PREFIX } from "./hub-tools.ts";

export interface AgentLookup {
  get(id: string): AgentDef | undefined;
}

export interface GatewayDeps {
  store: Store;
  registry: ToolRegistry;
  hooks: HookRegistry;
  rules: RuleStore;
  approvals: ApprovalService;
  audit: AuditLog;
  redactor: Redactor;
  settings: Settings;
  agents: AgentLookup;
  workspaceFor: (s: SessionRow) => string;
  /** Resolve "%key%" in user-facing tool texts (approval summaries) against the tool owner's messages. */
  localize?: (owner: string, text: string) => string;
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

export class ToolGateway {
  d: GatewayDeps;
  constructor(deps: GatewayDeps) {
    this.d = deps;
  }

  private agentFor(s: SessionRow): AgentDef {
    const a = this.d.agents.get(s.agentId);
    if (!a) throw new Error(`unknown agent ${s.agentId}`);
    return a;
  }

  /** Tools this session may see. */
  listFor(s: SessionRow): ToolDescriptor[] {
    const agent = this.agentFor(s);
    return this.d.registry.list().filter((t) => this.visible(t, agent, s));
  }

  private visible(t: ToolDescriptor, agent: AgentDef, s: SessionRow): boolean {
    if (!matchesAny(t.name, agent.tools.length ? agent.tools : ["*"])) return false;
    // Hub administration belongs to the default agent alone (see tools/hub-tools.ts).
    if (t.owner === "core" && t.name.startsWith(HUB_TOOL_PREFIX) && agent.id !== this.d.settings.get().defaultAgent) return false;
    if (t.availability === "background" && !s.background) return false;
    if (t.availability === "interactive" && s.background) return false;
    if (s.background && agent.initiative < 2 && t.effect !== "read" && !BACKGROUND_ALWAYS_ALLOWED.includes(t.name)) return false;
    return true;
  }

  contextFor(s: SessionRow, callId: string): ToolCallContext {
    return {
      sessionId: s.id,
      conversationId: s.conversationId,
      taskId: s.taskId,
      agentId: s.agentId,
      callId,
      tainted: s.tainted,
      background: s.background,
      workspace: this.d.workspaceFor(s),
      machineId: parseBrainRef(s.brainRef).machineId,
    };
  }

  async call(sessionId: string, name: string, rawInput: unknown, callId = newId("call_")): Promise<ToolResult> {
    const s = this.d.store.getSession(sessionId);
    if (!s) return { content: [{ type: "text", text: "Session not found" }], isError: true };
    const agent = this.agentFor(s);
    const entry = this.d.registry.get(name);
    if (!entry || !this.visible(entry.descriptor, agent, s)) {
      this.d.audit.append(`agent:${s.agentId}`, "tool.denied", name, { reason: "not available" });
      return { content: [{ type: "text", text: `Tool ${name} is not available to this agent` }], isError: true };
    }
    const tool = entry.descriptor;
    const ctx = this.contextFor(s, callId);

    // Hooks may block or rewrite the input.
    const hooked = await this.d.hooks.run("tool.before", { tool: name, input: rawInput ?? {}, context: ctx }, (p, r) =>
      r.block ? { blocked: r.block } : r.input !== undefined ? { ...p, input: r.input } : p,
    );
    if (hooked.blocked) {
      this.d.audit.append(`agent:${s.agentId}`, "tool.blocked", name, { reason: hooked.blocked });
      return { content: [{ type: "text", text: `Blocked: ${hooked.blocked}` }], isError: true, _meta: { status: "denied" } };
    }
    const input = hooked.payload.input;

    const settings = this.d.settings.get();
    const policy = decide(
      { tool, input, agentId: s.agentId, tainted: s.tainted, background: s.background, initiative: agent.initiative, profile: agent.policyProfile },
      this.d.rules.list(),
      (t) => this.d.rules.isKnownTarget(t),
    );
    this.d.audit.append(`agent:${s.agentId}`, "policy.decision", name, { decision: policy.decision, reason: policy.reason, ruleId: policy.ruleId });

    if (policy.decision === "deny") {
      return { content: [{ type: "text", text: `Denied by policy: ${policy.reason}` }], isError: true, _meta: { status: "denied" } };
    }

    if (policy.decision === "ask") {
      const summary = this.summarize(tool, input);
      const approval = this.d.approvals.create({
        sessionId: s.id,
        conversationId: s.conversationId,
        taskId: s.taskId,
        agentId: s.agentId,
        tool: name,
        input: this.d.redactor.value(input),
        summary,
        effect: tool.effect,
        tainted: s.tainted,
      });
      // Mark the task as waiting while we hold the call.
      if (s.taskId) this.d.store.updateTask(s.taskId, { status: "waiting_approval" });
      const outcome = await this.d.approvals.wait(approval.id, settings.approvalInlineWaitSec * 1000);
      if (s.taskId) this.d.store.updateTask(s.taskId, { status: "running" });
      if (outcome === "denied") {
        return { content: [{ type: "text", text: `The user declined the action: ${summary}` }], isError: true, _meta: { status: "denied", approvalId: approval.id } };
      }
      if (outcome === "timeout") {
        return {
          content: [
            {
              type: "text",
              text:
                `The action is waiting for the user's approval (approvalId=${approval.id}): ${summary}. ` +
                `Do not repeat the call. End your turn and briefly tell the user the action waits for their approval ` +
                `(they answer on the approval card, in the phone app or in the security console). ` +
                `When the user answers, the system carries out the action itself and sends you the result.`,
            },
          ],
          _meta: { status: "awaiting_approval", approvalId: approval.id },
        };
      }
      const result = await this.execute(s, tool, input, ctx);
      this.d.approvals.markExecuted(approval.id, result);
      return result;
    }

    return this.execute(s, tool, input, ctx);
  }

  /** Run an approved action later (deferred approval). */
  async executeApproved(a: Approval): Promise<ToolResult> {
    const s = this.d.store.getSession(a.sessionId);
    const entry = this.d.registry.get(a.tool);
    if (!s || !entry) return { content: [{ type: "text", text: "The tool or session is no longer available" }], isError: true };
    const result = await this.execute(s, entry.descriptor, a.input, this.contextFor(s, newId("call_")));
    this.d.approvals.markExecuted(a.id, result);
    return result;
  }

  private async execute(s: SessionRow, tool: ToolDescriptor, input: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    const entry = this.d.registry.get(tool.name)!;
    let result: ToolResult;
    const started = Date.now();
    try {
      result = await entry.invoke(input, ctx);
    } catch (e: any) {
      result = { content: [{ type: "text", text: `Tool error: ${e?.message ?? String(e)}` }], isError: true };
    }
    const after = await this.d.hooks.run("tool.after", { tool: tool.name, input, result, context: ctx }, (p, r) => (r.result ? { ...p, result: r.result } : p));
    result = after.payload.result;

    // Never let vault values reach the model.
    result = {
      ...result,
      content: result.content.map((c) => (c.type === "text" ? { ...c, text: this.d.redactor.text(c.text) } : c)),
    };

    if ((tool.source || result._meta?.taint) && !s.tainted) {
      this.d.store.updateSession(s.id, { tainted: true });
    }
    this.d.audit.append(`agent:${s.agentId}`, "tool.call", tool.name, {
      sessionId: s.id,
      taskId: s.taskId,
      input: truncateDeep(input),
      isError: !!result.isError,
      ms: Date.now() - started,
      output: truncate(textOf(result), 300),
    });
    return result;
  }

  summarize(tool: ToolDescriptor, input: unknown): string {
    const safe = this.d.redactor.value(input);
    if (tool.approvalSummary) {
      const template = this.d.localize ? this.d.localize(tool.owner, tool.approvalSummary) : tool.approvalSummary;
      return truncate(renderTemplate(template, safe), 300);
    }
    return truncate(`${tool.name} ${JSON.stringify(safe)}`, 300);
  }
}

function truncateDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return truncate(v, 500);
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => truncateDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).slice(0, 30)) o[k] = truncateDeep(x, depth + 1);
    return o;
  }
  return v;
}
