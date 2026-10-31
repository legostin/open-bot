// A service's own logo (the PNG its plugin ships, served by the hub) on a white tile, in place of a card's icon. When
// there is none, or it does not load, `fallback` (the tinted icon) is drawn instead.

import { useState, type ReactNode } from "react";
import { cx } from "./ui";

export function ServiceLogo({ logo, size = "md", fallback }: { logo?: string; size?: "md" | "lg"; fallback: ReactNode }) {
  const [failed, setFailed] = useState<string>();
  if (!logo || failed === logo) return <>{fallback}</>;
  return (
    <span
      className={cx("flex shrink-0 items-center justify-center bg-white ring-1 ring-black/5", size === "lg" ? "size-14 rounded-2xl" : "size-10 rounded-xl")}
      aria-hidden
    >
      <img src={logo} alt="" draggable={false} onError={() => setFailed(logo)} className={cx("object-contain", size === "lg" ? "size-9" : "size-6")} />
    </span>
  );
}
