// The download button: macOS by default (what the page is prerendered with), Windows once the browser says so.

import { useEffect, useState } from "react";
import { data } from "../data";
import { useI18n } from "../i18n";
import { Apple, Windows } from "./icons";

export type Os = "mac" | "win";

export function useOs(): Os {
  const [os, setOs] = useState<Os>("mac");
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = `${nav.userAgentData?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`;
    if (/win/i.test(p)) setOs("win");
  }, []);
  return os;
}

export function downloadHref(os: Os): string {
  return (os === "mac" ? data.release.mac : data.release.win) ?? data.release.page;
}

export function DownloadButton({ size = "lg" }: { size?: "sm" | "lg" }) {
  const { t } = useI18n();
  const os = useOs();
  const Icon = os === "mac" ? Apple : Windows;
  if (size === "sm")
    return (
      <a href={downloadHref(os)} className="candy inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[14px] font-semibold">
        <Icon size={15} />
        {t("nav.download")}
      </a>
    );
  return (
    <a href={downloadHref(os)} className="candy inline-flex items-center gap-2.5 rounded-full px-6 py-3.5 text-[16px] font-semibold">
      <Icon size={19} />
      {t(os === "mac" ? "hero.downloadMac" : "hero.downloadWin")}
    </a>
  );
}
