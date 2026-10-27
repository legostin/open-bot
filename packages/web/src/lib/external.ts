// Pages of other services the user finishes something on (Google's or Tailscale's sign-in): the system browser in
// the apps, a new tab in a browser.

import { errorText } from "./api";
import { native } from "./native";
import { toast } from "../state/toast";

export function openExternal(url: string): void {
  if (native) {
    native.openURL(url).catch((e: unknown) => toast(errorText(e), "error"));
    return;
  }
  window.open(url, "_blank", "noopener");
}
