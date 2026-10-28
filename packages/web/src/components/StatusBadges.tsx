// Header badges, shown only while they need the person: the realtime connection when it is not there, the vault when
// it is not open, approvals waiting (both link to the security console). All quiet when all is well.

import { LockKeyhole, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useStore } from "../lib/store";
import { connection, session } from "../state/app";
import { t } from "../i18n";
import { cx } from "./ui";

export function ConnectionBadge() {
  const c = useStore(connection);
  if (c === "open") return null;
  const map = {
    connecting: { label: t("status.connection.connecting"), dot: "bg-warning animate-pulse", text: "text-warning" },
    reconnecting: { label: t("status.connection.reconnecting"), dot: "bg-warning animate-pulse", text: "text-warning" },
    offline: { label: t("status.connection.offline"), dot: "bg-danger", text: "text-danger" },
  }[c];
  return (
    <span className={cx("animate-in inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium", map.text)} title={t("status.connection.title", { state: map.label })} role="status">
      <span className={cx("size-1.5 rounded-full", map.dot)} />
      <span className="hidden @xl/top:inline">{map.label}</span>
    </span>
  );
}

export function VaultBadge() {
  const s = useStore(session);
  if (!s || s.vaultState === "unlocked") return null;
  const v = {
    uninitialized: { label: t("status.vault.uninitialized"), icon: ShieldQuestion },
    sealed: { label: t("status.vault.sealed"), icon: LockKeyhole },
  }[s.vaultState as "uninitialized" | "sealed"] ?? { label: t("status.vault.other", { state: s.vaultState }), icon: ShieldQuestion };
  return (
    <a
      href={`${s.consoleUrl}/#/vault`}
      target="_blank"
      rel="noopener noreferrer"
      title={t("status.vault.title", { state: v.label })}
      className="press inline-flex h-7 items-center gap-1.5 rounded-full bg-warning-soft px-2.5 text-xs font-medium text-warning hover:brightness-95"
    >
      <v.icon className="size-3.5" />
      <span className="hidden @xl/top:inline">{v.label}</span>
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
      className="candy press animate-pop inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold"
    >
      <ShieldAlert className="size-3.5" />
      {s.pendingApprovals}
      <span className="hidden @xl/top:inline">{t("status.approvals.waiting")}</span>
    </a>
  );
}
