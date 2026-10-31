import { describe, expect, it } from "vitest";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { deviceTls } from "../src/devices-tls.ts";

describe("device port certificate", () => {
  it("is a valid self-signed P-256 certificate, kept across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "owl-tls-"));
    const a = deviceTls(dir);
    const b = deviceTls(dir);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const x = new X509Certificate(a.cert);
    expect(x.publicKey.asymmetricKeyType).toBe("ec");
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.subject).toMatch(/^CN=Piomio hub /);
    expect(new Date(x.validTo).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 19);
    expect(createHash("sha256").update(x.raw).digest("base64url")).toBe(a.fingerprint);
  });

  it("serves TLS, and the client sees the pinned certificate", async () => {
    const tls = deviceTls(mkdtempSync(join(tmpdir(), "owl-tls-")));
    const server = createServer({ key: tls.key, cert: tls.cert }, (_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const seen = await new Promise<{ body: string; fingerprint: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false }, (res) => {
          const raw = (res.socket as any).getPeerCertificate().raw as Buffer;
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ body, fingerprint: createHash("sha256").update(raw).digest("base64url") }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(seen).toEqual({ body: "ok", fingerprint: tls.fingerprint });
    } finally {
      server.close();
    }
  });
});
