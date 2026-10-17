import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { paths, ensureDir } from "./paths.js";
import type { Deployment, Instance, Profile, Repo } from "./types.js";
import type { ApiToken } from "./tokens.js";

export interface QueuedPrompt { id: string; instanceId: string; message: string; createdAt: string; }
export interface DailyUsage { id: string; cost: number; }

interface Kinds {
  queuedPrompt: QueuedPrompt;
  dailyUsage: DailyUsage;
  profile: Profile;
  instance: Instance;
  repo: Repo;
  deployment: Deployment;
  token: ApiToken;
}
type Kind = keyof Kinds;

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  ensureDir(paths.root);
  db = new DatabaseSync(paths.db);
  fs.chmodSync(paths.db, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL,
      id   TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
  `);
  return db;
}

/** Tiny JSON document store on top of node:sqlite. */
export const store = {
  get<K extends Kind>(kind: K, id: string): Kinds[K] | undefined {
    const row = open().prepare("SELECT data FROM docs WHERE kind = ? AND id = ?").get(kind, id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Kinds[K]) : undefined;
  },
  list<K extends Kind>(kind: K): Kinds[K][] {
    const rows = open().prepare("SELECT data FROM docs WHERE kind = ? ORDER BY id").all(kind) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Kinds[K]);
  },
  put<K extends Kind>(kind: K, id: string, doc: Kinds[K]): Kinds[K] {
    open()
      .prepare("INSERT INTO docs (kind, id, data) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data")
      .run(kind, id, JSON.stringify(doc));
    return doc;
  },
  update<K extends Kind>(kind: K, id: string, patch: Partial<Kinds[K]>): Kinds[K] | undefined {
    const cur = store.get(kind, id);
    if (!cur) return undefined;
    return store.put(kind, id, { ...cur, ...patch });
  },
  delete(kind: Kind, id: string) {
    open().prepare("DELETE FROM docs WHERE kind = ? AND id = ?").run(kind, id);
  },
};
