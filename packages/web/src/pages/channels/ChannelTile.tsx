// A channel's picture: a candy tile with a newspaper, in a colour of the agents' palette picked from the channel's id
// (the phone app picks the same: ChannelTile in ChannelViews.swift). Gathering, it glows; paused, it goes grey.

import type { CSSProperties } from "react";
import { Newspaper } from "lucide-react";
import { AVATAR_PALETTE, defaultAvatar } from "@owlbot/shared/avatar";
import { cx } from "../../components/ui";

export function ChannelTile({ feedId, size = 36, running, paused, className }: { feedId: string; size?: number; running?: boolean; paused?: boolean; className?: string }) {
  const p = AVATAR_PALETTE[defaultAvatar(feedId).color];
  const style: CSSProperties & Record<"--glow", string> = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.3),
    background: `radial-gradient(120% 90% at 30% 10%, rgb(255 255 255 / 0.32), transparent 55%), linear-gradient(180deg, ${p.top}, ${p.bottom})`,
    "--glow": `${p.bottom}aa`,
  };
  return (
    <span
      className={cx(
        "flex shrink-0 items-center justify-center text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(0_0_0/0.12)] transition-[filter,opacity]",
        running && "owl-alive",
        paused && "opacity-55 grayscale",
        className,
      )}
      style={style}
      aria-hidden
    >
      <Newspaper style={{ width: size * 0.48, height: size * 0.48 }} strokeWidth={2} />
    </span>
  );
}
