// Header badges: realtime connection, vault state, pending approvals (both link to the security console).

import { LockKeyhole, LockKeyholeOpen, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useStore } from "../lib/store";
import { connection, session } from "../state/app";
import { cx } from "./ui";

export function ConnectionBadge() {
  const c = useStore(connection);
  const map = {
    open: { label: "на связи", dot: "bg-success", text: "text-muted" },
    connecting: { label: "подключение…", dot: "bg-warning animate-pulse", text: "text-warning" },
    reconnecting: { label: "переподключение…", dot: "bg-warning animate-pulse", text: "text-warning" },
    offline: { label: "нет связи", dot: "bg-danger", text: "text-danger" },
  }[c];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs", map.text)} title={`Связь с хабом: ${map.label}`} role="status">
      <span className={cx("size-2 rounded-full", map.dot)} />
      <span className={cx(c === "open" ? "hidden xl:inline" : "hidden sm:inline")}>{map.label}</span>
    </span>
  );
}

export function VaultBadge() {
  const s = useStore(session);
  if (!s) return null;
  const v = {
    uninitialized: { label: "vault не создан", icon: ShieldQuestion, cls: "bg-warning-soft text-warning" },
    sealed: { label: "vault заперт", icon: LockKeyhole, cls: "bg-warning-soft text-warning" },
    unlocked: { label: "vault открыт", icon: LockKeyholeOpen, cls: "bg-success-soft text-success" },
  }[s.vaultState] ?? { label: `vault: ${s.vaultState}`, icon: ShieldQuestion, cls: "bg-surface-2 text-muted" };
  return (
    <a
      href={`${s.consoleUrl}/#/vault`}
      target="_blank"
      rel="noopener noreferrer"
      title={`Vault: ${v.label}. Открыть пульт безопасности`}
      className={cx("inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-xs font-medium transition hover:brightness-95", v.cls)}
    >
      <v.icon className="size-3.5" />
      <span className={cx(s.vaultState === "unlocked" ? "hidden xl:inline" : "hidden sm:inline")}>{v.label}</span>
    </a>
  );
}

export function ApprovalsBadge() {
  const s = useStore(session);
  if (!s || !s.pendingApprovals) return null;
  return (
    <a
      href={`${s.consoleUrl}/#/approvals`}
      target="_blank"
      rel="noopener noreferrer"
      title="Ожидают подтверждения — открыть пульт"
      className="inline-flex h-7 items-center gap-1.5 rounded-full bg-warning px-2.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 dark:text-black"
    >
      <ShieldAlert className="size-3.5" />
      {s.pendingApprovals}
      <span className="hidden sm:inline">ждут</span>
    </a>
  );
}
