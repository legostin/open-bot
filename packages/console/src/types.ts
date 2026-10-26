// API shapes of the security console (packages/core/src/server/console-app.ts).
// Domain types come straight from the shared contract (type-only import, erased at build time).

import type { Approval, Rule, ToolEffect, VaultItemMeta, VaultItemType, VaultScope, VaultState } from "../../shared/src/types.ts";

export type {
  Approval,
  ApprovalStatus,
  AuditEntry,
  Rule,
  RuleCondition,
  ToolEffect,
  ToolResult,
  VaultItem,
  VaultItemMeta,
  VaultItemType,
  VaultScope,
  VaultState,
} from "../../shared/src/types.ts";

export interface AuthState {
  hasPassword: boolean;
  authenticated: boolean;
  csrf?: string;
  passkeys: number;
  publicUrl: string;
}

export type RuleDraft = Omit<Rule, "id" | "createdAt" | "createdVia">;

export interface ApprovalView extends Approval {
  agentName?: string;
  toolDescription?: string;
  suggestedRule?: RuleDraft;
}

export interface VaultView {
  state: VaultState;
  items: VaultItemMeta[];
  autoUnlock: boolean;
}

export interface ToolInfo {
  name: string;
  effect: ToolEffect;
  owner: string;
  description: string;
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
}

export interface PluginPermissions {
  network: string[];
  vault: string[];
  core: string[];
  ui: string[];
  fs: string[];
}

export interface PluginInfo {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  permissions: Partial<PluginPermissions>;
  /** Vault items granted in the console on top of the manifest (absent on older hubs). */
  extraVault?: string[];
  hasUi: boolean;
}

export interface AuditVerify {
  ok: boolean;
  count: number;
  brokenAt?: number;
}

export interface VaultUpsert {
  id?: string;
  type: VaultItemType;
  name: string;
  fields: Record<string, string>;
  scope?: Partial<VaultScope>;
}

export type ConsoleEvent =
  | { type: "approval.created"; data: Approval }
  | { type: "approval.resolved"; data: Approval }
  | { type: "vault.state"; data: { state: VaultState } };
