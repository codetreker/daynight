import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import type { Bot } from "../../../src/commands/worker/bots/types.js";

import { bot, cleanupBotStores, createBotStoreFixture, dirs, handles, id, owner, root } from "./bot-store.fixtures.js";

const fixture = () => createBotStoreFixture(home => path.join(home, "state.sqlite"));
afterEach(cleanupBotStores);

describe("Bot inventory file persistence", () => {
  it("retains one launch and registration intent across reopen and observation version changes", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    expect(intent.registration).toMatchObject({ initialInput: "none", protocol: "daynight.session.v1", provider: "codex" });
    expect(intent.botVersion).toBe("1");
    expect(intent.sessionId).toBeNull();
    expect(intent.executionId).toBe(intent.registration.testExecutionId);
    expect(intent.journalPath).toContain(intent.executionId);
    const reopened = f.open(); reopened.observe(owner, { ...bot(), version: "2" }, 2);
    expect(reopened.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 99 })).toEqual(intent);
    expect(reopened.get(owner, id(3))?.observed.version).toBe("2");
  });
  it("freezes local role before registration and rejects remote role disagreement", () => {
    const f = fixture(); const original = bot(); f.store.observe(owner, original, 1);
    f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    const role = { instructions: "Use Daynight CLI.", revision: "1", digest: createHash("sha256").update("Use Daynight CLI.").digest("hex") };
    f.store.freezeRole(owner, id(3), role);
    expect(f.open().get(owner, id(3))?.intent?.roleConfiguration).toEqual(role);
    f.store.freezeRole(owner, id(3), role);
    expect(() => f.store.freezeRole(owner, id(3), { ...role, revision: "2" })).toThrow(/role/i);
    expect(() => f.store.observe(owner, { ...original, version: "2", roleConfiguration: { ...role, revision: "2" } } as Bot, 2)).toThrow(/role/i);
  });
  it("binds the service-issued session to the original registration without replacing its request version", () => {
    const f = fixture(); const original = bot(); f.store.observe(owner, original, 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    f.store.observe(owner, { ...original, version: "2", sessionId: id(10), testExecutionId: intent.registration.testExecutionId } as Bot, 2);
    expect(f.open().get(owner, id(3))?.intent).toEqual({ ...intent, sessionId: id(10) });
    const before = f.store.get(owner, id(3));
    expect(() => f.store.observe(owner, { ...original, version: "3", sessionId: id(10), testExecutionId: id(11) } as Bot, 3)).toThrow(/session|execution/i);
    expect(f.store.get(owner, id(3))).toEqual(before);
  });
  it("retains deletion-only responsibility without inventing a launch or original definition", () => {
    const f = fixture();
    const deletion: Bot = { id: id(3), workerId: owner.workerId, version: "2", deletion: { deletionId: id(8), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "completed", code: null } } };
    expect(f.store.observe(owner, deletion, 1)).toMatchObject({ definition: null, intent: null, observed: deletion });
    expect(f.open().list(owner)).toHaveLength(1);
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/delet/);
  });
  it("rolls back the Bot migration atomically without changing old task records", () => {
    mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "migration-")); dirs.push(home);
    const file = path.join(home, "state.sqlite"); const db = new Database(file); handles.push(db);
    for (const name of ["005-baseline.sql", "006-cleanup-schedules.sql", "007-resource-cleanup-intent.sql"]) db.exec(readFileSync(new URL(`../../../src/commands/worker/sqlite/${name}`, import.meta.url), "utf8"));
    db.pragma("user_version = 7"); db.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(id(4), "https://example.test/repo", home);
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, 'active', 'codex', ?, 'web')").run(id(4), id(5), id(6), id(7));
    db.prepare("INSERT INTO cleanup_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id(4), id(5), id(6), id(8), 500, 2, 300, "archive", "retained");
    const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const rows = ["projects", "tasks", "cleanup_schedules"].map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { const result = exec.call(this, sql); if (sql.includes("CREATE TABLE bots")) throw new Error("injected migration failure"); return result; });
    expect(() => openBotStore(file, { onMigration: () => {} })).toThrow(/migration/);
    expect(db.pragma("user_version", { simple: true })).toBe(7);
    expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(["projects", "tasks", "cleanup_schedules"].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(rows);
  });
  it("retains stop and per-path progress across observation and reopen, then atomically strips private execution", () => {
    const f=fixture();f.store.observe(owner,bot(),1);
    const deleted:Bot={id:id(3),workerId:owner.workerId,version:"2",deletion:{deletionId:id(8),requestedVersion:"1",workerCleanup:{state:"pending",code:null},serverCleanup:{state:"pending",code:null}}};
    const record=f.store.observe(owner,deleted,2);
    const target={path:path.join(f.home,"private"),root:f.home,kind:"file" as const,identity:"1:2",rootIdentity:"1:1",completed:false};
    const prepared=f.store.prepareDeletion(record,null,[target]);
    expect(prepared.cleanup).toMatchObject({deletionId:id(8),localCompleted:false,targets:[target]});
    expect(()=>f.store.finishDeletion(prepared)).toThrow(/remaining|incomplete/);
    f.store.completeDeletionTarget(prepared,target.path);
    const reopened=f.open();const observed=reopened.observe(owner,{...deleted,version:"3"},3);
    expect(observed.cleanup?.targets[0]?.completed).toBe(true);
    const finished=reopened.finishDeletion(observed);
    expect(finished).toMatchObject({intent:null,definition:null,cleanup:{localCompleted:true,targets:[],stop:null}});
    expect(reopened.observe(owner,{...deleted,version:"4"},4).cleanup).toEqual(finished.cleanup);
    expect(()=>reopened.prepare(owner,id(3),{homeDirectory:f.home,recoveryLimit:3})).toThrow(/delet/);
  });
});
