import { describe, expect, it } from "vitest";
import {
  decideHeadless,
  filenameFromDisposition,
  isPrivateHost,
  normalizeUrl,
  proxyFromEnv,
  readSettings,
  sanitizeFilename,
  totpCode,
} from "../server/util.ts";
import { ACTION_LABEL_RE, LINK_ACTION_LABEL_RE, activationKey, keyNeedsSubmit } from "../server/safety.ts";
import { keyEventParams } from "../server/manager.ts";

describe("settings", () => {
  it("applies defaults and accepts booleans for headless", () => {
    expect(readSettings({})).toEqual({ headless: "auto", idleMinutes: 30, allowLocalNetwork: false, takeoverWaitSec: 10, maxDownloadMb: 200 });
    expect(readSettings({ headless: false }).headless).toBe("never");
    expect(readSettings({ headless: true }).headless).toBe("always");
    expect(readSettings({ idleMinutes: "5" }).idleMinutes).toBe(5);
    expect(readSettings({ idleMinutes: -3 }).idleMinutes).toBe(1);
  });

  it("is headed only with a display", () => {
    expect(decideHeadless("auto", { DISPLAY: ":99" }, "linux")).toBe(false);
    expect(decideHeadless("auto", {}, "linux")).toBe(true);
    expect(decideHeadless("auto", {}, "win32")).toBe(true);
    expect(decideHeadless("never", {}, "win32")).toBe(false);
    expect(decideHeadless("always", { DISPLAY: ":99" }, "linux")).toBe(true);
  });
});

describe("proxy", () => {
  it("takes the egress token from the URL userinfo", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "http://tok_abc:x@127.0.0.1:8089", NO_PROXY: "127.0.0.1,localhost" })).toEqual({
      server: "http://127.0.0.1:8089",
      username: "tok_abc",
      password: "x",
      bypass: "127.0.0.1,localhost",
    });
    expect(proxyFromEnv({})).toBeUndefined();
  });
});

describe("urls", () => {
  it("recognizes local and private hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.5", "169.254.169.254", "[::1]", "fd00::1", "router", "nas.local", "host.docker.internal", "app.localhost"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"]) expect(isPrivateHost(h), h).toBe(false);
    // WHATWG URL normalizes numeric hosts, so decimal tricks are caught too.
    expect(isPrivateHost(new URL("http://2130706433/").hostname)).toBe(true);
  });

  it("normalizes user input", () => {
    expect(normalizeUrl("example.com/a").href).toBe("https://example.com/a");
    expect(normalizeUrl("localhost:3000").href).toBe("http://localhost:3000/");
    expect(normalizeUrl("http://x.test/").href).toBe("http://x.test/");
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow();
  });
});

describe("files", () => {
  it("sanitizes names", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..")).toBe("download");
    expect(sanitizeFilename("a<b>:c?.pdf")).toBe("a_b_c_.pdf");
    expect(sanitizeFilename("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("x".repeat(300) + ".zip").length).toBeLessThanOrEqual(120);
  });

  it("parses Content-Disposition", () => {
    expect(filenameFromDisposition(`attachment; filename="a b.txt"`)).toBe("a b.txt");
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.txt`)).toBe("отчёт.txt");
    expect(filenameFromDisposition(undefined)).toBeUndefined();
  });
});

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 vector", () => {
    // Secret "12345678901234567890" in base32, T = 59 s → 94287082 (8 digits).
    const uri = "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8";
    expect(totpCode(uri, 59_000)).toBe("94287082");
    expect(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109_000)).toBe("081804");
  });
});

describe("safety", () => {
  it("flags action labels in English and Russian", () => {
    for (const s of ["Buy now", "Place order", "Send", "Delete", "Купить", "Купи", "Оплатить", "Оформить заказ", "Отправить", "Подтвердить", "Удалить", "Опубликовать"]) {
      expect(ACTION_LABEL_RE.test(s), s).toBe(true);
    }
    for (const s of ["Купон", "Search", "Next", "Далее", "Найти", "Orders", "Resend code", "PayPal", "Facebook"]) expect(ACTION_LABEL_RE.test(s), s).toBe(false);
    expect(LINK_ACTION_LABEL_RE.test("Удалить аккаунт")).toBe(true);
    expect(LINK_ACTION_LABEL_RE.test("Мои заказы")).toBe(false);
  });

  it("requires browser_submit for Enter in fields and forms", () => {
    const base = { tag: "input", name: "", editable: false, inForm: false, search: false, submit: false };
    expect(activationKey("Enter")).toBe("enter");
    expect(activationKey("Control+Enter")).toBe("enter");
    expect(activationKey("Space")).toBe("space");
    expect(activationKey("Tab")).toBeNull();
    expect(keyNeedsSubmit("enter", { ...base, editable: true })).toBe(true);
    expect(keyNeedsSubmit("enter", { ...base, editable: true, inForm: true, search: true })).toBe(false);
    expect(keyNeedsSubmit("enter", { ...base, tag: "a" })).toBe(false);
    expect(keyNeedsSubmit("space", { ...base, editable: true })).toBe(false);
    expect(keyNeedsSubmit("space", { ...base, submit: true })).toBe(true);
  });
});

describe("takeover keys", () => {
  it("maps UI keyboard events to CDP", () => {
    expect(keyEventParams({ key: "a", code: "KeyA", action: "down" }, 0)).toMatchObject({ type: "keyDown", text: "a", windowsVirtualKeyCode: 65 });
    expect(keyEventParams({ key: "Enter", code: "Enter", action: "down" }, 0)).toMatchObject({ type: "keyDown", text: "\r", windowsVirtualKeyCode: 13 });
    expect(keyEventParams({ key: "a", code: "KeyA", action: "down" }, 2)).toMatchObject({ type: "rawKeyDown", text: undefined });
    expect(keyEventParams({ key: "ArrowLeft", action: "up" }, 0)).toMatchObject({ type: "keyUp", windowsVirtualKeyCode: 37 });
    expect(keyEventParams({ key: "" }, 0)).toBeNull();
  });
});
