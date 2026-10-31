// Text the macOS package build generates from the installer catalogs: the Installer pages and the distribution file.
// Pure functions, so they are tested on any platform (packages/core/test/desktop-packaging.test.ts).

import { text } from "../desktop/locales.mjs";

export const PKG_ID = "ai.piomio.pkg";
/** Node 24's own minimum. */
export const MIN_MACOS = "13.5";

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** An Installer page (welcome or conclusion) in one language. */
export function installerPage(catalogs, locale, page) {
  const title = text(catalogs, locale, `mac.${page}.title`);
  const body = text(catalogs, locale, `mac.${page}.body`)
    .split(/\n\n+/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body { font: 13px -apple-system, "Helvetica Neue", sans-serif; } h1 { font-size: 17px; }</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}

/** The productbuild distribution: one hidden choice, this Mac's startup disk only. */
export function distributionXml({ version, componentPkg }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Piomio</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check>
    <allowed-os-versions><os-version min="${MIN_MACOS}"/></allowed-os-versions>
  </volume-check>
  <choices-outline>
    <line choice="default"><line choice="${PKG_ID}"/></line>
  </choices-outline>
  <choice id="default"/>
  <choice id="${PKG_ID}" visible="false"><pkg-ref id="${PKG_ID}"/></choice>
  <pkg-ref id="${PKG_ID}" version="${version}" onConclusion="none">${componentPkg}</pkg-ref>
</installer-gui-script>
`;
}
