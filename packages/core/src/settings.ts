import { json, type Db } from "./db.ts";

export interface CoreSettings {
  timezone: string;
  defaultAgent: string;
  quietHours: { enabled: boolean; start: string; end: string };
  digestTimes: string[];
  /** Max proactive "notify" deliveries per trigger per hour. */
  notifyRatePerHour: number;
  /** Extra egress hosts allowed for brains. */
  brainEgressAllow: string[];
  /** Hosts plugins and brains may reach even though they resolve to private/LAN addresses (e.g. "searxng", "nas.local"). */
  egressPrivateAllow: string[];
  /** Show approval details (full input) in channels like Telegram. */
  channelApprovalDetails: boolean;
  /** Concurrent sessions per brain@machine. */
  brainConcurrency: number;
  approvalInlineWaitSec: number;
  approvalExpireHours: number;
  language: string;
}

export const DEFAULT_BRAIN_EGRESS = [
  "*.anthropic.com",
  "claude.ai",
  "*.claude.ai",
  "*.claude.com",
  "claude.com",
  "*.openai.com",
  "openai.com",
  "chatgpt.com",
  "*.chatgpt.com",
  "*.googleapis.com",
  "openrouter.ai",
  "registry.npmjs.org",
  "*.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "*.sentry.io",
  "statsig.com",
  "*.statsig.com",
];

export function defaultSettings(timezone: string): CoreSettings {
  return {
    timezone,
    defaultAgent: "assistant",
    quietHours: { enabled: true, start: "23:00", end: "08:00" },
    digestTimes: ["09:00", "19:00"],
    notifyRatePerHour: 4,
    brainEgressAllow: [],
    egressPrivateAllow: [],
    channelApprovalDetails: false,
    brainConcurrency: 2,
    approvalInlineWaitSec: 45,
    approvalExpireHours: 24,
    language: "ru",
  };
}

export class Settings {
  db: Db;
  defaults: CoreSettings;
  constructor(db: Db, timezone: string) {
    this.db = db;
    this.defaults = defaultSettings(timezone);
  }

  get(): CoreSettings {
    const row = this.db.prepare("select value from settings where key = 'core'").get() as { value: string } | undefined;
    return { ...this.defaults, ...json<Partial<CoreSettings>>(row?.value, {}) };
  }

  update(patch: Partial<CoreSettings>): CoreSettings {
    const next = { ...this.get(), ...patch };
    this.db.prepare("insert into settings(key, value) values ('core', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  getKey<T>(key: string, fallback: T): T {
    const row = this.db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined;
    return json<T>(row?.value, fallback);
  }

  setKey(key: string, value: unknown): void {
    this.db.prepare("insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, JSON.stringify(value));
  }
}
