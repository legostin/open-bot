// `openbot-node pair <hub> <code>`: new Ed25519 identity → POST <hub>/api/node/pair → config.json + key.json.

import { existsSync } from "node:fs";
import type { MachineInfo } from "@openbot/shared";
import { configFile, loadConfig, normalizeHubUrl, savePaired, UserError, type NodeConfig } from "./home.ts";
import { generateKey } from "./keys.ts";
import { nodeLocale, t } from "./messages.ts";

export class PairError extends UserError {}

/** Turns fetch() network failures into a readable message. */
export function networkErrorText(e: any, hubUrl: string): string {
  const code = e?.cause?.code ?? e?.code ?? "";
  const why =
    code === "ECONNREFUSED"
      ? t("net.refused")
      : code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? t("net.notFound")
        : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || e?.name === "TimeoutError"
          ? t("net.timeout")
          : /certificate|CERT|SSL|TLS/i.test(`${code} ${e?.cause?.message ?? ""}`)
            ? t("net.tls", { detail: e?.cause?.message ?? code })
            : (e?.cause?.message ?? e?.message ?? String(e));
  return t("net.unreachable", { hub: hubUrl, reason: why });
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
  const hubUrl = normalizeHubUrl(o.hubUrl);
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
  let res: Response;
  try {
    res = await fetch(`${hubUrl}/api/node/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openbot-locale": nodeLocale() },
      body: JSON.stringify({ code, publicKey: key.publicKey, name: o.name, info: o.info }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
  } catch (e: any) {
    throw new PairError(networkErrorText(e, hubUrl));
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
