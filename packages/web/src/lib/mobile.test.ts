import { describe, expect, it } from "vitest";
import { chatLinkPath, isMobilePath, mobileConversationId, trackVisualViewport } from "./mobile";

describe("mobile mode", () => {
  it("is the /m/ pages only", () => {
    expect(isMobilePath("/m/chat/c1")).toBe(true);
    expect(isMobilePath("/m/")).toBe(true);
    expect(isMobilePath("/m")).toBe(true);
    expect(isMobilePath("/")).toBe(false);
    expect(isMobilePath("/mcp")).toBe(false);
    expect(isMobilePath("/machines")).toBe(false);
    expect(isMobilePath("/chat/c1")).toBe(false);
  });

  it("reads the conversation of /m/chat/:id", () => {
    expect(mobileConversationId("/m/chat/c_abc-1")).toBe("c_abc-1");
    expect(mobileConversationId("/m/chat/c1/")).toBe("c1");
    expect(mobileConversationId("/m/chat/a%20b")).toBe("a b");
    expect(mobileConversationId("/m/chat/")).toBeUndefined();
    expect(mobileConversationId("/m/chat/c1/extra")).toBeUndefined();
    expect(mobileConversationId("/m/chat/%E0%A4%A")).toBeUndefined();
    expect(mobileConversationId("/chat/c1")).toBeUndefined();
  });

  it("knows the links to other chats, which the app opens itself", () => {
    const base = "https://192.168.1.5:41782/m/chat/c1";
    expect(chatLinkPath("/agent/researcher", base)).toBe("/agent/researcher");
    expect(chatLinkPath("/", base)).toBe("/");
    expect(chatLinkPath("/chat/c_2", base)).toBe("/chat/c_2");
    expect(chatLinkPath("/tasks/t_1", base)).toBe("/tasks/t_1");
    expect(chatLinkPath("/channels/f_1", base)).toBe("/channels/f_1");
    expect(chatLinkPath("https://192.168.1.5:41782/agent/a?x=1#y", base)).toBe("/agent/a");
    expect(chatLinkPath("https://example.com/agent/a", base)).toBeUndefined();
    expect(chatLinkPath("/settings", base)).toBeUndefined();
    expect(chatLinkPath("/api/files?path=a.png", base)).toBeUndefined();
    expect(chatLinkPath("/m/chat/c2", base)).toBeUndefined();
    expect(chatLinkPath("#top", base)).toBeUndefined();
    expect(chatLinkPath("/agent/a/b", base)).toBeUndefined();
  });
});

describe("trackVisualViewport", () => {
  /** A window as WebKit on iOS shows it: innerHeight follows the visual viewport, the layout viewport does not. */
  function fakeWindow(layoutHeight: number) {
    const listeners: Array<() => void> = [];
    const vv = { width: 402, height: layoutHeight, offsetTop: 0, addEventListener: (_: string, f: () => void) => listeners.push(f), removeEventListener: () => {} };
    const props = new Map<string, string>();
    const root = { clientHeight: layoutHeight, dataset: {} as Record<string, string>, style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } };
    const win = {
      visualViewport: vv,
      get innerHeight() {
        return vv.height;
      },
      document: { documentElement: root },
      requestAnimationFrame: (f: () => void) => (f(), 1),
      cancelAnimationFrame: () => {},
    };
    const resize = (height: number) => {
      vv.height = height;
      for (const f of listeners) f();
    };
    return { win: win as unknown as Window, root, props, resize };
  }

  it("says the keyboard is open when the visual viewport is much shorter than the page", () => {
    const { win, root, props, resize } = fakeWindow(874);
    trackVisualViewport(win);
    expect(root.dataset.keyboard).toBeUndefined();
    resize(538);
    expect(root.dataset.keyboard).toBe("open");
    expect(props.get("--owl-vvh")).toBe("538px");
    resize(874);
    expect(root.dataset.keyboard).toBeUndefined();
  });

  it("ignores small changes (the URL bar, a banner)", () => {
    const { win, root, resize } = fakeWindow(874);
    trackVisualViewport(win);
    resize(820);
    expect(root.dataset.keyboard).toBeUndefined();
  });
});
