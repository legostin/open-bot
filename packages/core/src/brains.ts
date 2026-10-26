// Brain registry: brains contributed by plugins (local) and by paired machines (remote).
// Gives the session runner one interface regardless of where the brain runs.

import type { BrainEvent, BrainSessionOptions, BrainTurn, ProbeResult, BrainRef } from "@openbot/shared";
import { formatBrainRef, parseBrainRef, type RpcPeer } from "@openbot/shared";
import { LocalizedError, t } from "./i18n.ts";

export interface BrainHandle {
  ref: string;
  send(turn: BrainTurn, onEvent: (e: BrainEvent) => void): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** Something that can host brains: a plugin process (local) or a node daemon (remote). */
export interface BrainHostPeer {
  peer: RpcPeer;
  /** Brain ids available on this host. */
  brains: Map<string, string>; // id -> label
}

export interface BrainListing {
  ref: string;
  brainId: string;
  machineId: string;
  label: string;
  host: string; // "plugin:<id>" or "machine:<id>"
  probe?: ProbeResult & { checkedAt: string };
}

export class BrainRegistry {
  private pluginBrains = new Map<string, { label: string; pluginId: string; peer: RpcPeer; variants: string[] }>();
  private machineHosts = new Map<string, { name: string; peer: RpcPeer; brains: Map<string, string> }>();
  private probeCache = new Map<string, ProbeResult & { checkedAt: string }>();
  private eventRouters = new Map<RpcPeer, Map<string, (e: BrainEvent) => void>>();
  onChange?: () => void;

  // ---------- registration ----------

  registerPluginBrain(brainId: string, label: string, pluginId: string, peer: RpcPeer, variants: string[] = []): void {
    this.pluginBrains.set(brainId, { label, pluginId, peer, variants });
    this.attachRouter(peer);
    this.onChange?.();
  }

  unregisterPlugin(pluginId: string): void {
    for (const [id, b] of this.pluginBrains) if (b.pluginId === pluginId) this.pluginBrains.delete(id);
    this.onChange?.();
  }

  registerMachine(machineId: string, name: string, peer: RpcPeer, brains: Array<{ id: string; label: string }>): void {
    this.machineHosts.set(machineId, { name, peer, brains: new Map(brains.map((b) => [b.id, b.label])) });
    this.attachRouter(peer);
    this.onChange?.();
  }

  unregisterMachine(machineId: string): void {
    this.machineHosts.delete(machineId);
    for (const k of [...this.probeCache.keys()]) if (k.endsWith(`@${machineId}`)) this.probeCache.delete(k);
    this.onChange?.();
  }

  private attachRouter(peer: RpcPeer): void {
    if (this.eventRouters.has(peer)) return;
    const routes = new Map<string, (e: BrainEvent) => void>();
    this.eventRouters.set(peer, routes);
    peer.onNotification("brain.event", (p: { sessionId: string; event: BrainEvent }) => routes.get(p.sessionId)?.(p.event));
    peer.onClose(() => this.eventRouters.delete(peer));
  }

  // ---------- lookup ----------

  private resolve(ref: BrainRef): { peer: RpcPeer; label: string; host: string } | undefined {
    if (ref.machineId === "local") {
      const b = this.pluginBrains.get(ref.brainId);
      return b ? { peer: b.peer, label: b.label, host: `plugin:${b.pluginId}` } : undefined;
    }
    const m = this.machineHosts.get(ref.machineId);
    const label = m?.brains.get(ref.brainId);
    return m && label ? { peer: m.peer, label: `${label} @ ${m.name}`, host: `machine:${ref.machineId}` } : undefined;
  }

  has(refStr: string): boolean {
    return !!this.resolve(parseBrainRef(refStr));
  }

  list(variants: Record<string, string[]> = {}): BrainListing[] {
    const out: BrainListing[] = [];
    for (const [id, b] of this.pluginBrains) {
      const vs = variants[id]?.length ? variants[id] : b.variants.length ? b.variants : [undefined];
      for (const v of vs) {
        const ref = formatBrainRef({ brainId: id, variant: v, machineId: "local" });
        out.push({ ref, brainId: id, machineId: "local", label: v ? `${b.label} (${v})` : b.label, host: `plugin:${b.pluginId}`, probe: this.probeCache.get(ref) });
      }
    }
    for (const [mid, m] of this.machineHosts) {
      for (const [id, label] of m.brains) {
        const ref = formatBrainRef({ brainId: id, machineId: mid });
        out.push({ ref, brainId: id, machineId: mid, label: `${label} @ ${m.name}`, host: `machine:${mid}`, probe: this.probeCache.get(ref) });
      }
    }
    return out;
  }

  async probe(refStr: string, maxAgeMs = 60_000): Promise<ProbeResult> {
    const ref = parseBrainRef(refStr);
    const key = formatBrainRef(ref);
    const cached = this.probeCache.get(key);
    if (cached && Date.now() - Date.parse(cached.checkedAt) < maxAgeMs) return cached;
    const r = this.resolve(ref);
    if (!r) return { available: false, authenticated: false, detail: t("brain.notConnected") };
    let result: ProbeResult;
    try {
      result = await r.peer.request<ProbeResult>("brain.probe", { brainId: ref.brainId, variant: ref.variant }, { timeoutMs: 20_000 });
    } catch (e: any) {
      result = { available: false, authenticated: false, detail: e.message };
    }
    this.probeCache.set(key, { ...result, checkedAt: new Date().toISOString() });
    return result;
  }

  invalidate(refStr: string): void {
    this.probeCache.delete(formatBrainRef(parseBrainRef(refStr)));
  }

  async create(refStr: string, opts: BrainSessionOptions): Promise<BrainHandle> {
    const ref = parseBrainRef(refStr);
    const r = this.resolve(ref);
    if (!r) throw new LocalizedError("brain.refNotConnected", { ref: refStr });
    const peer = r.peer;
    await peer.request("brain.create", { brainId: ref.brainId, opts: { ...opts, variant: ref.variant ?? opts.variant } }, { timeoutMs: 60_000 });
    const routes = this.eventRouters.get(peer)!;
    const sessionId = opts.sessionId;
    return {
      ref: refStr,
      async send(turn, onEvent) {
        routes.set(sessionId, onEvent);
        try {
          await peer.request("brain.send", { sessionId, turn }, { timeoutMs: 6 * 3600_000 });
        } finally {
          routes.delete(sessionId);
        }
      },
      async interrupt() {
        await peer.request("brain.interrupt", { sessionId }, { timeoutMs: 10_000 }).catch(() => {});
      },
      async close() {
        await peer.request("brain.close", { sessionId }, { timeoutMs: 10_000 }).catch(() => {});
      },
    };
  }
}
