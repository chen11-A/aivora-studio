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
  isInTransaction(): boolean;
  vacuumInto(destinationPath: string): void;
  integrityCheck(): boolean;
  close(): void;
}

export type OpenSqliteOptions = {
  busyTimeoutMs?: number;
};

/**
 * Thin SQLite abstraction over Electron's built-in `node:sqlite` (zero native ABI build risk).
 * Every database operation goes through this seam so swapping engines stays a 1-file change.
 */
export function openSqlite(dbPath: string, options: OpenSqliteOptions = {}): SqliteDriver {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const busyTimeoutMs =
    typeof options.busyTimeoutMs === "number" && Number.isFinite(options.busyTimeoutMs)
      ? Math.max(0, Math.floor(options.busyTimeoutMs))
      : 5000;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
  }

  let inTransaction = false;
  let savepointDepth = 0;

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
    isInTransaction(): boolean {
      return inTransaction;
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction) {
        // DB1 / FIX-04: Nested transaction uses SAVEPOINT so an inner throw caught by the outer tx
        // rolls back cleanly without corrupting or leaving half-written state in the outer transaction.
        savepointDepth += 1;
        const sp = `sp_${savepointDepth}`;
        db.exec(`SAVEPOINT ${sp};`);
        let released = false;
        try {
          const res = fn();
          db.exec(`RELEASE SAVEPOINT ${sp};`);
          released = true;
          return res;
        } catch (error) {
          if (!released) {
            try {
              db.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
              db.exec(`RELEASE SAVEPOINT ${sp};`);
            } catch {
              // Preserve primary error
            }
          }
          throw error;
        } finally {
          savepointDepth = Math.max(0, savepointDepth - 1);
        }
      }
      // DB1: Only enter transaction state AFTER BEGIN IMMEDIATE succeeds so a busy lock
      // never poisons subsequent transactions into executing bare writes without rollback.
      db.exec("BEGIN IMMEDIATE;");
      inTransaction = true;
      let committed = false;
      try {
        const result = fn();
        db.exec("COMMIT;");
        committed = true;
        return result;
      } catch (error) {
        if (!committed) {
          try {
            db.exec("ROLLBACK;");
          } catch {
            // Preserve the primary error; never let cleanup failure mask root cause.
          }
        }
        throw error;
      } finally {
        inTransaction = false;
        savepointDepth = 0;
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
