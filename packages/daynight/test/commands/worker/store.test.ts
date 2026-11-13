import { loadSqliteSequence, sqliteSchemaSnapshots } from "../../../src/platform/sqlite-sql.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorkerStore, type WorkerStore } from "../../../src/commands/worker/store.js";
import type { ClaimIdentity, WorkerProject } from "../../../src/commands/worker/types.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { recordedHerdrTools } from "./herdr-tool-snapshot.fixtures.js";

const stores = new Set<WorkerStore>();
const connections = new Set<Database.Database>();
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const claim: ClaimIdentity = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3) };
const memory = () => { const database = createMemoryDatabase(); connections.add(database); return database; };
const open = (database: Database.Database): WorkerStore => { const store = openWorkerStore(database, { onMigration: () => {} }); stores.add(store); return store; };
const identityFixture = () => {
  const directory = path.resolve(".tmp", "worker-store-fixture");
  const project: WorkerProject = { projectId: claim.projectId, repoUrl: "https://github.com/owner/repo.git", localPath: path.join(directory, "repo") };
  return { directory, project };
};
const fixture = () => {
  const { directory, project } = identityFixture(), database = memory(), store = open(database);
  const register = () => { store.registerProject(project); return store.registerPending({ ...claim, agent: "codex" }); };
  return { directory, database, store, project, register };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  for (const connection of connections) if (connection.open) connection.close();
  connections.clear();
});

describe("minimal worker SQLite schema", () => {
  it("enforces state, agent, nullability and composite identity in actual SQLite", () => {
    const { database, register } = fixture();
    register();
    expect(database.prepare("SELECT status, agent, session_id FROM tasks").get()).toEqual({ status: "pending", agent: "codex", session_id: null });
    expect(() => database.exec("UPDATE tasks SET status = 'cleaning'")).toThrow("CHECK constraint failed");
    expect(() => database.exec("UPDATE tasks SET agent = 'other'")).toThrow("CHECK constraint failed");
    expect(() => database.exec("UPDATE tasks SET claim_id = NULL")).toThrow("NOT NULL constraint failed");
    expect(() => database.exec("INSERT INTO tasks SELECT * FROM tasks")).toThrow("UNIQUE constraint failed");
    expect(() => database.exec("UPDATE tasks SET session_id = 42")).not.toThrow();
    expect(() => database.exec("UPDATE tasks SET session_id = NULL")).not.toThrow();
  });

  it("exposes invalid paths and connection options before opening a database", () => {
    const { database } = fixture();
    expect(() => openWorkerStore("relative.sqlite")).toThrow("must be absolute");
    for (const busyTimeoutMs of [0, -1, 1.5, 60_001, Number.NaN]) expect(() => openWorkerStore(database, { busyTimeoutMs })).toThrow("safe integer");
  });
});

describe("worker project mappings", () => {
  it("requires an actual project mapping before materializing its claim", () => {
    const { store, register, project } = fixture();
    expect(() => store.registerPending({ ...claim, agent: "codex" })).toThrow("project repository binding");
    register();
    expect(store.getProject(claim)).toEqual(project);
    expect(store.listProjects()).toEqual([project]);
  });

  it("keeps unfinished repository bindings stable and permits changes after cleanup", () => {
    const { directory, store, register, project } = fixture();
    register();
    expect(store.registerProject(project)).toEqual(project);
    const replacement = { ...project, repoUrl: "https://github.com/other/repo.git", localPath: path.join(directory, "other") };
    expect(() => store.registerProject(replacement)).toThrow("unfinished execution");
    store.activateTask(claim);
    expect(() => store.registerProject(replacement)).toThrow("unfinished execution");
    store.completeTask(claim);
    expect(store.registerProject(replacement)).toEqual(replacement);
  });

  it("validates identities, repository text and physical path input", () => {
    const { store, project } = fixture();
    expect(() => store.registerProject({ ...project, projectId: "bad" })).toThrow("UUID");
    expect(() => store.registerProject({ ...project, repoUrl: " " })).toThrow("nonempty");
    expect(() => store.registerProject({ ...project, localPath: "relative" })).toThrow("absolute");
    expect(store.getProject(project)).toBeNull();
  });
});

describe("worker claim and native session index", () => {
  it("keeps both Herdr and native recipes across reopening without adopting a replacement", () => {
    const { store, database, register } = fixture(); register();
    const tools = recordedHerdrTools();
    const configuration = { agent: "codex" as const, model: null, args: [], toolLaunch: tools.agent, toolObservation: tools.agentObservation, herdrLaunch: tools.herdr, herdrObservation: tools.herdrObservation };
    store.freezeNativeConfiguration(claim, configuration);
    const reopened = open(database);
    expect(reopened.getNativeConfiguration(claim)).toEqual(configuration);
    expect(() => reopened.freezeNativeConfiguration(claim, { ...configuration, herdrLaunch: { ...tools.herdr, source: "path" } })).toThrow("frozen");
  });
  it("persists the original native tuple and rejects a replacement after reopening", () => {
    const { store, database, register } = fixture();
    register();
    const native = { agent: "codex" as const, model: "original", args: ["-c", 'model_reasoning_effort="high"'], validateNativeSelection: true as const };
    store.freezeNativeConfiguration(claim, native);
    native.args.push("--search");
    const reopened = open(database);
    expect(reopened.getNativeConfiguration(claim)).toEqual({ agent: "codex", model: "original", args: ["-c", 'model_reasoning_effort="high"'], validateNativeSelection: true });
    expect(() => reopened.freezeNativeConfiguration(claim, { ...native, model: "replacement" })).toThrow("frozen");
    expect(reopened.getNativeConfiguration({ ...claim, claimId: uuid(99) })).toBeNull();
  });

  it("does not invent a frozen tuple for a legacy native session", () => {
    const { store, register } = fixture(); register(); store.setSessionId(claim, uuid(8));
    expect(store.getNativeConfiguration(claim)).toBeNull();
    expect(() => store.freezeNativeConfiguration(claim, { agent: "codex", model: "current", args: [] })).toThrow("native session");
  });

  it("materializes a pending claim without a session and preserves repeated registration", () => {
    const { store, register } = fixture();
    expect(register()).toEqual({ ...claim, status: "pending", agent: "codex", agentControlMode: "herdr" as const, sessionId: null });
    store.activateTask(claim);
    store.setSessionId(claim, uuid(8));
    expect(store.registerPending({ ...claim, agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(9) })).toEqual({ ...claim, status: "active", agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(8) });
    expect(() => store.registerPending({ ...claim, agent: "copilot" })).toThrow("different agent");
  });

  it("isolates active slots by project and task", () => {
    const { store, project, register } = fixture();
    register();
    const anotherTask = { ...claim, taskId: uuid(10), agent: "codex" as const };
    const anotherProject = { ...claim, projectId: uuid(11), agent: "copilot" as const };
    store.registerProject({ ...project, projectId: anotherProject.projectId });
    store.registerPending(anotherTask);
    store.registerPending(anotherProject);
    for (const identity of [claim, anotherTask, anotherProject]) expect(store.activateTask(identity).status).toBe("active");
    expect(store.listUnfinishedTasks()).toHaveLength(3);
  });

  it("retains completed rows and never silently reactivates them", () => {
    const { store, register } = fixture();
    register();
    expect(store.completeTask(claim).status).toBe("done");
    expect(store.completeTask(claim).status).toBe("done");
    expect(store.registerPending({ ...claim, agent: "codex" }).status).toBe("done");
    expect(() => store.activateTask(claim)).toThrow("already done");
    expect(() => store.setSessionId(claim, uuid(8))).toThrow("already done");
    expect(store.listUnfinishedTasks()).toEqual([]);
    expect(store.listTasks()).toHaveLength(1);
  });

  it("reports missing or malformed task identities", () => {
    const { store, register } = fixture();
    expect(store.getTask(claim)).toBeNull();
    expect(() => store.activateTask(claim)).toThrow("not registered");
    expect(() => store.completeTask(claim)).toThrow("not registered");
    expect(() => store.setSessionId(claim, uuid(8))).toThrow("not registered");
    register();
    expect(() => store.getTask({ ...claim, taskId: "bad" })).toThrow("UUID");
    expect(() => store.registerPending({ ...claim, claimId: "bad", agent: "codex" })).toThrow("UUID");
    expect(() => store.registerPending({ ...claim, agent: "codex", agentControlMode: "herdr" as const, sessionId: "bad" })).toThrow("UUID");
  });
});

it("rebuilds the current seven-column layout when its stored version is zero", () => {
  const { database: db, store, register } = fixture();
  register(); store.activateTask(claim); store.setSessionId(claim, uuid(30));
  db.pragma("user_version = 0");
  const rebuilt = open(db);
  expect(rebuilt.listProjects()).toEqual([]);
  expect(rebuilt.listTasks()).toEqual([]);
  expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
});

it("rebuilds an unknown unversioned schema containing duplicate identities and invalid payloads", () => {
  const db = memory();
  db.exec("CREATE TABLE tasks(task_id TEXT, payload TEXT); CREATE TABLE unrelated(value TEXT); INSERT INTO tasks VALUES('duplicate', 'not json'), ('duplicate', 'also invalid'); INSERT INTO unrelated VALUES('discarded'); PRAGMA user_version = 0");
  const rebuilt = open(db);
  expect(rebuilt.listProjects()).toEqual([]);
  expect(rebuilt.listTasks()).toEqual([]);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()).toEqual(sqliteSchemaSnapshots(loadSqliteSequence(new URL("../../../src/commands/worker/sqlite/", import.meta.url))).get(currentSqliteVersion(workerStoreFormat))!.filter(object => object.type === "table").map(({ name }) => ({ name })));
  expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
});

it("upgrades version 15 without inventing claim reservations or changing frozen recipes", () => {
  const db = memory(), steps = loadSqliteSequence(new URL("../../../src/commands/worker/sqlite/", import.meta.url));
  for (const step of steps.filter(step => step.version <= 15)) db.exec(step.sql);
  db.pragma("user_version = 15");
  const { project } = identityFixture(), tools = recordedHerdrTools();
  const configuration = JSON.stringify({ agent: "codex", model: "original", args: ["--original"], toolLaunch: tools.agent, toolObservation: tools.agentObservation, herdrLaunch: tools.herdr, herdrObservation: tools.herdrObservation });
  db.prepare("INSERT INTO projects(project_id, repo_url, local_path) VALUES (@projectId, @repoUrl, @localPath)").run(project);
  db.prepare("INSERT INTO tasks(project_id, task_id, claim_id, status, agent, session_id, agent_control_mode) VALUES (@projectId, @taskId, @claimId, 'active', 'codex', NULL, 'herdr')").run(claim);
  db.prepare("INSERT INTO claim_native_configurations(project_id, task_id, claim_id, configuration) VALUES (@projectId, @taskId, @claimId, @configuration)").run({ ...claim, configuration });
  const upgraded = open(db);
  expect(upgraded.listClaimToolReservations()).toEqual([]);
  expect(upgraded.getTask(claim)?.status).toBe("active");
  expect(upgraded.getNativeConfiguration(claim)).toEqual(JSON.parse(configuration));
  expect(db.prepare("SELECT configuration FROM claim_native_configurations").get()).toEqual({ configuration });
  expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
});

it("fences an open worker connection before writing a subsequently changed format", () => {
  const { database: db, store, register } = fixture(); register(); db.pragma(`user_version = ${currentSqliteVersion(workerStoreFormat) + 1}`);
  expect(() => store.activateTask(claim)).toThrow("unsupported-version");
  expect(() => store.getTask(claim)).toThrow("unsupported-version");
  expect(db.prepare("SELECT status FROM tasks").get()).toEqual({ status: "pending" });
});

describe("worker cleanup schedules", () => {
  const owner = { ...claim, worktreeId: uuid(70) };
  const schedule = { deadline: 600_000, failures: 2, nextAttemptAt: 12_000, stage: "worktree", lastError: "EACCES: denied" };

  it("validates identities and schedule fields without writing malformed records", () => {
    const f = fixture(); f.register();
    expect(() => f.store.saveCleanupSchedule({ ...owner, worktreeId: "bad" }, schedule)).toThrow("UUID");
    for (const field of ["deadline", "failures", "nextAttemptAt"] as const) {
      for (const value of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => f.store.saveCleanupSchedule(owner, { ...schedule, [field]: value })).toThrow("safe integer");
      }
    }
    expect(() => f.store.saveCleanupSchedule(owner, { ...schedule, stage: " " })).toThrow("nonempty");
    expect(f.store.listCleanupSchedules()).toEqual([]);
  });

  it("retains the original repository mapping while cleanup is outstanding", () => {
    const f = fixture(); f.register(); f.store.completeTask(claim);
    f.store.saveCleanupSchedule(owner, schedule);
    expect(() => f.store.registerProject({ ...f.project, localPath: path.join(f.directory, "replacement") })).toThrow("cleanup");
    f.store.deleteCleanupSchedule(owner);
    expect(f.store.registerProject({ ...f.project, localPath: path.join(f.directory, "replacement") }).localPath).toContain("replacement");
  });

  it("enforces scheduler bounds in SQLite and rejects corrupt schedules on read", () => {
    const f = fixture(); f.register(); f.store.saveCleanupSchedule(owner, schedule);
    const db = f.database;
    expect(() => db.exec("UPDATE cleanup_schedules SET failures = -1")).toThrow("CHECK constraint failed");
    expect(() => db.exec("UPDATE cleanup_schedules SET next_attempt_at = -1")).toThrow("CHECK constraint failed");
    expect(() => db.exec("UPDATE cleanup_schedules SET deadline = 9007199254740992")).toThrow("CHECK constraint failed");
    db.exec("UPDATE cleanup_schedules SET worktree_id = 'invalid'");
    expect(() => f.store.getCleanupSchedule(owner)).toThrow("UUID");
  });

  it("migrates version six by discarding operation flags and preserving resource identity and retry policy", () => {
    const f = identityFixture(), db = memory();
    for (const filename of ["005-baseline.sql", "006-cleanup-schedules.sql"]) db.exec(readFileSync(new URL(`../../../src/commands/worker/sqlite/${filename}`, import.meta.url), "utf8"));
    db.pragma("user_version = 6");
    db.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(f.project.projectId, f.project.repoUrl, f.project.localPath);
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, 'active', 'codex', ?, 'herdr')").run(claim.projectId, claim.taskId, claim.claimId, uuid(75));
    db.prepare("INSERT INTO cleanup_schedules VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)").run(owner.projectId, owner.taskId, owner.claimId, owner.worktreeId, schedule.deadline, schedule.failures, schedule.nextAttemptAt, schedule.stage, schedule.lastError);
    const recovered = open(db);
    expect(recovered.getCleanupSchedule(owner)).toEqual({ ...owner, ...schedule });
    expect(recovered.getTask(claim)).toMatchObject({ status: "active", sessionId: uuid(75) });
    expect((db.pragma("table_info(cleanup_schedules)") as { name: string }[]).map(column => column.name)).not.toContain("submitted");
    expect((db.pragma("table_info(cleanup_schedules)") as { name: string }[]).map(column => column.name)).not.toContain("notified");
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
  });

  it("upgrades version five while retaining every original claim and project", () => {
    const f = identityFixture(), db = memory();
    db.exec(readFileSync(new URL("../../../src/commands/worker/sqlite/005-baseline.sql", import.meta.url), "utf8"));
    db.pragma("user_version = 5");
    db.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(f.project.projectId, f.project.repoUrl, f.project.localPath);
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, 'active', 'codex', ?, 'herdr')").run(claim.projectId, claim.taskId, claim.claimId, uuid(75));
    const recovered = open(db);
    expect(recovered.getProject(claim)).toEqual(f.project);
    expect(recovered.getTask(claim)).toMatchObject({ ...claim, status: "active", sessionId: uuid(75) });
    expect(recovered.listCleanupSchedules()).toEqual([]);
    recovered.saveCleanupSchedule(owner, schedule);
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
  });
});
