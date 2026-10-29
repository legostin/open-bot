// What the hub may ask of this machine: brain.*, exec.run, fs.*. Every request is checked against the
// local policy and logged as one line (never with file contents).

import type { ChildProcess } from "node:child_process";
import type { RpcPeer } from "@owlbot/shared";
import type { PolicyStore } from "./policy.ts";
import type { BrainHost } from "./brains.ts";
import type { GuardOptions } from "./guard.ts";
import type { Logger } from "./info.ts";
import { execRun, killTree } from "./exec.ts";
import { fsList, fsRead, fsWrite } from "./fsops.ts";

const short = (s: unknown, max = 160): string => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/** One-line description of a request for the log: never file contents or prompts. */
function describe(method: string, p: any): string {
  switch (method) {
    case "exec.run":
      return `${short(p?.command)}${p?.cwd ? ` (in ${short(p.cwd, 120)})` : ""}`;
    case "fs.read":
    case "fs.list":
      return short(p?.path ?? ".", 200);
    case "fs.write":
      return `${short(p?.path, 200)} (${typeof p?.content === "string" ? Buffer.byteLength(p.content) : 0} B)`;
    case "brain.probe":
      return String(p?.brainId ?? "");
    case "brain.create":
      return `${p?.brainId} session=${p?.opts?.sessionId} workspace=${short(p?.opts?.workspace, 80)}`;
    case "brain.send":
    case "brain.steer":
      return `session=${p?.sessionId} (${typeof p?.turn?.text === "string" ? p.turn.text.length : 0} chars)`;
    case "brain.warm":
    case "brain.interrupt":
    case "brain.close":
      return `session=${p?.sessionId}`;
    default:
      return "";
  }
}

function outcome(method: string, r: any): string {
  if (method === "exec.run") return `exit ${r?.code}`;
  if (method === "fs.read") return `${Buffer.byteLength(String(r?.content ?? ""))} B`;
  if (method === "fs.write") return `${r?.bytes} B`;
  if (method === "fs.list") return `${r?.entries?.length ?? 0} entries`;
  if (method === "brain.probe") return r?.available ? `available${r.authenticated ? "" : ", not signed in"}` : "unavailable";
  if (method === "brain.steer") return r?.accepted ? "joined the turn" : "no turn to join";
  return "ok";
}

export class NodeService {
  readonly policy: PolicyStore;
  readonly brains: BrainHost;
  readonly guard: GuardOptions;
  private log: Logger;
  private children = new Set<ChildProcess>();

  constructor(o: { policy: PolicyStore; brains: BrainHost; log: Logger; guard?: GuardOptions }) {
    this.policy = o.policy;
    this.brains = o.brains;
    this.log = o.log;
    this.guard = o.guard ?? {};
  }

  private wrap<P, R>(method: string, fn: (p: P) => Promise<R> | R): (p: P) => Promise<R> {
    return async (p: P) => {
      const started = Date.now();
      const what = describe(method, p);
      try {
        const r = await fn(p);
        this.log(`${method} ${what} → ${outcome(method, r)} (${Date.now() - started} ms)`);
        return r;
      } catch (e: any) {
        this.log(`${method} ${what} → denied: ${e?.message ?? e}`);
        throw e;
      }
    };
  }

  /** Register all request handlers on a freshly authenticated hub connection. */
  attach(peer: RpcPeer): void {
    const policy = () => this.policy.get();
    peer.handle("exec.run", this.wrap("exec.run", (p: any) => execRun(p ?? {}, policy(), this.guard, this.children)));
    peer.handle("fs.read", this.wrap("fs.read", (p: any) => fsRead(p ?? {}, policy(), this.guard)));
    peer.handle("fs.write", this.wrap("fs.write", (p: any) => fsWrite(p ?? {}, policy(), this.guard)));
    peer.handle("fs.list", this.wrap("fs.list", (p: any) => fsList(p ?? {}, policy(), this.guard)));
    peer.handle("brain.probe", this.wrap("brain.probe", (p: any) => this.brains.probe(p ?? {})));
    peer.handle(
      "brain.create",
      this.wrap("brain.create", async (p: any) => {
        await this.brains.create(p ?? {});
        return {};
      }),
    );
    peer.handle(
      "brain.send",
      this.wrap("brain.send", async (p: any) => {
        await this.brains.send(p ?? {}, (event) => peer.notify("brain.event", { sessionId: p.sessionId, event }));
        return {};
      }),
    );
    peer.handle(
      "brain.steer",
      this.wrap("brain.steer", async (p: any) => ({ accepted: await this.brains.steer(p ?? {}) })),
    );
    peer.handle(
      "brain.warm",
      this.wrap("brain.warm", async (p: any) => {
        await this.brains.warm(p ?? {});
        return {};
      }),
    );
    peer.handle(
      "brain.interrupt",
      this.wrap("brain.interrupt", async (p: any) => {
        await this.brains.interrupt(p ?? {});
        return {};
      }),
    );
    peer.handle(
      "brain.close",
      this.wrap("brain.close", async (p: any) => {
        await this.brains.close(p ?? {});
        return {};
      }),
    );
  }

  /** Connection lost or shutting down: nobody will read the results, so stop everything. */
  async abortAll(): Promise<void> {
    for (const c of this.children) killTree(c);
    this.children.clear();
    await this.brains.closeAll();
  }
}
