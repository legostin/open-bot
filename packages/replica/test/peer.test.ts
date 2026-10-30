import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:https";
import { selfSignedCertificate } from "../../core/src/devices-tls.ts";
import { fingerprintOfDer, newReplicaKey, pinnedRequest, PinError, signRequest, verifyRequest } from "../src/peer.ts";

describe("replica requests", () => {
  const a = newReplicaKey("rep_a");
  const b = newReplicaKey("rep_b");
  const keys = (id: string) => (id === "rep_a" ? a.publicKey : id === "rep_b" ? b.publicKey : undefined);

  it("names the replica that signed, and nobody for a changed or stale request", () => {
    const now = 1_800_000_000_000;
    const h = signRequest(a, "POST", "/api/replica/changes", '{"v":1}', now);
    expect(verifyRequest(h, "POST", "/api/replica/changes", '{"v":1}', keys, now + 5_000)).toBe("rep_a");
    expect(verifyRequest(h, "POST", "/api/replica/changes", '{"v":2}', keys, now)).toBeUndefined();
    expect(verifyRequest(h, "POST", "/api/replica/hello", '{"v":1}', keys, now)).toBeUndefined();
    expect(verifyRequest(h, "POST", "/api/replica/changes", '{"v":1}', keys, now + 120_000)).toBeUndefined();
    // Another replica's key, or a revoked one, does not do.
    expect(verifyRequest(h.replace("rep_a", "rep_b"), "POST", "/api/replica/changes", '{"v":1}', keys, now)).toBeUndefined();
    expect(verifyRequest(h, "POST", "/api/replica/changes", '{"v":1}', () => undefined, now)).toBeUndefined();
    expect(verifyRequest("Bearer x", "GET", "/", "", keys)).toBeUndefined();
  });

  describe("pinned TLS", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const der = selfSignedCertificate(publicKey, privateKey, "Owlbot hub test");
    const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
    let server: Server;
    let url = "";
    afterAll(() => server?.close());

    it("talks to the hub's own certificate and refuses another", async () => {
      server = createServer({ key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert }, (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => res.end(JSON.stringify({ method: req.method, body })));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      url = `https://127.0.0.1:${(server.address() as any).port}/x`;
      const ok = await pinnedRequest(url, { method: "POST", body: "hi", fingerprint: fingerprintOfDer(der) });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body.toString())).toEqual({ method: "POST", body: "hi" });
      await expect(pinnedRequest(url, { fingerprint: "not-it" })).rejects.toBeInstanceOf(PinError);
      // Without a pin a self-signed certificate is refused as usual.
      await expect(pinnedRequest(url)).rejects.toThrow();
    });
  });
});
