import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSqliteImmediate } from "../../src/platform/sqlite-access.js";
import { createMemoryDatabase } from "../helpers/sqlite.js";

const connections = new Set<Database.Database>();
const connect = (): Database.Database => { const db = createMemoryDatabase(); connections.add(db); return db; };
afterEach(() => { vi.restoreAllMocks(); for (const db of connections) if (db.open) db.close(); connections.clear(); });

describe("manual SQLite migration transactions", () => {
  it("rejects nesting and asynchronous callback results", () => {
    const db = connect();
    expect(() => runSqliteImmediate(db, () => Promise.resolve(1))).toThrow("must be synchronous"); expect(db.inTransaction).toBe(false);
    db.exec("BEGIN"); expect(() => runSqliteImmediate(db, () => 1)).toThrow("cannot nest"); db.exec("ROLLBACK");
  });
  it("preserves the original error together with a rollback failure", () => {
    const db = connect(), primary = new Error("action failed"), rollback = new Error("rollback failed"), exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { if (sql === "ROLLBACK") throw rollback; return exec.call(this, sql); });
    try { runSqliteImmediate(db, () => { throw primary; }); expect.unreachable(); } catch (error) { expect((error as AggregateError).errors).toEqual([primary, rollback]); }
  });
});
