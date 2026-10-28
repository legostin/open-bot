// `owlbot-node pair <hub> <code>`: new Ed25519 identity → POST <hub>/api/node/pair → config.json + key.json.

import { existsSync } from "node:fs";
import type { MachineInfo } from "@owlbot/shared";
import { configFile, loadConfig, normalizeHubUrl, savePaired, UserError, type NodeConfig } from "./home.ts";
import { generateKey } from "./keys.ts";
import { nodeLocale, t } from "./messages.ts";

export class PairError extends UserError {}

const errorCode = (e: any): string => e?.cause?.code ?? e?.code ?? "";
const isCertError = (e: any): boolean => /certificate|CERT|SSL|TLS/i.test(`${errorCode(e)} ${e?.cause?.message ?? ""}`);
/** The hub's own certificate: what its port for phones serves, at home and behind the link. */
const isSelfSigned = (e: any): boolean => /SELF_SIGNED/.test(errorCode(e));

/** Turns fetch() network failures into a readable message. */
export function networkErrorText(e: any, hubUrl: string): string {
  if (isSelfSigned(e)) return t("net.phoneAddress", { hub: hubUrl });
  const code = errorCode(e);
  const why =
    code === "ECONNREFUSED"
      ? t("net.refused")
      : code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? t("net.notFound")
        : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || e?.name === "TimeoutError"
          ? t("net.timeout")
          : isCertError(e)
            ? t("net.tls", { detail: e?.cause?.message ?? code })
            : (e?.cause?.message ?? e?.message ?? String(e));
  return t("net.unreachable", { hub: hubUrl, reason: why });
}

/**
 * `https://<hub>.ts.net:8443` is the phones' address behind the hub's link (the hub's own certificate, which phones
 * pin); machines pair at the link itself, under Tailscale's certificate.
 */
export function linkForPhoneAddress(hubUrl: string): string | undefined {
  const u = new URL(hubUrl);
  if (u.protocol !== "https:" || u.port !== "8443" || !u.hostname.endsWith(".ts.net")) return undefined;
  u.port = "";
  return u.toString().replace(/\/+$/, "");
}

export interface PairOptions {
  home: string;
  hubUrl: string;
  code: string;
  name?: string;
  info?: MachineInfo;
  timeoutMs?: number;
}

export async function pair(o: PairOptions): Promise<NodeConfig & { replaced?: string }> {
  let hubUrl = normalizeHubUrl(o.hubUrl);
  const code = String(o.code ?? "").trim();
  if (!code) throw new PairError(t("pair.noCode"));
  let previous: string | undefined;
  if (existsSync(configFile(o.home))) {
    try {
      previous = loadConfig(o.home).machineId;
    } catch {
      /* broken or half-written config: just replace it */
    }
  }
  const key = generateKey();
  const post = (url: string) =>
    fetch(`${url}/api/node/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owlbot-locale": nodeLocale() },
      body: JSON.stringify({ code, publicKey: key.publicKey, name: o.name, info: o.info }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
  let res: Response;
  try {
    res = await post(hubUrl);
  } catch (e: any) {
    const link = isCertError(e) ? linkForPhoneAddress(hubUrl) : undefined;
    if (!link) throw new PairError(networkErrorText(e, hubUrl));
    try {
      res = await post(link);
    } catch (e2: any) {
      throw new PairError(networkErrorText(e2, link));
    }
    hubUrl = link;
  }
  let body: any = {};
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    if (res.status === 400) throw new PairError(t("pair.rejected", { error: body.error ?? t("pair.badRequest") }));
    if (res.status === 429) throw new PairError(t("pair.tooMany"));
    if (res.status === 421) throw new PairError(t("pair.badHost", { host: new URL(hubUrl).host }));
    if (res.status === 404) throw new PairError(t("pair.notHub", { hub: hubUrl }));
    throw new PairError(t("pair.hubError", { status: res.status, detail: body.error ? `: ${body.error}` : "" }));
  }
  if (!body.machineId) throw new PairError(t("pair.unexpected"));
  const config: NodeConfig = { hubUrl, machineId: String(body.machineId), name: String(body.name ?? o.name ?? ""), pairedAt: new Date().toISOString() };
  savePaired(o.home, config, key);
  return previous && previous !== config.machineId ? { ...config, replaced: previous } : config;
}
