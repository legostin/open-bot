// Composition root for `openbot-node run` (also used by tests).

import { loadConfig, loadKey, type NodeConfig } from "./home.ts";
import { PolicyStore } from "./policy.ts";
import { BrainHost } from "./brains.ts";
import { NodeService } from "./service.ts";
import { NodeClient } from "./client.ts";
import type { Logger } from "./info.ts";

export interface NodeDaemonOptions {
  home: string;
  log: Logger;
  /** For tests: base for default policy paths (default: os.homedir()). */
  userHome?: string;
  bridgeCommand?: string[];
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onFatal?: (message: string) => void;
}

export interface NodeDaemon {
  config: NodeConfig;
  policy: PolicyStore;
  brains: BrainHost;
  service: NodeService;
  client: NodeClient;
  stop(): Promise<void>;
}

export function createNodeDaemon(o: NodeDaemonOptions): NodeDaemon {
  const config = loadConfig(o.home);
  const key = loadKey(o.home);
  const policy = new PolicyStore(o.home, { userHome: o.userHome, log: o.log });
  const brains = new BrainHost({ home: o.home, policy, hubUrl: config.hubUrl, bridgeCommand: o.bridgeCommand, log: o.log });
  // The daemon's own home (key, policy) is never reachable through fs.*/exec, even if an allowed dir contains it.
  const service = new NodeService({ policy, brains, log: o.log, guard: { deny: [o.home] } });
  const client = new NodeClient({
    hubUrl: config.hubUrl,
    machineId: config.machineId,
    secretKey: key.secretKey,
    service,
    log: o.log,
    pingIntervalMs: o.pingIntervalMs,
    minBackoffMs: o.minBackoffMs,
    maxBackoffMs: o.maxBackoffMs,
    onFatal: o.onFatal,
  });
  return { config, policy, brains, service, client, stop: () => client.stop() };
}
