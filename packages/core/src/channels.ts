import type { OutboundMessage } from "@owlbot/shared";
import type { RpcPeer } from "@owlbot/shared";
import type { Redactor } from "./vault/redact.ts";
import { t } from "./i18n.ts";

export interface ChannelInfo {
  id: string;
  label: string;
  pluginId: string;
}

export class ChannelRegistry {
  private channels = new Map<string, ChannelInfo & { peer: RpcPeer }>();
  redactor: Redactor;
  constructor(redactor: Redactor) {
    this.redactor = redactor;
  }

  register(id: string, label: string, pluginId: string, peer: RpcPeer): void {
    this.channels.set(id, { id, label, pluginId, peer });
  }

  unregisterPlugin(pluginId: string): void {
    for (const [id, c] of this.channels) if (c.pluginId === pluginId) this.channels.delete(id);
  }

  list(): ChannelInfo[] {
    return [...this.channels.values()].map(({ id, label, pluginId }) => ({ id, label, pluginId }));
  }

  has(id: string): boolean {
    return this.channels.has(id);
  }

  async send(id: string, message: OutboundMessage): Promise<boolean> {
    const c = this.channels.get(id);
    if (!c || c.peer.closed) return false;
    try {
      // Uploading pictures takes longer than a text.
      await c.peer.request("channel.send", { channelId: id, message: this.redactor.value(message) }, { timeoutMs: message.media?.length ? 180_000 : 30_000 });
      return true;
    } catch (e) {
      console.error(`[channels] ${id} send failed:`, (e as Error).message);
      return false;
    }
  }

  async broadcast(message: OutboundMessage): Promise<void> {
    await Promise.all([...this.channels.keys()].map((id) => this.send(id, message)));
  }

  async status(id: string): Promise<{ connected: boolean; detail?: string }> {
    const c = this.channels.get(id);
    if (!c) return { connected: false, detail: t("channel.notConnected") };
    try {
      return await c.peer.request("channel.status", { channelId: id }, { timeoutMs: 10_000 });
    } catch (e: any) {
      return { connected: false, detail: e.message };
    }
  }
}
