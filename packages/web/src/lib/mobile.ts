// Mobile mode: the iOS app's chat screen loads the web UI's own chat from the hub's device port, under /m/*
// (/m/chat/<conversationId>). That page shows one conversation, full height, with an iOS look; the desktop UI is
// unchanged everywhere else. Spec: docs/superpowers/specs/2026-10-26-ios-client-design.md, "Chat in a WebView".

/** A path of the phone app's pages. */
export function isMobilePath(pathname: string): boolean {
  return pathname === "/m" || pathname.startsWith("/m/");
}

/** The conversation of /m/chat/<id>, if the path is one. */
export function mobileConversationId(pathname: string): string | undefined {
  const m = /^\/m\/chat\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]) || undefined;
  } catch {
    return undefined;
  }
}

/** The web UI's pages that are a chat in the app too: the default agent's dialog, an agent's, a group chat, a task. */
const CHAT_PAGES = [/^\/$/, /^\/agent\/[^/]+\/?$/, /^\/chat\/[^/]+\/?$/, /^\/tasks\/[^/]+\/?$/];

/**
 * The hub path of a link to another chat (`/`, `/agent/:id`, `/chat/:id` or `/tasks/:id` in the web UI), which the
 * app opens as its own chat screen; undefined for any other link.
 */
export function chatLinkPath(href: string, base: string): string | undefined {
  let url: URL;
  try {
    const from = new URL(base);
    url = new URL(href, from);
    if (url.origin !== from.origin) return undefined;
  } catch {
    return undefined;
  }
  return CHAT_PAGES.some((page) => page.test(url.pathname)) ? url.pathname : undefined;
}

/** Decided once per page load: the app opens /m/* pages directly. */
export const mobileMode = typeof window !== "undefined" && isMobilePath(window.location.pathname);

/** The class on <html> that scopes the iOS look (and the `mobile:` Tailwind variant). */
export const MOBILE_CLASS = "owl-mobile";

export const MOBILE_VIEWPORT = "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover";

/** Before the first render in mobile mode: no zoom, the iOS look. */
export function applyMobileDocument(doc: Document = document): void {
  doc.documentElement.classList.add(MOBILE_CLASS);
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = "viewport";
    doc.head.appendChild(meta);
  }
  meta.content = MOBILE_VIEWPORT;
}

/** The on-screen keyboard is up when the visual viewport is this much shorter than the window. */
const KEYBOARD_MIN = 120;

/**
 * Keep the page inside the visual viewport, so the composer sits right above the on-screen keyboard: iOS shrinks
 * the visual viewport (not the layout one) and pans it to the focused field. Sets --owl-vvh / --owl-vvtop on
 * <html> and data-keyboard="open" while the keyboard is up. Returns the cleanup.
 */
export function trackVisualViewport(win: Window = window): () => void {
  const vv = win.visualViewport;
  const root = win.document.documentElement;
  if (!vv) return () => {};
  let frame = 0;
  // The page's height without the keyboard. WebKit on iOS shrinks innerHeight along with the visual viewport, so it
  // is the layout viewport (<html>'s clientHeight) or the tallest visual viewport seen at this width.
  let width = 0;
  let tallest = 0;
  const apply = () => {
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      if (vv.width !== width) {
        width = vv.width;
        tallest = 0;
      }
      tallest = Math.max(tallest, vv.height, root.clientHeight);
      root.style.setProperty("--owl-vvh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--owl-vvtop", `${Math.max(0, Math.round(vv.offsetTop))}px`);
      if (tallest - vv.height > KEYBOARD_MIN) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
    });
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    win.cancelAnimationFrame(frame);
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    root.style.removeProperty("--owl-vvh");
    root.style.removeProperty("--owl-vvtop");
    delete root.dataset.keyboard;
  };
}
