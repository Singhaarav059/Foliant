import "server-only";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// One SQLite file under ./data. node:sqlite ships with Node, so there's no
// native module to build. Files themselves are never stored, only metadata.
export const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");

let db: DatabaseSync | null = null;

export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(join(DATA_DIR, "app.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL DEFAULT '',
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_user ON history(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export type UserRow = { id: number; email: string; name: string; pass_hash: string; created_at: number };
export type PublicUser = { id: number; email: string; name: string };

export const publicUser = (u: UserRow): PublicUser => ({
  id: u.id, email: u.email, name: u.name,
});
