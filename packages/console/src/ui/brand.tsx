import { ShieldCheck } from "lucide-react";
import { cx } from "./kit.tsx";

/** The 0_0 mark with a shield: Owlbot's security console. */
export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={cx("relative inline-flex shrink-0", size === "lg" ? "size-12" : "size-8")} aria-hidden>
      <img src="/favicon.svg" alt="" className="size-full" />
      <span className={cx("absolute -right-1 -bottom-1 inline-flex items-center justify-center rounded-full bg-white text-black ring-2 ring-black", size === "lg" ? "size-5" : "size-4")}>
        <ShieldCheck className={size === "lg" ? "size-3.5" : "size-3"} strokeWidth={2.4} />
      </span>
    </span>
  );
}

/** Thin strip on top of every screen: a constant visual cue that this is the security console. */
export function AccentStrip() {
  return <div className="fixed inset-x-0 top-0 z-50 h-[3px] bg-gradient-to-r from-accent-700 via-accent-500 to-accent-700" aria-hidden />;
}
