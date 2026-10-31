// The demo's entry (demo.html). Before any of the app's modules load: the interface language of the page that embeds
// the demo, and the service worker that serves pictures and tiles. Then start.tsx brings up the demo hub and the app.

import { readParams, type FromDemo } from "./protocol";

const params = readParams(location.search);

function report(m: FromDemo): void {
  if (window.parent !== window) window.parent.postMessage(m, location.origin);
}

async function serviceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register(new URL("demo-sw.js", document.baseURI), { scope: "./" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });
    return !!navigator.serviceWorker.controller;
  } catch (e) {
    console.warn("[demo] no service worker", e);
    return false;
  }
}

try {
  // The app reads this before anything else: the demo speaks the page's language, whatever the browser's.
  localStorage.setItem("piomio.locale", params.lang);
} catch {
  /* storage blocked: the hub language (the same) still applies */
}

const sw = await serviceWorker();
if (!sw) report({ source: "piomio-demo", type: "failed", chapter: params.chapter, message: "no service worker" });
const { start } = await import("./start");
await start(params, report);
