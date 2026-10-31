// RemoteAccess with a fake node (fixtures/tailnet/fake-tailnet.mjs): its states, restarts, turning off and forgetting.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteView } from "@piomio/shared";
import { EventBus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { deviceTls } from "../src/devices-tls.ts";
import { RemoteAccess } from "../src/remote.ts";

const FAKE = join(import.meta.dirname, "fixtures/tailnet/fake-tailnet.mjs");
chmodSync(FAKE, 0o755);

function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() > end) return reject(new Error("timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const made: RemoteAccess[] = [];
afterEach(async () => {
  for (const r of made.splice(0)) await r.stop();
});

function setup(opts: { bin?: string; plan?: unknown; password?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "owl-remote-"));
  const config = loadConfig({ PIOMIO_TAILNET_BIN: opts.bin ?? FAKE, PIOMIO_TAILNET_HOSTNAME: "piomio-test", TZ: "UTC" }, { dataDir });
  if (opts.plan) {
    mkdirSync(join(dataDir, "tailnet"), { recursive: true });
    writeFileSync(join(dataDir, "tailnet", "fake.json"), JSON.stringify(opts.plan));
  }
  let settings = { remoteAccess: false };
  const bus = new EventBus();
  const events: RemoteView[] = [];
  bus.on("remote.updated", (v) => events.push(v));
  const gateways = { started: 0, stopped: 0, async start() { this.started++; return { web: 4101, device: 4102 }; }, async stop() { this.stopped++; } };
  const remote = new RemoteAccess({
    config,
    settings: { get: () => settings, update: (p) => (settings = { ...settings, ...p }) },
    bus,
    deviceTls: () => deviceTls(dataDir),
    gateways,
    hasPassword: () => opts.password !== false,
  });
  made.push(remote);
  return { remote, dataDir, events, gateways, settings: () => settings };
}

const RUNNING = { state: "running", url: "https://piomio-test.tail1234.ts.net", deviceUrl: "https://piomio-test.tail1234.ts.net:8443", account: "anna@example.com", keyExpiry: "2027-04-25T00:00:00Z" };

describe("access from anywhere", () => {
  it("is unavailable without the node program", async () => {
    const { remote } = setup({ bin: "/nonexistent/piomio-tailnet" });
    expect(remote.view("en")).toMatchObject({ available: false, enabled: false, state: "off" });
    expect(remote.view("en").error).toMatch(/npm run build:tailnet/);
    await expect(remote.enable()).rejects.toMatchObject({ key: "remote.unavailable", status: 409 });
  });

  it("needs the hub password", async () => {
    const { remote } = setup({ password: false });
    await expect(remote.enable()).rejects.toMatchObject({ key: "auth.noPassword", status: 409 });
  });

  it("walks sign-in, Funnel and the link, and tells the node where to proxy", async () => {
    const { remote, dataDir, events, gateways, settings } = setup({
      plan: {
        states: [
          { state: "starting" },
          { state: "needs-login", authUrl: "https://login.tailscale.com/a/abc" },
          { state: "needs-funnel", enableUrl: "https://login.tailscale.com/f/funnel?node=n1" },
          RUNNING,
        ],
      },
    });
    await remote.enable();
    expect(settings().remoteAccess).toBe(true);
    await until(() => events.find((e) => e.state === "running"));
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(["needs-login", "needs-funnel", "running"]));
    expect(events.find((e) => e.state === "needs-login")?.authUrl).toBe("https://login.tailscale.com/a/abc");
    expect(events.find((e) => e.state === "needs-funnel")?.enableUrl).toBe("https://login.tailscale.com/f/funnel?node=n1");
    expect(remote.view("en")).toEqual({ available: true, enabled: true, ...RUNNING });
    expect(remote.linkHost()).toBe("piomio-test.tail1234.ts.net");
    expect(remote.deviceLink()).toBe("https://piomio-test.tail1234.ts.net:8443");

    const start = JSON.parse(readFileSync(join(dataDir, "tailnet", "start.json"), "utf8"));
    expect(start).toMatchObject({ type: "start", dir: join(dataDir, "tailnet"), hostname: "piomio-test", web: "127.0.0.1:4101", device: "127.0.0.1:4102" });
    expect(start.deviceCert).toBe(deviceTls(dataDir).cert);
    expect(start.deviceKey).toBe(deviceTls(dataDir).key);
    expect(gateways.started).toBe(1);

    await remote.disable();
    expect(settings().remoteAccess).toBe(false);
    expect(remote.view("en")).toEqual({ available: true, enabled: false, state: "off" });
    expect(remote.linkHost()).toBeUndefined();
    expect(gateways.stopped).toBeGreaterThan(0);
  });

  it("restarts a node that fell over, saying why meanwhile", async () => {
    const { remote, events } = setup({ plan: { states: [{ state: "starting" }], crashOnce: true } });
    await remote.enable();
    const failed = await until(() => events.find((e) => e.state === "error"));
    expect(failed.error).toBe("Tailscale: boom: the fake node fell over");
    // The second run does not crash: it is back to "starting" after the 2 s pause.
    await until(() => events.findLast((e) => e.state !== "error" && events.indexOf(e) > events.indexOf(failed)), 6000);
  });

  it("reports machine approval as a step, not a failure", async () => {
    const { remote, events } = setup({ plan: { states: [{ state: "needs-login", message: "machine-auth" }] } });
    await remote.enable();
    await until(() => events.find((e) => e.state === "needs-login"));
    expect(remote.view("en").error).toMatch(/approve the piomio machine/);
  });

  it("forgets: signs the node out and deletes its keys", async () => {
    const { remote, dataDir, settings } = setup({ plan: { states: [RUNNING] } });
    await remote.enable();
    await until(() => remote.linkHost());
    await remote.forget();
    expect(existsSync(join(dataDir, "tailnet.logged-out"))).toBe(true);
    expect(existsSync(join(dataDir, "tailnet"))).toBe(false);
    expect(settings().remoteAccess).toBe(false);
    expect(remote.view("en").state).toBe("off");
  });

  it("comes back on hub start when it was on", async () => {
    const { remote, events, settings } = setup({ plan: { states: [RUNNING] } });
    expect(settings().remoteAccess).toBe(false);
    await remote.start();
    expect(events).toEqual([]);
    await remote.enable();
    await until(() => remote.linkHost());
    await remote.stop();
    expect(settings().remoteAccess).toBe(true);
    await remote.start();
    await until(() => remote.linkHost());
  });
});
