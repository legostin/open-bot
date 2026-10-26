// open-bot hub CLI: start | reset-password | pairing-code | backup | audit-verify

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { Settings } from "./settings.ts";
import { tFor } from "./i18n.ts";
import { DEFAULT_LOCALE, localeFromEnv, normalizeLocale, type Translate } from "@openbot/shared";
import { AuditLog } from "./audit.ts";
import { AuthService } from "./auth.ts";
import { Hub } from "./app.ts";

const [cmd = "start", ...args] = process.argv.slice(2);
const config = loadConfig();

/** CLI messages: the terminal's locale (OPENBOT_LANG, LC_ALL, LANG), else the hub language, else English. */
function cliT(db?: Db): Translate {
  const env = localeFromEnv(process.env);
  if (env) return tFor(env);
  const saved = db ? normalizeLocale(new Settings(db, config.timezone).get().language) : undefined;
  return tFor(saved ?? DEFAULT_LOCALE);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "start": {
      const hub = new Hub(config);
      let stopping = false;
      const shutdown = async (sig: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`[openbot] ${sig}: stopping…`);
        const force = setTimeout(() => process.exit(1), 15_000);
        force.unref();
        await hub.stop().catch((e) => console.error(e));
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("unhandledRejection", (e) => console.error("[openbot] unhandled rejection:", e));
      await hub.start();
      return;
    }
    case "reset-password": {
      const pass = args[0];
      if (!pass || pass.length < 8) throw new Error("usage: openbot reset-password <new-password (min 8 chars)>");
      const db = openDb(join(config.dataDir, "openbot.db"));
      const auth = new AuthService(db, new AuditLog(db), { rpId: new URL(config.publicUrl).hostname, origins: [config.publicUrl] });
      auth.resetPassword(pass);
      console.log(cliT(db)("cli.passwordChanged"));
      return;
    }
    case "pairing-code": {
      const db = openDb(join(config.dataDir, "openbot.db"));
      const code = Math.random().toString(36).slice(2, 10).toUpperCase();
      db.prepare("insert into pairing_codes(code, name, expires_at) values (?,?,?)").run(code, args[0] ?? null, new Date(Date.now() + 10 * 60_000).toISOString());
      console.log(cliT(db)("cli.pairingCode", { code, url: config.publicUrl }));
      return;
    }
    case "backup": {
      const target = args[0] ?? join(config.dataDir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      mkdirSync(target, { recursive: true });
      for (const f of ["openbot.db", "vault.db"]) {
        const db = new DatabaseSync(join(config.dataDir, f));
        db.exec(`vacuum into '${join(target, f).replaceAll("'", "''")}'`);
        db.close();
      }
      for (const d of ["agents", "skills", "commands", "plugins", "plugins-data"]) {
        try {
          cpSync(join(config.dataDir, d), join(target, d), { recursive: true });
        } catch {
          /* missing dir */
        }
      }
      console.log(cliT()("cli.backupDone", { path: target }));
      return;
    }
    case "audit-verify": {
      const db = openDb(join(config.dataDir, "openbot.db"));
      const r = new AuditLog(db).verify();
      console.log(r.ok ? cliT(db)("cli.auditOk", { count: r.count }) : cliT(db)("cli.auditBroken", { seq: r.brokenAt }));
      process.exitCode = r.ok ? 0 : 2;
      return;
    }
    default:
      console.log("usage: openbot [start|reset-password <pass>|pairing-code [name]|backup [dir]|audit-verify]");
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
