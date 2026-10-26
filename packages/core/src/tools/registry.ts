import type { ToolCallContext, ToolDescriptor, ToolResult } from "@owlbot/shared";

export type ToolInvoker = (input: any, ctx: ToolCallContext) => Promise<ToolResult>;

interface Entry {
  descriptor: ToolDescriptor;
  invoke: ToolInvoker;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeToolName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export class ToolRegistry {
  private tools = new Map<string, Entry>();
  onChange?: () => void;

  register(descriptor: ToolDescriptor, invoke: ToolInvoker): void {
    if (!NAME_RE.test(descriptor.name)) throw new Error(`invalid tool name "${descriptor.name}" (allowed: a-z A-Z 0-9 _ -, up to 64)`);
    const existing = this.tools.get(descriptor.name);
    if (existing && existing.descriptor.owner !== descriptor.owner) {
      throw new Error(`tool ${descriptor.name} already registered by ${existing.descriptor.owner}`);
    }
    this.tools.set(descriptor.name, { descriptor, invoke });
    this.onChange?.();
  }

  unregisterOwner(owner: string): void {
    let changed = false;
    for (const [name, e] of this.tools) {
      if (e.descriptor.owner === owner) {
        this.tools.delete(name);
        changed = true;
      }
    }
    if (changed) this.onChange?.();
  }

  get(name: string): Entry | undefined {
    return this.tools.get(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((e) => e.descriptor).sort((a, b) => a.name.localeCompare(b.name));
  }
}
