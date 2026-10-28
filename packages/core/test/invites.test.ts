import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { AuditLog } from "../src/audit.ts";
import { InviteRegistry, INVITE_TTL } from "../src/invites.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { MachineHub } from "../src/machines.ts";

function setup() {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const audit = new AuditLog(db);
  const invites = new InviteRegistry({ db, bus, audit });
  return { db, bus, audit, invites };
}

const phoneKey = () => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64");
};
const machineKey = () => Buffer.alloc(32, 7).toString("base64url");

describe("invites", () => {
  it("lasts an hour and works once", () => {
    const { invites } = setup();
    const { code, expiresAt } = invites.create();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(INVITE_TTL - 5000);
    expect(invites.valid(code)).toBe(true);
    expect(invites.consume(code, "machine:m1")).toBe(true);
    expect(invites.consume(code, "machine:m2")).toBe(false);
    expect(invites.valid(code)).toBe(false);
  });

  it("refuses expired, revoked and unknown codes, and reads them typed loosely", () => {
    const { db, invites } = setup();
    const late = invites.create().code;
    db.prepare("update invites set expires_at = ? where code = ?").run(new Date(Date.now() - 1000).toISOString(), late);
    expect(invites.consume(late, "x")).toBe(false);
    const gone = invites.create().code;
    expect(invites.revoke(gone)).toBe(true);
    expect(invites.valid(gone)).toBe(false);
    expect(invites.consume("NOPE1234", "x")).toBe(false);
    const typed = invites.create().code;
    expect(invites.consume(`${typed.slice(0, 4)}-${typed.slice(4)}`.toLowerCase(), "x")).toBe(true);
  });

  it("pairs either a phone or a machine, and says which joined", () => {
    const { db, bus, audit, invites } = setup();
    const devices = new DeviceRegistry({ db, bus, audit, invites });
    const machines = new MachineHub({ db, bus, audit, brains: {} as any, invites });
    const used: unknown[] = [];
    bus.on("invite.used", (e) => used.push(e));

    const forPhone = invites.create().code;
    expect(devices.pair({ code: forPhone, name: "iPhone", platform: "ios", publicKey: phoneKey() }).device.name).toBe("iPhone");
    expect(() => machines.pair({ code: forPhone, publicKey: machineKey(), name: "pc" })).toThrow(/expired or was already used/);

    const forMachine = devices.createPairingCode().code;
    expect(machines.pair({ code: forMachine, publicKey: machineKey(), name: "pc" }).name).toBe("pc");
    expect(used).toEqual([
      { code: forPhone, kind: "device", name: "iPhone" },
      { code: forMachine, kind: "machine", name: "pc" },
    ]);
  });
});
