import { t } from "../i18n";

/** The small count of unread messages (or posts) on a row or a tab. */
export function UnreadBadge({ n }: { n: number }) {
  return (
    <span
      className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg"
      title={t("team.unread", { n })}
      aria-label={t("team.unread", { n })}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}
