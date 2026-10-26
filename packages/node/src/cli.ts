#!/usr/bin/env node
// openbot-node CLI: pair | run | status | policy

import { existsSync, readFileSync } from "node:fs";
import { configFile, keyFile, loadConfig, nodeHome, normalizeHubUrl, NotPairedError, UserError } from "./home.ts";
import { PolicyStore, policySummary } from "./policy.ts";
import { BrainHost } from "./brains.ts";
import { pair, PairError, networkErrorText } from "./pair.ts";
import { createNodeDaemon } from "./daemon.ts";
import { consoleLogger, machineInfo, osName } from "./info.ts";

const HELP = `openbot-node — подключает этот компьютер к хабу open-bot

Команды:
  openbot-node pair <адрес-хаба> <код> [--name <имя>]   привязать машину (код — в веб-интерфейсе: «Машины»)
  openbot-node run                                     подключиться к хабу и обслуживать запросы (в консоли)
  openbot-node status                                  привязка, политика, установленные CLI, доступность хаба
  openbot-node policy                                  путь и содержимое файла политики

Папка состояния: ${nodeHome()} (переопределяется OPENBOT_NODE_HOME)`;

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === "-h") flags.help = true;
    else positional.push(a);
  }
  return { positional, flags };
}

const out = (s = "") => process.stdout.write(s + "\n");

async function cmdPair(args: string[], flags: Record<string, string | true>): Promise<void> {
  const [hubUrl, code] = args;
  if (!hubUrl || !code) throw new PairError("Использование: openbot-node pair <адрес-хаба> <код> [--name <имя>]\nПример: openbot-node pair http://100.64.0.1:8080 AB12CD34");
  normalizeHubUrl(hubUrl);
  const home = nodeHome();
  const policy = new PolicyStore(home, { log: (m) => out(m) });
  const brains = new BrainHost({ home, policy });
  out("Проверяю установленные CLI…");
  const clis = await brains.probeAll();
  const name = typeof flags.name === "string" ? flags.name : undefined;
  const r = await pair({ home, hubUrl, code, name, info: machineInfo(policy.get(), clis) });
  out(`\nМашина привязана к хабу ${r.hubUrl}: «${r.name}» (${r.machineId})`);
  if (r.replaced) out(`Предыдущая привязка (${r.replaced}) заменена — её можно отозвать в веб-интерфейсе.`);
  out(`Ключ:     ${keyFile(home)}`);
  out(`Политика: ${policy.file}`);
  for (const l of policySummary(policy.get())) out(`  ${l}`);
  out(`Мозги:    ${clis.map((c) => `${c.brainId} — ${c.available ? `есть${c.version ? ` ${c.version}` : ""}${c.authenticated ? "" : " (нет входа)"}` : (c.detail ?? "нет")}`).join("; ")}`);
  out("\nДальше: openbot-node run   (или установите как службу — см. README)");
}

async function cmdRun(): Promise<void> {
  const home = nodeHome();
  const log = consoleLogger();
  let exiting = false;
  const daemon = createNodeDaemon({
    home,
    log,
    onFatal: () => {
      exiting = true;
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 200).unref();
    },
  });
  out(`openbot-node: машина «${daemon.config.name}» (${daemon.config.machineId}), хаб ${daemon.config.hubUrl}`);
  out(`Политика: ${daemon.policy.file} (изменения применяются на лету)`);
  for (const l of policySummary(daemon.policy.get())) out(`  ${l}`);
  const shutdown = async (sig: string) => {
    if (exiting) return;
    exiting = true;
    log(`${sig}: остановка…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await daemon.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("unhandledRejection", (e: any) => log(`необработанная ошибка: ${e?.stack ?? e}`));
  process.on("uncaughtException", (e: any) => log(`необработанное исключение: ${e?.stack ?? e}`));
  daemon.client.start();
}

async function cmdStatus(): Promise<void> {
  const home = nodeHome();
  out(`Папка:    ${home}`);
  let hubUrl: string | undefined;
  try {
    const c = loadConfig(home);
    hubUrl = c.hubUrl;
    out(`Хаб:      ${c.hubUrl}`);
    out(`Машина:   «${c.name}» (${c.machineId})${c.pairedAt ? `, привязана ${c.pairedAt}` : ""}`);
  } catch (e: any) {
    out(e instanceof NotPairedError ? "Привязка: нет (openbot-node pair <адрес-хаба> <код>)" : `Привязка: ошибка — ${e.message}`);
  }
  out(`Система:  ${osName()}, ${process.arch}, Node ${process.version}`);
  const policy = new PolicyStore(home, { log: (m) => out(m) });
  out(`Политика: ${policy.file}`);
  for (const l of policySummary(policy.get())) out(`  ${l}`);
  const brains = new BrainHost({ home, policy });
  out("CLI мозгов:");
  for (const c of await brains.probeAll()) {
    out(`  ${c.brainId}: ${c.available ? `установлен${c.version ? ` (${c.version})` : ""}, ${c.authenticated ? "вход выполнен" : "нет входа"}` : "недоступен"}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (hubUrl) {
    try {
      const r = await fetch(`${hubUrl}/api/auth/state`, { signal: AbortSignal.timeout(5000) });
      const j: any = await r.json().catch(() => ({}));
      out(r.ok ? `Хаб доступен (open-bot ${j.version ?? "?"})` : `Хаб ответил ${r.status}`);
    } catch (e: any) {
      out(networkErrorText(e, hubUrl));
    }
  }
}

function cmdPolicy(): void {
  const home = nodeHome();
  const policy = new PolicyStore(home, { log: (m) => out(m) });
  out(policy.file);
  out();
  out(readFileSync(policy.file, "utf8").trimEnd());
  if (!existsSync(configFile(home))) out("\n(машина ещё не привязана: openbot-node pair <адрес-хаба> <код>)");
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
    out(HELP);
    return;
  }
  switch (cmd) {
    case "pair":
      return cmdPair(positional, flags);
    case "run":
      return cmdRun();
    case "status":
      return cmdStatus();
    case "policy":
      return cmdPolicy();
    default:
      throw new PairError(`Неизвестная команда «${cmd}».\n\n${HELP}`);
  }
}

main().catch((e: any) => {
  const known = e instanceof UserError;
  process.stderr.write(`${known ? e.message : `Ошибка: ${e?.message ?? e}`}\n`);
  process.exit(1);
});
