import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Task, WorkerClaim } from "../../../src/api/types.js";
import { openWorkerStore, type WorkerStore } from "../../../src/commands/worker/store.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { recordedHerdrTools } from "./herdr-tool-snapshot.fixtures.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const connections = new Set<Database.Database>(), stores = new Set<WorkerStore>(), directories = new Set<string>();
const open = (db: Database.Database): WorkerStore => { const store = openWorkerStore(db, { onMigration: () => {} }); stores.add(store); return store; };
const fixture = () => {
  const db = createMemoryDatabase(); connections.add(db);
  const store = open(db), tools = recordedHerdrTools();
  const reservation = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4), workerId: uuid(5), version: 9_007_199_254_740_993n, agentControlMode: "herdr" as const,
    nativeConfiguration: { agent: "codex" as const, model: "original", args: ["--original"], validateNativeSelection: true as const, toolLaunch: tools.agent, toolObservation: tools.agentObservation, herdrLaunch: tools.herdr, herdrObservation: tools.herdrObservation } };
  const project = { projectId: reservation.projectId, repoUrl: "https://github.com/owner/repo.git", localPath: path.resolve(".tmp/reservation-repository") };
  store.registerProject(project);
  const claim: WorkerClaim = { claimId: reservation.claimId, worktreeId: reservation.worktreeId, workerId: reservation.workerId, userId: uuid(6), machine: { id: uuid(7), name: "fixture" }, platform: "macos", agent: "codex", agentControlMode: "herdr", state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-12T00:00:00.000Z" };
  const granted = (worker: Partial<WorkerClaim> = {}, task: Partial<Task> = {}): Task => ({ id: reservation.taskId, projectId: reservation.projectId, type: "task", parentId: null, title: "Claim fixture", description: "", status: "in_progress", allowAgents: true, requiredPlatform: null, assignedTo: null, startedAt: null, completedAt: null, cancelledAt: null, version: reservation.version + 1n,
    properties: { worker: { ...claim, ...worker } }, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", tags: [], dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, ...task });
  return { db, store, reservation, project, granted };
};
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const db of connections) if (db.open) db.close(); connections.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.clear();
});

describe("claim tool reservations", () => {
  it("retains an unknown claim's exact BigInt version and tool selection across reopening without registering a task", () => {
    const { db, store, reservation } = fixture(), expected = structuredClone(reservation);
    const returned = store.reserveClaimTools(reservation);
    expect(returned).toEqual(expected);
    (returned.nativeConfiguration.args as string[]).push("--changed-return-value");
    reservation.nativeConfiguration.args.push("--changed-after-reserve");
    const reopened = open(db);
    expect(reopened.getClaimToolReservation(expected)).toEqual(expected);
    expect(reopened.listClaimToolReservations()).toEqual([expected]);
    expect(reopened.getTask(expected)).toBeNull();
    expect(reopened.getNativeConfiguration(expected)).toBeNull();
    expect(reopened.listUnfinishedTasks()).toEqual([]);
    expect(db.prepare("SELECT task_version AS version, typeof(task_version) AS type FROM claim_tool_reservations").get()).toEqual({ version: "9007199254740993", type: "text" });
    expect(reopened.reserveClaimTools(expected)).toEqual(expected);
  });

  it("keeps an unresolved reservation when the database is closed and opened from disk", () => {
    const { reservation, project } = fixture(), scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(path.join(scratch, "claim-reservation-")); directories.add(directory);
    const file = path.join(directory, "worker.sqlite");
    const initial = openWorkerStore(file, { onMigration: () => {} });
    try { initial.registerProject(project); initial.reserveClaimTools(reservation); }
    finally { initial.close(); }
    const reopened = openWorkerStore(file); stores.add(reopened);
    expect(reopened.listClaimToolReservations()).toEqual([reservation]);
    expect(reopened.listTasks()).toEqual([]);
    expect(reopened.getNativeConfiguration(reservation)).toBeNull();
  });

  it.each(["claimId", "worktreeId", "workerId", "version", "agentControlMode", "nativeConfiguration"] as const)("refuses to replace an unknown request's %s", field => {
    const { store, reservation } = fixture(); store.reserveClaimTools(reservation);
    const changed = { ...reservation, [field]: field === "version" ? reservation.version + 1n : field === "agentControlMode" ? "web" : field === "nativeConfiguration" ? { ...reservation.nativeConfiguration, model: "replacement" } : uuid(99) };
    expect(() => store.reserveClaimTools(changed)).toThrow();
    expect(store.listClaimToolReservations()).toEqual([reservation]);
    expect(store.getTask(reservation)).toBeNull();
  });

  it("atomically transfers a matching active grant into pending with the reserved configuration", () => {
    const { db, store, reservation, granted } = fixture(); store.reserveClaimTools(reservation);
    const reopened = open(db), local = reopened.acceptClaimToolReservation(granted(), reservation.workerId);
    expect(local).toEqual({ projectId: reservation.projectId, taskId: reservation.taskId, claimId: reservation.claimId, status: "pending", agent: "codex", agentControlMode: "herdr", sessionId: null });
    expect(reopened.getNativeConfiguration(reservation)).toEqual(reservation.nativeConfiguration);
    expect(reopened.listClaimToolReservations()).toEqual([]);
    expect(reopened.acceptClaimToolReservation(granted(), reservation.workerId)).toBeNull();
    expect(open(db).getNativeConfiguration(reservation)).toEqual(reservation.nativeConfiguration);
  });

  it.each(["claimId", "worktreeId", "workerId", "agent", "agentControlMode", "state"] as const)("retains the original reservation when a grant changes %s", field => {
    const { store, reservation, granted } = fixture(); store.reserveClaimTools(reservation);
    const value = field === "agent" ? "copilot" : field === "agentControlMode" ? "web" : field === "state" ? "released" : uuid(99);
    expect(() => store.acceptClaimToolReservation(granted({ [field]: value }), reservation.workerId)).toThrow();
    expect(store.listClaimToolReservations()).toEqual([reservation]);
    expect(store.listTasks()).toEqual([]);
  });

  it.each(["status", "version", "worker"] as const)("does not consume an unconfirmed grant with invalid %s", field => {
    const { store, reservation, granted } = fixture(); store.reserveClaimTools(reservation);
    const task = granted({}, field === "status" ? { status: "todo" } : field === "version" ? { version: reservation.version } : { properties: {} });
    expect(() => store.acceptClaimToolReservation(task, reservation.workerId)).toThrow();
    expect(store.listClaimToolReservations()).toEqual([reservation]);
    expect(store.listTasks()).toEqual([]);
  });

  it.each(["revoked", "paused"] as const)("takes responsibility for the original active grant after it is %s without choosing new tools", state => {
    const { store, reservation, granted } = fixture(); store.reserveClaimTools(reservation);
    const task = granted({}, state === "revoked" ? { allowAgents: false } : {});
    const observed = state === "paused" ? { ...task, properties: { ...task.properties, paused: true } } : task;
    expect(store.acceptClaimToolReservation(observed, reservation.workerId)?.status).toBe("pending");
    expect(store.getNativeConfiguration(reservation)).toEqual(reservation.nativeConfiguration);
    expect(store.listClaimToolReservations()).toEqual([]);
  });

  it("does not consume another worker's or task's reservation", () => {
    const { store, reservation, granted } = fixture(); store.reserveClaimTools(reservation);
    expect(() => store.acceptClaimToolReservation(granted(), uuid(99))).toThrow();
    expect(store.acceptClaimToolReservation(granted({}, { id: uuid(98) }), reservation.workerId)).toBeNull();
    expect(store.acceptClaimToolReservation(granted({}, { projectId: uuid(97) }), reservation.workerId)).toBeNull();
    expect(store.listClaimToolReservations()).toEqual([reservation]);
  });

  it("rolls back pending registration and preserves the reservation when freezing fails", () => {
    const { db, store, reservation, granted } = fixture(); store.reserveClaimTools(reservation);
    // Fail the real SQLite insert after pending registration, rather than mocking the transaction.
    db.exec("CREATE TEMP TRIGGER reject_reserved_freeze BEFORE INSERT ON claim_native_configurations BEGIN SELECT RAISE(ABORT, 'freeze failed'); END");
    expect(() => store.acceptClaimToolReservation(granted(), reservation.workerId)).toThrow("freeze failed");
    expect(store.getTask(reservation)).toBeNull();
    expect(store.getNativeConfiguration(reservation)).toBeNull();
    expect(store.listClaimToolReservations()).toEqual([reservation]);
  });

  it("preserves both tables when deleting the consumed reservation fails", () => {
    const { db, store, reservation, granted } = fixture(); store.reserveClaimTools(reservation);
    db.exec("CREATE TEMP TRIGGER reject_reservation_delete BEFORE DELETE ON claim_tool_reservations BEGIN SELECT RAISE(ABORT, 'delete failed'); END");
    expect(() => store.acceptClaimToolReservation(granted(), reservation.workerId)).toThrow("delete failed");
    expect(store.getTask(reservation)).toBeNull();
    expect(store.getNativeConfiguration(reservation)).toBeNull();
    expect(store.listClaimToolReservations()).toEqual([reservation]);
  });

  it("releases only an exact reservation and does not infer a grant or absence from local tasks", () => {
    const { store, reservation } = fixture(); store.reserveClaimTools(reservation);
    expect(() => store.releaseClaimToolReservation({ ...reservation, version: reservation.version + 1n })).toThrow();
    expect(() => store.releaseClaimToolReservation({ ...reservation, claimId: uuid(98) })).toThrow();
    expect(() => store.releaseClaimToolReservation({ ...reservation, nativeConfiguration: { ...reservation.nativeConfiguration, model: "replacement" } })).toThrow();
    expect(store.listClaimToolReservations()).toEqual([reservation]);
    expect(store.releaseClaimToolReservation(reservation)).toBe(true);
    expect(store.releaseClaimToolReservation(reservation)).toBe(false);
    expect(store.listTasks()).toEqual([]);
  });

  it("protects repository bindings while a claim request is unresolved", () => {
    const { store, reservation, project } = fixture(); store.reserveClaimTools(reservation);
    expect(() => store.registerProject({ ...project, localPath: path.resolve(".tmp/replacement") })).toThrow();
    expect(store.getProject(project)).toEqual(project);
    store.releaseClaimToolReservation(reservation);
    expect(store.registerProject({ ...project, localPath: path.resolve(".tmp/replacement") }).localPath).toBe(path.resolve(".tmp/replacement"));
  });

  it("requires a project and refuses reservation after a claim already materialized", () => {
    const { store, reservation } = fixture();
    expect(() => store.reserveClaimTools({ ...reservation, projectId: uuid(99) })).toThrow();
    store.registerPending({ ...reservation, agent: "codex", nativeConfiguration: reservation.nativeConfiguration });
    expect(() => store.reserveClaimTools(reservation)).toThrow();
    expect(store.listClaimToolReservations()).toEqual([]);
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n, 9007199254740992] as const)("refuses invalid task version %s without creating a reservation", version => {
    const { store, reservation } = fixture();
    // @ts-expect-error Runtime callers must not pass a Number task version.
    expect(() => store.reserveClaimTools({ ...reservation, version })).toThrow();
    expect(store.listClaimToolReservations()).toEqual([]);
  });
});
