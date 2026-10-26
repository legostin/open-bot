// `openbot-node pair <hub> <code>`: new Ed25519 identity → POST <hub>/api/node/pair → config.json + key.json.

import { existsSync } from "node:fs";
import type { MachineInfo } from "@openbot/shared";
import { configFile, loadConfig, normalizeHubUrl, savePaired, UserError, type NodeConfig } from "./home.ts";
import { generateKey } from "./keys.ts";

export class PairError extends UserError {}

/** Turns fetch() network failures into a readable message. */
export function networkErrorText(e: any, hubUrl: string): string {
  const code = e?.cause?.code ?? e?.code ?? "";
  const why =
    code === "ECONNREFUSED"
      ? "соединение отклонено — хаб не запущен или слушает другой адрес/порт"
      : code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? "имя хоста не найдено"
        : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || e?.name === "TimeoutError"
          ? "превышено время ожидания"
          : /certificate|CERT|SSL|TLS/i.test(`${code} ${e?.cause?.message ?? ""}`)
            ? `ошибка TLS-сертификата (${e?.cause?.message ?? code})`
            : (e?.cause?.message ?? e?.message ?? String(e));
  return `Не удалось связаться с хабом ${hubUrl}: ${why}.\nПроверьте адрес. Если хаб в другой сети — подключите обе машины к Tailscale и используйте адрес хаба в tailnet.`;
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
  if (!code) throw new PairError("Не задан код привязки. Получите его в веб-интерфейсе хаба: «Машины» → «Подключить машину».");
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
      headers: { "content-type": "application/json" },
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
    if (res.status === 400) throw new PairError(`Хаб отклонил привязку: ${body.error ?? "неверный запрос"}. Получите новый код в веб-интерфейсе («Машины»).`);
    if (res.status === 429) throw new PairError("Слишком много неудачных попыток привязки. Подождите 15 минут.");
    if (res.status === 421) throw new PairError(`Хаб не принимает адрес ${new URL(hubUrl).host}. Добавьте его в OPENBOT_ALLOWED_HOSTS на хабе.`);
    if (res.status === 404) throw new PairError(`По адресу ${hubUrl} нет хаба open-bot (404). Проверьте адрес.`);
    throw new PairError(`Хаб ответил ошибкой ${res.status}${body.error ? `: ${body.error}` : ""}`);
  }
  if (!body.machineId) throw new PairError("Хаб вернул неожиданный ответ (нет machineId). Это точно open-bot?");
  const config: NodeConfig = { hubUrl, machineId: String(body.machineId), name: String(body.name ?? o.name ?? ""), pairedAt: new Date().toISOString() };
  savePaired(o.home, config, key);
  return previous && previous !== config.machineId ? { ...config, replaced: previous } : config;
}
