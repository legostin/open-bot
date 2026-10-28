// Header badges: realtime connection, vault state, pending approvals (both link to the security console).

import { LockKeyhole, LockKeyholeOpen, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useStore } from "../lib/store";
import { connection, session } from "../state/app";
import { t } from "../i18n";
import { cx } from "./ui";

export function ConnectionBadge() {
  const c = useStore(connection);
  const map = {
    open: { label: t("status.connection.open"), dot: "bg-success", text: "text-muted" },
    connecting: { label: t("status.connection.connecting"), dot: "bg-warning animate-pulse", text: "text-warning" },
    reconnecting: { label: t("status.connection.reconnecting"), dot: "bg-warning animate-pulse", text: "text-warning" },
    offline: { label: t("status.connection.offline"), dot: "bg-danger", text: "text-danger" },
  }[c];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs", map.text)} title={t("status.connection.title", { state: map.label })} role="status">
      <span className={cx("size-2 rounded-full", map.dot)} />
      <span className={cx(c === "open" ? "hidden @3xl/top:inline" : "hidden @xl/top:inline")}>{map.label}</span>
    </span>
  );
}

export function VaultBadge() {
  const s = useStore(session);
  if (!s) return null;
  const v = {
    uninitialized: { label: t("status.vault.uninitialized"), icon: ShieldQuestion, cls: "bg-warning-soft text-warning" },
    sealed: { label: t("status.vault.sealed"), icon: LockKeyhole, cls: "bg-warning-soft text-warning" },
    unlocked: { label: t("status.vault.unlocked"), icon: LockKeyholeOpen, cls: "bg-success-soft text-success" },
  }[s.vaultState] ?? { label: t("status.vault.other", { state: s.vaultState }), icon: ShieldQuestion, cls: "bg-surface-2 text-muted" };
  return (
    <a
      href={`${s.consoleUrl}/#/vault`}
      target="_blank"
      rel="noopener noreferrer"
      title={t("status.vault.title", { state: v.label })}
      className={cx("inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-xs font-medium transition hover:brightness-95", v.cls)}
    >
      <v.icon className="size-3.5" />
      <span className={cx(s.vaultState === "unlocked" ? "hidden @3xl/top:inline" : "hidden @xl/top:inline")}>{v.label}</span>
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
      title={t("status.approvals.title")}
      className="inline-flex h-7 items-center gap-1.5 rounded-full bg-warning px-2.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 dark:text-black"
    >
      <ShieldAlert className="size-3.5" />
      {s.pendingApprovals}
      <span className="hidden @xl/top:inline">{t("status.approvals.waiting")}</span>
    </a>
  );
}
