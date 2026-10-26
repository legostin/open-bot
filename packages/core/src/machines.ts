// Machine mesh, hub side: pairing codes, Ed25519 challenge auth over WebSocket, remote brains and machine_* tools.

import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Machine, MachineInfo, ToolResult } from "@openbot/shared";
import { createRpcPeer, newId, nowIso, wsTransport, type RpcPeer, type WsLike } from "@openbot/shared";
import { json, type Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { BrainRegistry } from "./brains.ts";
import type { AuditLog } from "./audit.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import { hubLocale, LocalizedError } from "./i18n.ts";

export const NODE_AUTH_PREFIX = "openbot-node-auth:";
const PAIRING_TTL = 10 * 60_000;

const fromRow = (r: any, online: boolean): Machine => ({
  id: r.id,
  name: r.name,
  publicKey: r.public_key,
  status: online ? "online" : "offline",
  info: json<MachineInfo | undefined>(r.info, undefined),
  lastSeenAt: r.last_seen_at ?? undefined,
  createdAt: r.created_at,
});

export class MachineHub {
  db: Db;
  bus: EventBus;
  brains: BrainRegistry;
  audit: AuditLog;
  private peers = new Map<string, RpcPeer>();

  constructor(d: { db: Db; bus: EventBus; brains: BrainRegistry; audit: AuditLog }) {
    this.db = d.db;
    this.bus = d.bus;
    this.brains = d.brains;
    this.audit = d.audit;
  }

  createPairingCode(name?: string): { code: string; expiresAt: string } {
    const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toUpperCase();
    const expiresAt = new Date(Date.now() + PAIRING_TTL).toISOString();
    this.db.prepare("insert into pairing_codes(code, name, expires_at) values (?,?,?)").run(code, name ?? null, expiresAt);
    this.audit.append("user", "machine.pairing-code", undefined, { name });
    return { code, expiresAt };
  }

  /** Called by a node daemon with a one-time code. Registers its public key. */
  pair(p: { code: string; publicKey: string; name?: string; info?: MachineInfo }): Machine {
    const row = this.db.prepare("select * from pairing_codes where code = ?").get(String(p.code).trim().toUpperCase()) as any;
    if (!row || row.used || Date.parse(row.expires_at) < Date.now()) throw new LocalizedError("machine.badPairingCode");
    const pub = Buffer.from(p.publicKey, "base64url");
    if (pub.length !== 32) throw new LocalizedError("machine.badPublicKey");
    this.db.prepare("update pairing_codes set used = 1 where code = ?").run(row.code);
    const id = newId("mach_");
    const name = (row.name || p.name || p.info?.hostname || "machine").slice(0, 60);
    this.db
      .prepare("insert into machines(id, name, public_key, info, last_seen_at, created_at) values (?,?,?,?,?,?)")
      .run(id, name, p.publicKey, p.info ? JSON.stringify(p.info) : null, nowIso(), nowIso());
    this.audit.append("user", "machine.pair", id, { name });
    const m = this.get(id)!;
    this.bus.emit("machine.updated", m);
    return m;
  }

  list(): Machine[] {
    return (this.db.prepare("select * from machines where revoked = 0 order by created_at").all() as any[]).map((r) => fromRow(r, this.peers.has(r.id)));
  }

  get(id: string): Machine | undefined {
    const r = this.db.prepare("select * from machines where id = ? and revoked = 0").get(id);
    return r ? fromRow(r, this.peers.has(id)) : undefined;
  }

  /** Accepts a machine id or a (case-insensitive) name. */
  find(idOrName: string): Machine | undefined {
    return this.get(idOrName) ?? this.list().find((m) => m.name.toLowerCase() === idOrName.toLowerCase());
  }

  name(id: string): string | undefined {
    return this.get(id)?.name;
  }

  rename(id: string, name: string): Machine | undefined {
    this.db.prepare("update machines set name = ? where id = ?").run(name.slice(0, 60), id);
    const m = this.get(id);
    if (m) this.bus.emit("machine.updated", m);
    return m;
  }

  revoke(id: string): void {
    this.db.prepare("update machines set revoked = 1 where id = ?").run(id);
    this.peers.get(id)?.close();
    this.audit.append("user", "machine.revoke", id);
    this.bus.emit("machine.updated", { id, status: "offline", revoked: true });
  }

  /** Handle a node's WebSocket: challenge → signature → RPC. */
  attach(ws: WsLike & { once?: (ev: string, cb: (d: unknown) => void) => void }, remoteIp: string): void {
    const nonce = randomBytes(32).toString("base64url");
    let authed = false;
    const timer = setTimeout(() => {
      if (!authed) ws.close(4401, "auth timeout");
    }, 15_000);
    ws.send(JSON.stringify({ type: "challenge", nonce }));
    const onFirst = (data: unknown) => {
      if (authed) return;
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        ws.close(4400, "bad message");
        return;
      }
      const row = this.db.prepare("select * from machines where id = ? and revoked = 0").get(String(msg.machineId ?? "")) as any;
      let ok = false;
      try {
        ok = !!row && ed25519.verify(Buffer.from(String(msg.signature), "base64url"), new TextEncoder().encode(NODE_AUTH_PREFIX + nonce), Buffer.from(row.public_key, "base64url"));
      } catch {
        ok = false;
      }
      if (!ok) {
        this.audit.append("core", "machine.auth-failure", msg.machineId, { ip: remoteIp });
        ws.close(4401, "unauthorized");
        return;
      }
      authed = true;
      clearTimeout(timer);
      this.online(row.id, ws);
    };
    ws.on("message", onFirst);
  }

  private online(id: string, ws: WsLike): void {
    this.peers.get(id)?.close();
    // The auth message handler stays attached but ignores frames after auth; RPC gets its own listener.
    const peer = createRpcPeer(wsTransport(ws));
    this.peers.set(id, peer);
    ws.send(JSON.stringify({ type: "ok", machineId: id }));
    this.db.prepare("update machines set last_seen_at = ? where id = ?").run(nowIso(), id);
    this.audit.append(`machine:${id}`, "machine.online", id);

    peer.handle("node.hello", (p: { info: MachineInfo; brains: Array<{ id: string; label: string }> }) => {
      this.db.prepare("update machines set info = ?, last_seen_at = ? where id = ?").run(JSON.stringify(p.info ?? null), nowIso(), id);
      const m = this.get(id)!;
      this.brains.registerMachine(id, m.name, peer, p.brains ?? []);
      this.bus.emit("machine.updated", m);
      this.bus.emit("brains.updated", {});
      return { machineId: id, name: m.name, language: hubLocale() };
    });
    peer.handle("node.ping", () => {
      this.db.prepare("update machines set last_seen_at = ? where id = ?").run(nowIso(), id);
      return { ts: nowIso() };
    });
    peer.onClose(() => {
      if (this.peers.get(id) === peer) {
        this.peers.delete(id);
        this.brains.unregisterMachine(id);
        this.db.prepare("update machines set last_seen_at = ? where id = ?").run(nowIso(), id);
        const m = this.get(id);
        if (m) this.bus.emit("machine.updated", m);
        this.bus.emit("brains.updated", {});
        this.audit.append(`machine:${id}`, "machine.offline", id);
      }
    });
    this.bus.emit("machine.updated", this.get(id)!);
  }

  async call<T>(machine: string, method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    const m = this.find(machine);
    if (!m) throw new Error(`Machine ${machine} not found`);
    const peer = this.peers.get(m.id);
    if (!peer) throw new Error(`Machine ${m.name} is offline`);
    return peer.request<T>(method, params, { timeoutMs });
  }

  /** Connected machines use the hub language for texts the hub shows (brain status details). */
  broadcastLocale(language: string): void {
    for (const p of this.peers.values()) if (!p.closed) p.notify("node.locale", { language });
  }

  closeAll(): void {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
  }

  registerTools(registry: ToolRegistry): void {
    const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
    const wrap = (fn: (i: any) => Promise<ToolResult>) => async (i: any) => {
      try {
        return await fn(i ?? {});
      } catch (e: any) {
        return text(e?.message ?? String(e), true);
      }
    };
    const machineProp = { type: "string", description: "Machine id or name (see machine_list)" };

    registry.register(
      { name: "machine_list", owner: "core", effect: "read", description: "List the user's connected computers: status, OS, brains (subscriptions) and allowed directories.", inputSchema: { type: "object", properties: {} } },
      wrap(async () => {
        const ms = this.list();
        if (!ms.length) return text("No machines are paired. The user can connect a computer on the Machines page.");
        return text(
          ms
            .map((m) => `- ${m.name} (${m.id}) — ${m.status}${m.info ? `, ${m.info.os}/${m.info.arch}, brains: ${m.info.clis.filter((c) => c.available).map((c) => c.brainId).join(", ") || "none"}, folders: ${m.info.allowedDirs.join(", ") || "—"}` : ""}`)
            .join("\n"),
        );
      }),
    );
    registry.register(
      {
        name: "machine_exec",
        owner: "core",
        effect: "external",
        approvalSummary: "%machines.execApproval%",
        description: "Run a shell command on one of the user's computers (inside its allowed directories). Returns exit code, stdout and stderr.",
        inputSchema: {
          type: "object",
          properties: { machine: machineProp, command: { type: "string" }, cwd: { type: "string", description: "Working directory (must be inside an allowed dir)" }, timeoutSec: { type: "number" } },
          required: ["machine", "command"],
        },
      },
      wrap(async (i) => {
        const r = await this.call<{ code: number; stdout: string; stderr: string }>(i.machine, "exec.run", { command: i.command, cwd: i.cwd, timeoutMs: Math.min(Number(i.timeoutSec ?? 120), 1800) * 1000 }, 1900_000);
        return text(`exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`, r.code !== 0);
      }),
    );
    registry.register(
      {
        name: "machine_read_file",
        owner: "core",
        effect: "read",
        description: "Read a text file on one of the user's computers (inside allowed directories).",
        inputSchema: { type: "object", properties: { machine: machineProp, path: { type: "string" } }, required: ["machine", "path"] },
      },
      wrap(async (i) => text((await this.call<{ content: string }>(i.machine, "fs.read", { path: i.path })).content)),
    );
    registry.register(
      {
        name: "machine_list_dir",
        owner: "core",
        effect: "read",
        description: "List a directory on one of the user's computers (inside allowed directories).",
        inputSchema: { type: "object", properties: { machine: machineProp, path: { type: "string" } }, required: ["machine", "path"] },
      },
      wrap(async (i) => {
        const r = await this.call<{ entries: Array<{ name: string; type: string; size?: number }> }>(i.machine, "fs.list", { path: i.path });
        return text(r.entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.size !== undefined ? ` (${e.size} B)` : ""}`).join("\n") || "(empty)");
      }),
    );
    registry.register(
      {
        name: "machine_write_file",
        owner: "core",
        effect: "external",
        approvalSummary: "%machines.writeApproval%",
        description: "Write a text file on one of the user's computers (inside allowed directories).",
        inputSchema: { type: "object", properties: { machine: machineProp, path: { type: "string" }, content: { type: "string" } }, required: ["machine", "path", "content"] },
      },
      wrap(async (i) => {
        const r = await this.call<{ bytes: number }>(i.machine, "fs.write", { path: i.path, content: i.content });
        return text(`Wrote ${r.bytes} bytes to ${i.path}`);
      }),
    );
  }
}
