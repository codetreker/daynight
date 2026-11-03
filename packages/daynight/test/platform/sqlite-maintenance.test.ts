import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireMaintenanceLock } from "../../src/platform/instance-lock.js";

const temporary = fileURLToPath(new URL("../../../../.tmp/sqlite-maintenance-tests/", import.meta.url));
const directories: string[] = [], connections = new Set<Database.Database>();
const fixture = () => { mkdirSync(temporary, { recursive: true }); const dir = mkdtempSync(path.join(temporary, "lock-")); directories.push(dir); return { lockFile: path.join(dir, "instance.lock"), ownershipGateFile: path.join(dir, "gate.sqlite"), gateFileMustExist: false }; };
afterEach(() => { vi.restoreAllMocks(); for (const db of connections) if (db.open) db.close(); connections.clear(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("SQLite maintenance ownership", () => {
  it("creates a live own record and releases only that record idempotently", () => {
    const paths = fixture(), permit = acquireMaintenanceLock(paths);
    expect(JSON.parse(readFileSync(paths.lockFile, "utf8"))).toMatchObject({ owner: permit.owner, pid: process.pid });
    permit.release(); permit.release(); expect(existsSync(paths.lockFile)).toBe(false);
  });
  it.each([JSON.stringify({ owner: "live", pid: process.pid, startedAt: new Date().toISOString() }), JSON.stringify({ owner: "dead", pid: 2147483647, startedAt: "2000-01-01T00:00:00Z" }), "bad JSON", ""])("preserves any existing owner without process probing: %s", value => {
    const paths = fixture(); writeFileSync(paths.lockFile, value); const probe = vi.spyOn(process, "kill");
    expect(() => acquireMaintenanceLock(paths)).toThrow("existing instance lock"); expect(readFileSync(paths.lockFile, "utf8")).toBe(value); expect(probe).not.toHaveBeenCalled();
  });
  it("also preserves a directory in place of lock metadata", () => {
    const paths = fixture(); mkdirSync(paths.lockFile); expect(() => acquireMaintenanceLock(paths)).toThrow("existing instance lock"); expect(existsSync(paths.lockFile)).toBe(true);
  });
  it.skipIf(process.platform === "win32")("does not replace a dangling lock symlink", () => {
    const paths = fixture(); symlinkSync(path.join(path.dirname(paths.lockFile), "missing"), paths.lockFile); expect(() => acquireMaintenanceLock(paths)).toThrow("existing instance lock");
  });
  it("will not unlink a replacement owner", () => {
    const paths = fixture(), permit = acquireMaintenanceLock(paths); writeFileSync(paths.lockFile, "replacement"); expect(() => permit.release()).toThrow("no longer belongs"); expect(readFileSync(paths.lockFile, "utf8")).toBe("replacement");
  });
  it("closes a gate sharing the business file before returning maintenance permission", () => {
    const paths = fixture(); const gate = new Database(paths.ownershipGateFile); gate.close();
    const permit = acquireMaintenanceLock({ ...paths, gateFileMustExist: true });
    const db = new Database(paths.ownershipGateFile, { timeout: 1 }); connections.add(db);
    expect(() => db.exec("BEGIN IMMEDIATE; CREATE TABLE records(id INTEGER); COMMIT")).not.toThrow(); db.close(); permit.release();
  });
  it("does not recreate a missing business ownership gate", () => {
    const paths = fixture(); expect(() => acquireMaintenanceLock({ ...paths, gateFileMustExist: true })).toThrow(); expect(existsSync(paths.ownershipGateFile)).toBe(false); expect(existsSync(paths.lockFile)).toBe(false);
  });
  it("retains its new lock when acquisition gate close is unknown", () => {
    const paths = fixture(), close = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function(this: Database.Database) { connections.add(this); if (this.name === paths.ownershipGateFile) throw new Error("gate close failed"); return close.call(this); });
    expect(() => acquireMaintenanceLock(paths)).toThrow("gate close failed"); expect(existsSync(paths.lockFile)).toBe(true);
  });
  it("confirms release gate close before unlinking the live own record", () => {
    const paths = fixture(), permit = acquireMaintenanceLock(paths), before = readFileSync(paths.lockFile, "utf8"), close = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function(this: Database.Database) { connections.add(this); if (this.name === paths.ownershipGateFile) throw new Error("release close failed"); return close.call(this); });
    expect(() => permit.release()).toThrow("release close failed"); expect(readFileSync(paths.lockFile, "utf8")).toBe(before);
  });
});
