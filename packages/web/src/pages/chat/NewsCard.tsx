// News an agent shows in its reply (a `news` part, show_news): a compact list of cards (title and link, a couple of
// lines, the source, a small picture), and the channel they come from, when they do.

import { Link } from "wouter";
import { ChevronRight, Newspaper } from "lucide-react";
import type { MessagePart } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { feedPath } from "../../lib/feeds";
import { mediaSrc } from "../../lib/media";
import { shortTime } from "../../lib/format";
import { feeds } from "../../state/feeds";
import { t } from "../../i18n";

type NewsPart = Extract<MessagePart, { type: "news" }>;

export function NewsCard({ part }: { part: NewsPart }) {
  const list = useStore(feeds);
  const channel = part.feedId ? list?.find((f) => f.id === part.feedId) : undefined;
  const heading = part.title ?? channel?.title;
  return (
    <figure className="my-2 max-w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-card sm:max-w-xl" aria-label={heading ?? t("news.label")}>
      {(heading || part.feedId) && (
        <figcaption className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <Newspaper className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate font-medium">{heading ?? t("news.label")}</span>
          {part.feedId && (
            <Link href={feedPath(part.feedId)} className="inline-flex shrink-0 items-center gap-0.5 rounded-lg px-1.5 py-0.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-fg">
              {t("news.openChannel")}
              <ChevronRight className="size-3.5" />
            </Link>
          )}
        </figcaption>
      )}
      <ul className="divide-y divide-border">
        {part.items.map((item, i) => {
          const img = item.image ? mediaSrc(item.image) : undefined;
          const meta = [item.source, item.at ? shortTime(item.at) : ""].filter(Boolean).join(" · ");
          return (
            <li key={i} className="flex gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] leading-snug font-semibold">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {item.title}
                    </a>
                  ) : (
                    item.title
                  )}
                </div>
                {item.text && <p className="mt-0.5 line-clamp-2 text-[13px] text-fg/80">{item.text.replace(/[*_`#>]/g, "")}</p>}
                {meta && <div className="mt-0.5 text-[11px] text-muted">{meta}</div>}
              </div>
              {img && <img src={img} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg border border-border object-cover" />}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
