import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite, type SqliteDriver } from "./sqlite-driver";

const tempDirs: string[] = [];
const openDbs: SqliteDriver[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    try {
      openDbs.pop()!.close();
    } catch {
      // ignore double-close
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("DB1: SqliteDriver transaction flag recovery after SQLITE_BUSY", () => {
  it("does not invoke callback or poison inTransaction when BEGIN IMMEDIATE fails on lock contention, and rolls back subsequent failed transactions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aivora-db1-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "busy.db");

    const conn1 = openSqlite(dbPath, { busyTimeoutMs: 50 });
    const conn2 = openSqlite(dbPath, { busyTimeoutMs: 50 });
    openDbs.push(conn1, conn2);

    conn1.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL);`);

    // 1. Connection 1 acquires an exclusive write lock
    conn1.exec(`BEGIN IMMEDIATE;`);
    conn1.run(`INSERT INTO items (id, label) VALUES (?, ?)`, "c1", "locked-row");

    // 2. Connection 2 attempts a transaction -> BEGIN IMMEDIATE MUST fail BEFORE callback runs
    let callbackRan = false;
    expect(() =>
      conn2.transaction(() => {
        callbackRan = true;
        conn2.run(`INSERT INTO items (id, label) VALUES (?, ?)`, "c2_should_not_run", "bad");
      }),
    ).toThrow(/locked|busy/i);
    expect(callbackRan).toBe(false);
    expect(conn2.isInTransaction()).toBe(false);

    // 3. Release connection 1's lock
    conn1.exec(`COMMIT;`);

    // 4. Connection 2 runs a second transaction that inserts a row and then deliberately throws.
    // If DB1 were broken, inTransaction would still be true and the insert would execute bare (committed)!
    expect(() =>
      conn2.transaction(() => {
        conn2.run(`INSERT INTO items (id, label) VALUES (?, ?)`, "c2_rollback", "must-not-persist");
        throw new Error("deliberate-failure-after-insert");
      }),
    ).toThrow("deliberate-failure-after-insert");
    expect(conn2.isInTransaction()).toBe(false);

    // Verify ONLY conn1's committed row exists — conn2's failed insert was truly rolled back!
    const rows = conn1.all<{ id: string; label: string }>(`SELECT id, label FROM items ORDER BY id ASC`);
    expect(rows).toEqual([{ id: "c1", label: "locked-row" }]);
  });

  it("preserves primary business error even if ROLLBACK cleanup itself throws, and resets inTransaction", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aivora-db1-err-"));
    tempDirs.push(dir);
    const db = openSqlite(path.join(dir, "err.db"), { busyTimeoutMs: 50 });
    openDbs.push(db);
    db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY);`);

    expect(() =>
      db.transaction(() => {
        db.run(`INSERT INTO notes (id) VALUES ('n1')`);
        // Force inner rollback so outer ROLLBACK throws "cannot rollback - no transaction is active"
        db.exec(`ROLLBACK;`);
        throw new Error("primary-root-cause-error");
      }),
    ).toThrow("primary-root-cause-error");

    expect(db.isInTransaction()).toBe(false);
    expect(db.all<{ id: string }>(`SELECT id FROM notes`)).toHaveLength(0);

    // Subsequent transaction still behaves transactionally
    expect(() =>
      db.transaction(() => {
        db.run(`INSERT INTO notes (id) VALUES ('n2')`);
        throw new Error("second-failure");
      }),
    ).toThrow("second-failure");
    expect(db.all<{ id: string }>(`SELECT id FROM notes`)).toHaveLength(0);
  });

  it("FIX-04: nested transaction uses SAVEPOINT so caught inner failure rolls back inner write while outer write commits", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aivora-db1-sp-"));
    tempDirs.push(dir);
    const db = openSqlite(path.join(dir, "sp.db"), { busyTimeoutMs: 50 });
    openDbs.push(db);
    db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY);`);

    db.transaction(() => {
      db.run(`INSERT INTO items (id) VALUES ('outer_ok')`);
      try {
        db.transaction(() => {
          db.run(`INSERT INTO items (id) VALUES ('inner_must_rollback')`);
          throw new Error("inner-boom");
        });
      } catch {
        // Outer tx catches inner failure and continues
      }
      db.run(`INSERT INTO items (id) VALUES ('outer_after')`);
    });

    const ids = db.all<{ id: string }>(`SELECT id FROM items ORDER BY id ASC`).map((r) => r.id);
    expect(ids).toEqual(["outer_after", "outer_ok"]);
    expect(db.isInTransaction()).toBe(false);
  });
});
