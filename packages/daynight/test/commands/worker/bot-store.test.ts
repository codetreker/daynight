import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { Bot } from "../../../src/commands/worker/bots/types.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { bot, cleanupBotStores, createBotStoreFixture, handles, id, owner } from "./bot-store.fixtures.js";

const fixture = () => createBotStoreFixture(() => createMemoryDatabase());
afterEach(cleanupBotStores);

describe("durable Bot inventory", () => {
  it("keeps Bot records out of task inventory and cleanup budget", () => {
    const f = fixture(); const worker = openWorkerStore(f.database, { onMigration: () => {} }); handles.push(worker);
    worker.registerProject({ projectId: id(4), repoUrl: "https://example.test/repo", localPath: f.home });
    const claim = { projectId: id(4), taskId: id(5), claimId: id(6), agent: "codex" as const };
    worker.registerPending(claim); worker.saveCleanupSchedule({ ...claim, worktreeId: id(7) }, { deadline: 100, failures: 2, nextAttemptAt: 50, stage: "archive", lastError: "retained" });
    const before = { tasks: worker.listUnfinishedTasks(), cleanup: worker.listCleanupSchedules() };
    f.store.observe(owner, bot(), 1); f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    expect({ tasks: worker.listUnfinishedTasks(), cleanup: worker.listCleanupSchedules() }).toEqual(before);
    expect(f.store.list(owner)).toHaveLength(1);
  });

  it("preserves frozen definition and launch responsibility under deletion projection", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    const deletion: Bot = { id: id(3), workerId: owner.workerId, version: "2", deletion: { deletionId: id(8), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
    f.store.observe(owner, deletion, 2);
    expect(f.store.get(owner, id(3))).toMatchObject({ definition: bot(), intent, observed: deletion });
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/delet/);
    expect(() => f.store.observe(owner, { ...bot(), version: "3" }, 3)).toThrow(/delet/);
  });

  it("rejects owner, configuration, stale-version and stable-session conflicts", () => {
    const f = fixture(); const original = bot(); f.store.observe(owner, original, 1);
    expect(() => f.store.observe(owner, { ...original, ownerUserId: id(9) } as Bot, 2)).toThrow(/owner/i);
    if (original.deletion !== null) throw new Error("fixture");
    expect(() => f.store.observe(owner, { ...original, version: "2", resolvedConfiguration: { ...original.resolvedConfiguration, cwd: "/different" } }, 2)).toThrow(/configuration/);
    f.store.observe(owner, { ...original, version: "2", sessionId: id(10), testExecutionId: id(11) }, 2);
    expect(() => f.store.observe(owner, original, 3)).toThrow(/version/);
    expect(() => f.store.observe(owner, { ...original, version: "3", sessionId: id(12), testExecutionId: id(11) }, 3)).toThrow(/session/i);
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/existing|bound/i);
    expect(f.store.list({ ...owner, ownerUserId: id(9) })).toEqual([]);
  });

  it("refuses malformed observations and a changed open database format without altering inventory", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1); const before = f.store.get(owner, id(3));
    for (const changed of [{ version: "9007199254740993.0" }, { workerId: id(9) }, { sessionId: id(10), testExecutionId: null }]) {
      expect(() => f.store.observe(owner, { ...bot(), ...changed } as Bot, 2)).toThrow();
      expect(f.store.get(owner, id(3))).toEqual(before);
    }
    const db = f.database; db.pragma(`user_version = ${currentSqliteVersion(workerStoreFormat) + 1}`);
    expect(() => f.store.observe(owner, { ...bot(), version: "2" }, 2)).toThrow(/unsupported-version/);
    expect(() => f.store.list(owner)).toThrow(/unsupported-version/);
    db.pragma(`user_version = ${currentSqliteVersion(workerStoreFormat)}`); expect(f.store.get(owner, id(3))).toEqual(before);
  });
});

describe("Bot deletion responsibility", () => {
  it("rejects stale intent and replacement deletion identity without modifying progress",()=>{
    const f=fixture();const initial=f.store.observe(owner,bot(),1);
    f.store.prepare(owner,id(3),{homeDirectory:f.home,recoveryLimit:3});
    const deleted:Bot={id:id(3),workerId:owner.workerId,version:"2",deletion:{deletionId:id(8),requestedVersion:"1",workerCleanup:{state:"pending",code:null},serverCleanup:{state:"pending",code:null}}};
    const record=f.store.observe(owner,deleted,2);
    expect(()=>f.store.prepareDeletion({...record,intent:initial.intent},null,[])).toThrow(/intent|identity/);
    expect(()=>f.store.prepareDeletion(record,null,[])).toThrow(/stop proof/);
    // Retain the uncertain registration identity rather than erase it.
    expect(f.store.get(owner,id(3))?.intent).toEqual(record.intent);
    const prepared=record;
    expect(()=>f.store.finishDeletion({...prepared,observed:{...deleted,deletion:{...deleted.deletion!,deletionId:id(9)}}})).toThrow(/identity/);
    expect(f.store.get(owner,id(3))?.cleanup).toEqual(prepared.cleanup);
  });
});
