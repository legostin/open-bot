// In-process event bus. Web clients and plugin subscribers are attached by the server and plugin host.

import type { AgentDraft, BrainLoginState, DeviceNetwork, GroupChat, MachineActivity, RemoteView, TeamMember, UiEvent } from "@owlbot/shared";

export type BusEvents = {
  "message.created": any;
  "message.updated": any;
  "message.delta": { id: string; conversationId: string; delta: string };
  "conversation.updated": any;
  /** A turn started or ended in a conversation. */
  "conversation.activity": { conversationId: string; running: boolean };
  "team.updated": TeamMember;
  "group.updated": GroupChat;
  "task.updated": any;
  "notification.created": any;
  "notification.feedback": any;
  "approval.created": any;
  "approval.resolved": any;
  "vault.state": { state: string };
  /** Vault items written outside the console (a secret typed into the chat): ids only. */
  "vault.updated": { ids: string[] };
  "secret.request": any;
  /** A brain's sign-in from the chat changed (started, shows a code, finished). */
  "brain.login": BrainLoginState;
  "plugins.updated": Record<string, never>;
  "brains.updated": Record<string, never>;
  "agents.updated": Record<string, never>;
  /** A new agent's draft in the chat changed (or became the agent). */
  "agent_draft.updated": AgentDraft;
  "settings.updated": Record<string, unknown>;
  /** A connected account (Google) came, went or broke. */
  "connections.updated": { provider: string };
  "machine.updated": any;
  /** What every machine is doing now (activity.ts). */
  "machines.activity": MachineActivity[];
  /** A phone paired, was renamed or revoked: listeners re-read the list. */
  "device.updated": { id: string };
  "devices.network": DeviceNetwork;
  /** Access from anywhere changed state (remote.ts). */
  "remote.updated": RemoteView;
  "plugin.event": { pluginId: string; channel: string; payload: unknown };
};

export type BusEventName = keyof BusEvents;

export class EventBus {
  private handlers = new Map<string, Set<(p: any) => void>>();
  private anyHandlers = new Set<(name: string, p: any) => void>();

  on<K extends BusEventName>(name: K, cb: (payload: BusEvents[K]) => void): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(cb);
    this.handlers.set(name, set);
    return () => set.delete(cb);
  }

  onAny(cb: (name: string, payload: any) => void): () => void {
    this.anyHandlers.add(cb);
    return () => this.anyHandlers.delete(cb);
  }

  emit<K extends BusEventName>(name: K, payload: BusEvents[K]): void {
    for (const cb of this.handlers.get(name) ?? []) {
      try {
        cb(payload);
      } catch (e) {
        console.error(`[bus] handler for ${name} failed`, e);
      }
    }
    for (const cb of this.anyHandlers) {
      try {
        cb(name, payload);
      } catch (e) {
        console.error(`[bus] any-handler failed`, e);
      }
    }
  }
}

/** Map bus events to UI websocket events. */
export function toUiEvent(name: string, payload: any): UiEvent | null {
  switch (name) {
    case "message.created":
    case "message.updated":
    case "message.delta":
    case "conversation.updated":
    case "team.updated":
    case "group.updated":
    case "task.updated":
    case "notification.created":
    case "plugins.updated":
    case "brains.updated":
    case "agents.updated":
    case "settings.updated":
    case "connections.updated":
    case "machine.updated":
    case "machines.activity":
    case "device.updated":
    case "devices.network":
    case "remote.updated":
    case "plugin.event":
    case "secret.request":
    case "agent_draft.updated":
    case "brain.login":
      return { type: name, data: payload } as UiEvent;
    case "vault.state":
      return { type: "vault.state", data: payload } as UiEvent;
    default:
      return null;
  }
}
