import { ShieldCheck } from "lucide-react";
import { cx } from "./kit.tsx";

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-accent-600 to-accent-800 text-white shadow-sm ring-1 ring-accent-900/20",
        size === "lg" ? "size-12 rounded-xl" : "size-8",
      )}
      aria-hidden
    >
      <ShieldCheck className={size === "lg" ? "size-6" : "size-[18px]"} strokeWidth={2.2} />
    </span>
  );
}

/** Thin accent strip on top of every screen: a constant visual cue that this is the security console. */
export function AccentStrip() {
  return <div className="fixed inset-x-0 top-0 z-50 h-[3px] bg-gradient-to-r from-accent-700 via-accent-500 to-accent-700" aria-hidden />;
}
