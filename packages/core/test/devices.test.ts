import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { AuditLog } from "../src/audit.ts";
import { DeviceRegistry, approvalPayload } from "../src/devices.ts";

/** A phone's key as the app sends it: the X9.63 point (0x04 ‖ X ‖ Y) in base64, plus a signer. */
function phoneKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return {
    publicKey: raw.toString("base64"),
    sign: (message: string) => sign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "der" }).toString("base64"),
  };
}

function setup() {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const audit = new AuditLog(db);
  const devices = new DeviceRegistry({ db, bus, audit });
  return { db, bus, audit, devices };
}

const pairWith = (devices: DeviceRegistry, key = phoneKey()) =>
  devices.pair({ code: devices.createPairingCode().code, name: "iPhone", platform: "ios", model: "iPhone18,1", publicKey: key.publicKey });

describe("devices", () => {
  it("pairs once per code, and not with an expired one", () => {
    const { db, devices } = setup();
    const key = phoneKey();
    const { code } = devices.createPairingCode();
    const { device, token } = devices.pair({ code, name: "iPhone", platform: "ios", publicKey: key.publicKey });
    expect(device).toMatchObject({ name: "iPhone", platform: "ios" });
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(() => devices.pair({ code, name: "Again", platform: "ios", publicKey: key.publicKey })).toThrow();

    const late = devices.createPairingCode().code;
    db.prepare("update invites set expires_at = ? where code = ?").run(new Date(Date.now() - 1000).toISOString(), late);
    expect(() => devices.pair({ code: late, name: "Late", platform: "ios", publicKey: key.publicKey })).toThrow();
  });

  it("accepts codes typed in lower case or with a dash", () => {
    const { devices } = setup();
    const { code } = devices.createPairingCode();
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(devices.pair({ code: typed, name: "iPhone", platform: "ios", publicKey: phoneKey().publicKey }).device.name).toBe("iPhone");
  });

  it("refuses a key that is not a P-256 point", () => {
    const { devices } = setup();
    const { code } = devices.createPairingCode();
    expect(() => devices.pair({ code, name: "x", platform: "ios", publicKey: Buffer.alloc(65, 4).toString("base64") })).toThrow();
    expect(() => devices.pair({ code, name: "x", platform: "ios", publicKey: "short" })).toThrow();
  });

  it("authenticates by bearer token until the device is revoked", () => {
    const { bus, audit, devices } = setup();
    const seen: unknown[] = [];
    bus.on("device.updated", (d) => seen.push(d));
    const { device, token } = pairWith(devices);
    expect(devices.authenticate(`Bearer ${token}`)?.id).toBe(device.id);
    expect(devices.authenticate(`Bearer ${token}x`)).toBeUndefined();
    expect(devices.authenticate(undefined)).toBeUndefined();
    expect(devices.authenticate(token)).toBeUndefined();
    expect(devices.list().map((d) => d.id)).toEqual([device.id]);

    devices.revoke(device.id, "user");
    expect(devices.authenticate(`Bearer ${token}`)).toBeUndefined();
    expect(devices.list()).toEqual([]);
    expect(seen.length).toBe(2);
    expect(audit.list({ limit: 10 }).map((e) => e.action)).toEqual(expect.arrayContaining(["device.pair", "device.revoke"]));
  });

  it("verifies an approval signed by the device's key, once", () => {
    const { devices } = setup();
    const key = phoneKey();
    const { device } = pairWith(devices, key);
    const { nonce } = devices.challenge(device.id, "appr_1");
    expect(devices.verifyApproval(device.id, "appr_1", nonce, key.sign(approvalPayload("appr_1", "approve", nonce)))).toBe(true);
    // The nonce is spent.
    expect(devices.verifyApproval(device.id, "appr_1", nonce, key.sign(approvalPayload("appr_1", "approve", nonce)))).toBe(false);
  });

  it("refuses a wrong key, another approval's payload or an expired nonce", () => {
    const { devices } = setup();
    const key = phoneKey();
    const { device } = pairWith(devices, key);

    let { nonce } = devices.challenge(device.id, "appr_2");
    expect(devices.verifyApproval(device.id, "appr_2", nonce, phoneKey().sign(approvalPayload("appr_2", "approve", nonce)))).toBe(false);

    ({ nonce } = devices.challenge(device.id, "appr_2"));
    expect(devices.verifyApproval(device.id, "appr_2", nonce, key.sign(approvalPayload("appr_3", "approve", nonce)))).toBe(false);

    ({ nonce } = devices.challenge(device.id, "appr_2"));
    expect(devices.verifyApproval(device.id, "appr_2", nonce, "not base64 at all")).toBe(false);

    const now = Date.now();
    ({ nonce } = devices.challenge(device.id, "appr_2"));
    const later = devices.verifyApproval(device.id, "appr_2", nonce, key.sign(approvalPayload("appr_2", "approve", nonce)), now + 3 * 60_000);
    expect(later).toBe(false);
  });
});
