import { restoreControllerJournalVersion } from "../../helpers/controller-journal-version.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import { controllerExecutionDirectory, controllerPayloadHash, writeLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";

const { orchestrationFixture } = createWebBackendFixtures("file");

const inheritedFixture = async (initial: "dispatching" | "unknown", blocked: boolean) => {
  const f = await orchestrationFixture();
  let task = f.store.beginRecovery(f.task, 11);
  task = f.store.beginWebGeneration(task, { ...f.snapshot, nativeStopped: true }, 12);
  const execution = task.webExecution!;
  const ticket = { ...f.source.ticket, executionGeneration: execution.executionGeneration,
    controllerInstanceId: execution.controllerInstanceId, launchId: execution.launchId, resumeNativeSessionId: f.snapshot.nativeSessionId };
  task = f.store.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.home, ticket),
    launchSubmission: "acknowledged", controllerProcess: f.snapshot.controllerProcess, nativeProcesses: f.snapshot.nativeProcesses, initialInputState: initial }, 13);
  const file = path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite");
  const journal = lifecycle.openControllerLifecycleStore(file, ticket, { onMigration: () => {} });
  journal.patchSnapshot({ lifecycle: "ready", activity: "idle", startup: { state: "ready", reasonCode: "ready" },
    initialInputState: initial, nativeSessionId: f.snapshot.nativeSessionId, controllerProcess: f.snapshot.controllerProcess,
    nativeProcesses: f.snapshot.nativeProcesses, nativeStopped: false, stoppedAt: null, capabilities: { send: true, steer: false, cancel: false, respond: false } });
  // The retained operation predates this Controller ticket; its current journal owner remains generation 2.
  const operation: lifecycle.ControllerOperation = { operationId: ticket.initialOperationId, executionGeneration: "1", kind: "initial",
    payload: { text: ticket.initialPrompt }, payloadHash: controllerPayloadHash({ kind: "initial", payload: { text: ticket.initialPrompt } }),
    state: initial, result: null, error: null, createdAt: 1, updatedAt: 2 };
  const db = new Database(file);
  db.prepare("INSERT INTO operations(id,value) VALUES(?,?)").run(operation.operationId, JSON.stringify(operation));
  f.source.saved.mockRestore();
  vi.mocked(lifecycle.readCompatibleControllerSnapshot).mockRestore();
  f.source.request.mockImplementation(async (_ticket, action) => {
    if (action.kind === "observe") return { requestId: randomUUID(), ok: true, snapshot: journal.getSnapshot(), workerInputProtocol: 1 };
    if (action.kind !== "submit_worker_input") throw new Error("Unexpected input replay or lifecycle change");
    const operation = journal.prepareOperation({ operationId: action.operationId, kind: "worker_input",
      payload: { content: [{ type: "text", text: action.prompt }], expectedTurnId: null, origin: "daynight" } });
    return { requestId: randomUUID(), ok: true, snapshot: journal.getSnapshot(), inputResult: { kind: "operation", operation: journal.recordOperation(operation.operationId, "provider_accepted") } };
  });
  if (blocked) f.store.blockOrchestration(task, { source: "worktree", code: "validation_failed", message: "Temporary worktree deviation." }, 14);
  f.launcher.prepare.mockResolvedValue(ticket);
  f.launcher.launch.mockImplementation(async (current: typeof task) => {
    if (current.webExecution?.launchSubmission !== "acknowledged" || current.webExecution.executionGeneration !== "2") throw new Error("Unexpected native launch");
  });
  const backend = () => createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: f.launcher,
    platform: "windows", buildPrompt: () => "managed", emit: vi.fn(), now: () => 50_000, request: f.source.request });
  const changeOperation = (patch: Partial<lifecycle.ControllerOperation>) => {
    Object.assign(operation, patch);
    db.prepare("UPDATE operations SET value=? WHERE id=?").run(JSON.stringify(operation), ticket.initialOperationId);
  };
  return { ...f, task, ticket, file, journal, db, operation, backend, changeOperation };
};

it.each([
  ["dispatching", true], ["unknown", true], ["dispatching", false], ["unknown", false],
] as const)("retains the recovered execution while inherited %s input settles (blocked=%s), including Worker reconstruction", async (initial, blocked) => {
  const f = await inheritedFixture(initial, blocked);
  try {
    const recovery = f.task.recovery, identity = f.task.webExecution!;
    let backend = f.backend();
    for (let tick = 0; tick < 3; tick++) {
      expect(await backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null)).toMatchObject({ kind: "waiting_input", reason: "native_input" });
      if (tick === 0) {
        if (blocked) { expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled(); }
        backend = f.backend();
      }
    }
    expect(f.store.getOrchestrationBlocker(f.task)).toBeNull();
    expect(f.source.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe", "observe", "observe"]);
    expect(f.store.getTask(f.task)?.recovery).toEqual(recovery);
    expect(f.store.getTask(f.task)?.webExecution).toMatchObject({ executionGeneration: identity.executionGeneration, controllerInstanceId: identity.controllerInstanceId, initialOperationId: identity.initialOperationId });
    f.changeOperation({ state: "provider_accepted" });
    expect(await backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null)).toMatchObject({ kind: "waiting_input" });
    expect(f.source.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe", "observe", "observe", "observe"]);
    f.journal.patchSnapshot({ initialInputState: "provider_accepted" });
    await backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null);
    await backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null);
    const sent = f.source.request.mock.calls.map(([, action]) => action).filter(action => action.kind !== "observe");
    expect(sent).toEqual([expect.objectContaining({ kind: "submit_worker_input", prompt: "managed" })]);
    expect(f.launcher.launch.mock.calls.every(([, observed]) => observed === f.ticket)).toBe(true);
    expect(f.store.getTask(f.task)?.recovery).toEqual(recovery);
    expect(() => lifecycle.readCompatibleControllerOperation(f.file, { ...f.ticket, claimId: randomUUID() }, f.ticket.initialOperationId)).toThrow();
  } finally { f.db.close(); f.journal.close(); }
});

it.each(["missing", "operation", "kind", "hash", "payload", "future", "zero", "unbound", "native", "controller", "process", "stopped", "accepted-regression"] as const)("retains orchestration blocking for inherited %s evidence", async conflict => {
  const f = await inheritedFixture("unknown", true);
  try {
    if (conflict === "missing") f.db.prepare("DELETE FROM operations").run();
    if (conflict === "operation") f.changeOperation({ operationId: randomUUID() });
    if (conflict === "kind") f.changeOperation({ kind: "worker_input" });
    if (conflict === "hash") f.changeOperation({ payloadHash: "a".repeat(64) });
    if (conflict === "payload") f.changeOperation({ payload: { text: "different" } });
    if (conflict === "future") f.changeOperation({ executionGeneration: "3" });
    if (conflict === "zero") f.changeOperation({ executionGeneration: "0" });
    if (conflict === "unbound") { delete f.operation.executionGeneration; f.changeOperation({}); }
    if (conflict === "native") f.source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot: { ...f.journal.getSnapshot(), nativeSessionId: randomUUID() }, workerInputProtocol: 1 });
    if (conflict === "controller") f.source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot: { ...f.journal.getSnapshot(), controllerInstanceId: randomUUID() }, workerInputProtocol: 1 });
    if (conflict === "process") vi.mocked(processProof.inspectProcessProof).mockResolvedValue("replaced");
    if (conflict === "stopped") f.journal.patchSnapshot({ nativeStopped: true });
    if (conflict === "accepted-regression") f.store.updateWebExecution(f.task, { initialInputState: "confirmed" }, 15);
    await expect(f.backend().advanceResult(f.task, new AbortController().signal, undefined, async () => null)).rejects.toThrow();
    expect(f.store.getOrchestrationBlocker(f.task)).not.toBeNull();
    expect(f.source.request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
    expect(f.launcher.launch).not.toHaveBeenCalled();
  } finally { f.db.close(); f.journal.close(); }
});

it.each([16, 17] as const)("reconciles an inherited initial receipt from a live v%s journal without acquiring migration ownership", async version => {
  const f = await inheritedFixture("unknown", true);
  try {
    const pending = f.journal.getSnapshot();
    f.journal.close();
    f.db.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(process.pid);
    restoreControllerJournalVersion(f.db, version);
    f.source.request.mockImplementation(async (_ticket, action) => {
      if (action.kind !== "observe") throw new Error("Unexpected input while observing inherited receipt");
      return { requestId: randomUUID(), ok: true, snapshot: lifecycle.readCompatibleControllerSnapshot(f.file, f.ticket), workerInputProtocol: 1 };
    });
    const backend = f.backend();
    expect(await backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null)).toMatchObject({ kind: "waiting_input" });
    f.changeOperation({ state: "confirmed" });
    f.db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...pending, initialInputState: "confirmed" }));
    expect(await backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null)).toMatchObject({ kind: "observed" });
    expect(f.db.pragma("user_version", { simple: true })).toBe(version);
    expect(f.source.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe", "observe"]);
  } finally { f.db.close(); f.journal.close(); }
});

it("preserves durable process ownership when an accepted receipt refresh changes the Controller proof", async () => {
  const f = await inheritedFixture("unknown", true);
  try {
    const backend = f.backend();
    await backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null);
    const original = f.store.getTask(f.task)!.webExecution!;
    f.changeOperation({ state: "confirmed" });
    const readOperation = lifecycle.readCompatibleControllerOperation;
    vi.spyOn(lifecycle, "readCompatibleControllerOperation").mockImplementation((file, ticket, operationId) => {
      const operation = readOperation(file, ticket, operationId);
      const latest = f.journal.getSnapshot();
      f.db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...latest, initialInputState: "confirmed",
        controllerProcess: { ...latest.controllerProcess!, pid: latest.controllerProcess!.pid + 1 } }));
      return operation;
    });
    await expect(backend.advanceResult(f.task, new AbortController().signal, undefined, async () => null)).rejects.toThrow(/receipt snapshot conflicts/);
    expect(f.store.getTask(f.task)?.webExecution).toMatchObject({ controllerProcess: original.controllerProcess, nativeProcesses: original.nativeProcesses,
      executionGeneration: original.executionGeneration, controllerInstanceId: original.controllerInstanceId });
    expect(f.source.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe", "observe"]);
  } finally { f.db.close(); f.journal.close(); }
});
