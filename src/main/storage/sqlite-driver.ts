import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlParam = SQLInputValue;

export interface SqliteDriver {
  readonly engine: "node:sqlite";
  readonly path: string;
  exec(sql: string): void;
  get<T extends Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T extends Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[];
  run(sql: string, ...params: SqlParam[]): { changes: number | bigint };
  transaction<T>(fn: () => T): T;
  vacuumInto(destinationPath: string): void;
  integrityCheck(): boolean;
  close(): void;
}

/**
 * Thin SQLite abstraction over Electron's built-in `node:sqlite` (zero native ABI build risk).
 * Every database operation goes through this seam so swapping engines stays a 1-file change.
 */
export function openSqlite(dbPath: string): SqliteDriver {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
  }

  let inTransaction = false;

  return {
    engine: "node:sqlite",
    path: dbPath,
    exec(sql: string) {
      db.exec(sql);
    },
    get<T extends Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
      const row = db.prepare(sql).get(...params);
      return row as T | undefined;
    },
    all<T extends Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
      const rows = db.prepare(sql).all(...params);
      return rows as T[];
    },
    run(sql: string, ...params: SqlParam[]) {
      const result = db.prepare(sql).run(...params);
      return { changes: result.changes };
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction) return fn();
      inTransaction = true;
      db.exec("BEGIN IMMEDIATE;");
      try {
        const result = fn();
        db.exec("COMMIT;");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Ignore rollback error after failed statement.
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    vacuumInto(destinationPath: string) {
      mkdirSync(dirname(destinationPath), { recursive: true });
      const escaped = destinationPath.replaceAll("'", "''");
      db.exec(`VACUUM INTO '${escaped}';`);
    },
    integrityCheck(): boolean {
      const row = db.prepare("PRAGMA integrity_check;").get() as
        | { integrity_check?: string }
        | undefined;
      return row?.integrity_check === "ok";
    },
    close() {
      db.close();
    },
  };
}
