// Yandex Maps and 2GIS in the "Open in…" menu of the maps agents show, after the built-in apps.
import type { PiomioUI } from "@piomio/ui";
import { dgis, yandex } from "./links";

export function activate(ui: PiomioUI): () => void {
  const off = [ui.maps.addApp({ id: "yandex", title: ui.i18n.t("app.yandex"), ...yandex }), ui.maps.addApp({ id: "2gis", title: ui.i18n.t("app.2gis"), ...dgis })];
  return () => off.forEach((f) => f());
}
