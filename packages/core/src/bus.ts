// In-process event bus. Web clients and plugin subscribers are attached by the server and plugin host.

import type { UiEvent } from "@openbot/shared";

export type BusEvents = {
  "message.created": any;
  "message.updated": any;
  "message.delta": { id: string; conversationId: string; delta: string };
  "conversation.updated": any;
  "task.updated": any;
  "notification.created": any;
  "notification.feedback": any;
  "approval.created": any;
  "approval.resolved": any;
  "vault.state": { state: string };
  "plugins.updated": Record<string, never>;
  "brains.updated": Record<string, never>;
  "machine.updated": any;
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
    case "task.updated":
    case "notification.created":
    case "plugins.updated":
    case "brains.updated":
    case "machine.updated":
    case "plugin.event":
      return { type: name, data: payload } as UiEvent;
    case "vault.state":
      return { type: "vault.state", data: payload } as UiEvent;
    default:
      return null;
  }
}
