// The plugin's working state next to the memory folder (not in git): how often each fact was recalled, the journal of
// the user's messages for the nightly reflection, and small settings like when memory was last tidied.

import { DatabaseSync } from "node:sqlite";
import type { Usage } from "./recall.ts";

export interface JournalEntry {
  id: number;
  at: string;
  agent: string;
  conversation: string;
  text: string;
}

/** Journal entries kept at most (oldest go first). */
const MAX_JOURNAL = 400;

export class MemoryState {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      create table if not exists usage (path text primary key, recalled integer not null default 0, last_recalled text not null default '');
      create table if not exists journal (id integer primary key autoincrement, at text not null, agent text not null, conversation text not null, text text not null);
      create table if not exists meta (key text primary key, value text not null);
    `);
  }

  usage(path: string): Usage | undefined {
    const r = this.db.prepare("select recalled, last_recalled from usage where path = ?").get(path) as { recalled: number; last_recalled: string } | undefined;
    return r ? { recalled: r.recalled, lastRecalled: r.last_recalled } : undefined;
  }

  recalled(paths: string[], at = new Date().toISOString()): void {
    const st = this.db.prepare("insert into usage(path, recalled, last_recalled) values (?, 1, ?) on conflict(path) do update set recalled = recalled + 1, last_recalled = excluded.last_recalled");
    for (const p of paths) st.run(p, at);
  }

  moveUsage(from: string, to: string): void {
    const u = this.usage(from);
    if (!u) return;
    this.db.prepare("insert into usage(path, recalled, last_recalled) values (?, ?, ?) on conflict(path) do update set recalled = recalled + excluded.recalled, last_recalled = max(last_recalled, excluded.last_recalled)").run(to, u.recalled, u.lastRecalled);
  }

  journal(entry: Omit<JournalEntry, "id">): void {
    this.db.prepare("insert into journal(at, agent, conversation, text) values (?, ?, ?, ?)").run(entry.at, entry.agent, entry.conversation, entry.text);
    this.db.prepare("delete from journal where id <= (select max(id) from journal) - ?").run(MAX_JOURNAL);
  }

  journalEntries(): JournalEntry[] {
    return this.db.prepare("select id, at, agent, conversation, text from journal order by id").all() as unknown as JournalEntry[];
  }

  clearJournal(upTo: number): void {
    this.db.prepare("delete from journal where id <= ?").run(upTo);
  }

  get(key: string): string | undefined {
    return (this.db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value;
  }

  set(key: string, value: string): void {
    this.db.prepare("insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
