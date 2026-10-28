import { t } from "../i18n";

/** The small count of unread messages (or posts) on a row or a tab: an amber candy. */
export function UnreadBadge({ n }: { n: number }) {
  return (
    <span
      className="candy animate-pop flex h-[19px] min-w-[19px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10.5px] font-bold tabular-nums"
      title={t("team.unread", { n })}
      aria-label={t("team.unread", { n })}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}
