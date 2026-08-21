import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/**
 * Open the single Engram database: WAL journal, strict binding, foreign keys.
 * All tiers (core, recall, archival, history, schedules) live in this one file
 * (constitution principle V).
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  probeFts5(db);
  migrate(db);
  return db;
}

/**
 * Startup capability detection (constitution VII): FTS5 is guaranteed only
 * where Bun statically links SQLite (Linux/Windows). On macOS Bun dlopens the
 * system libsqlite3, which may lack FTS5 — fail fast with the remedy instead
 * of dying mid-migration on a confusing "no such module" error.
 */
/** Param is structural (not Database) so the failure branch is testable. */
export function probeFts5(db: { run(sql: string): unknown }): void {
  try {
    db.run("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)");
    db.run("DROP TABLE temp.fts5_probe");
  } catch {
    throw new Error(
      "this SQLite build has no FTS5 support, which Engram's recall and archival " +
        "search require. On macOS, point Bun at an FTS5-enabled build with " +
        "Database.setCustomSQLite(path) before opening the database.",
    );
  }
}

/**
 * Flush and close: checkpoint the WAL into the main file so -wal/-shm sidecars
 * don't outlive the process on platforms using the dlopen'd system SQLite.
 */
export function closeDb(db: Database): void {
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Best-effort: an in-memory DB or read-only FS still closes cleanly below.
  }
  db.close();
}

const MIGRATIONS = [
  "001_init.sql",
  "002_schedule_sleep_seq.sql",
  "003_schedule_lease.sql",
  "004_extract_failures.sql",
] as const;

export function migrate(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .query("SELECT name FROM migrations")
      .all()
      .map(r => (r as { name: string }).name),
  );
  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;
    const sql = readMigration(name);
    const run = db.transaction(() => {
      db.run(sql);
      db.query("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(name, nowIso());
    });
    run.immediate();
  }
}

function readMigration(name: string): string {
  const url = new URL(`./migrations/${name}`, import.meta.url);
  return readFileSync(url, "utf8");
}

export function nowIso(): string {
  return new Date().toISOString();
}
