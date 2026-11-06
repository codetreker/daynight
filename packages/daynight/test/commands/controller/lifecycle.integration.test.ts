import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readLaunchTicket, writeLaunchTicket, parseLaunchTicket, controllerPayloadHash, controllerExecutionDirectory, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { validateControllerLocalRequest } from "../../../src/commands/controller/local-client.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "worker-managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  return { home, ticket };
};
it("retains unknown dispatch and committed events across restart without replaying the operation", async () => {
  const { home, ticket } = await fixture();
  const directory = controllerExecutionDirectory(home, ticket.executionId); await mkdir(directory, { recursive: true });
  const filename = path.join(directory, "state.sqlite");
  let store = openControllerLifecycleStore(filename, ticket);
  expect(store.getSnapshot().initialInputState).toBe("not_submitted");
  const operation = { operationId: ticket.initialOperationId, kind: "initial" as const, payload: { text: ticket.initialPrompt } };
  expect(store.prepareOperation(operation).state).toBe("accepted");
  store.markDispatching(operation.operationId);
  store.appendEvent({ kind: "native", value: "first" });
  store.close(); store = openControllerLifecycleStore(filename, ticket);
  expect(store.prepareOperation(operation).state).toBe("dispatching");
  expect(() => store.markDispatching(operation.operationId)).toThrow(/replay/);
  expect(() => store.prepareOperation({ ...operation, payload: { text: "changed" } })).toThrow(/different/);
  expect(store.pendingEvents(10)).toMatchObject([{ sequence: "1", payload: { kind: "native", value: "first" } }]);
  store.acknowledgeEvents("1"); expect(store.pendingEvents(10)).toEqual([]);
  store.close();
});
it("persists projection revisions, deduplicates replay and keeps ACK watermark across restart", async () => {
  const { home, ticket } = await fixture(); const filename = path.join(home, "state.sqlite");
  let store = openControllerLifecycleStore(filename, ticket);
  const entry = { entryId: randomUUID(), revision: "7", kind: "assistant_message" as const, content: [{ type: "text" as const, text: "first" }] };
  expect(store.projectTimeline(entry)?.payload).toMatchObject({ kind: "timeline_upsert", payload: { revision: "1" } });
  expect(store.projectTimeline({ ...entry, revision: "99" })).toBeNull();
  expect(store.projectTimeline({ ...entry, content: [{ type: "text", text: "changed" }] })?.payload).toMatchObject({ payload: { revision: "2" } });
  store.acknowledgeEvents("2"); store.acknowledgeEvents("1"); store.close();
  store = openControllerLifecycleStore(filename, ticket);
  expect(store.getLastAcknowledgedSequence()).toBe("2");
  expect(store.projectTimeline({ ...entry, content: [{ type: "text", text: "changed" }] })).toBeNull();
  expect(store.pendingEvents()).toEqual([]); store.close();
});
it("lists durable operations and refuses to reopen an unproven native generation", async () => {
  const { home, ticket } = await fixture(); const filename = path.join(home, "state.sqlite"); const store = openControllerLifecycleStore(filename, ticket);
  store.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: "start" } });
  expect(store.listOperations()).toHaveLength(1);
  store.patchSnapshot({ controllerProcess: { pid: 987654, parentPid: 1, processGroupId: 987654, startedAt: "original", commandHash: "hash" } });
  store.close(); expect(() => openControllerLifecycleStore(filename, ticket)).toThrow(/generation/);
});
it("retains an overflow gap outside the outbox across generations and emits it once after ACK",async()=>{
 const {home,ticket}=await fixture();const file=path.join(home,"state.sqlite");let store=openControllerLifecycleStore(file,ticket,{maxOutboxBytes:512});
 store.appendEvent({text:"a".repeat(470)});
 expect(()=>store.appendEvent({text:"lost native output".repeat(30)})).toThrow(/capacity/);
 store.markProjectionGap("Native projection overflow requires history reload.");
 expect(store.drainProjectionGap()).toBeNull();expect(store.pendingEvents()).toHaveLength(1);
 const nativeId=randomUUID();store.patchSnapshot({nativeSessionId:nativeId,lifecycle:"stopped",nativeStopped:true});store.close();
 const resumed={...ticket,launchId:randomUUID(),controllerInstanceId:randomUUID(),executionGeneration:"2",resumeNativeSessionId:nativeId};
 store=openControllerLifecycleStore(file,resumed,{maxOutboxBytes:512});
 expect(store.drainProjectionGap()).toBeNull();store.acknowledgeEvents("1");
 expect(store.drainProjectionGap()).toMatchObject({sequence:"2",payload:{kind:"gap",payload:{reason:"Native projection overflow requires history reload."}}});
 expect(store.drainProjectionGap()).toBeNull();store.close();store=openControllerLifecycleStore(file,resumed,{maxOutboxBytes:512});
 expect(store.pendingEvents()).toHaveLength(1);expect(store.drainProjectionGap()).toBeNull();store.close();
});
it("seeds control revisions above retained outbox and snapshot revisions across native recovery", async () => {
  const {home,ticket}=await fixture(); const file=path.join(home,"state.sqlite"); let store=openControllerLifecycleStore(file,ticket);
  const controls={revision:"9007199254740993",settings:[],commands:[],settingsError:null,commandsError:null};
  store.patchSnapshot({controls});
  store.appendEvent({kind:"state",payload:{controls:{...controls,revision:"9007199254740995"}}});
  const nativeId=randomUUID();store.patchSnapshot({nativeSessionId:nativeId,lifecycle:"stopped",nativeStopped:true});store.close();
  const resumed={...ticket,launchId:randomUUID(),controllerInstanceId:randomUUID(),executionGeneration:"2",resumeNativeSessionId:nativeId};
  store=openControllerLifecycleStore(file,resumed);
  expect(store.getSnapshot().controls).toBeUndefined();
  expect(store.getSnapshot().controlsRevisionFloor).toBe("9007199254740995");
  expect(store.pendingEvents()).toHaveLength(1);
  store.acknowledgeEvents("1");store.patchSnapshot({nativeSessionId:nativeId,lifecycle:"stopped",nativeStopped:true});store.close();
  store=openControllerLifecycleStore(file,{...resumed,launchId:randomUUID(),controllerInstanceId:randomUUID(),executionGeneration:"3"});
  expect(store.getSnapshot().controlsRevisionFloor).toBe("9007199254740995");store.close();
});

it("loads acknowledged timeline from local storage with stable paging after restart", async () => {
  const { home, ticket } = await fixture(); const file = path.join(home, "content.sqlite");
  let store = openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true });
  const ids = Array.from({ length: 4 }, () => randomUUID());
  ids.forEach((entryId, i) => store.projectTimeline({ entryId, revision: "1", kind: "reasoning", text: `entry ${i}` }));
  store.acknowledgeEvents("4"); store.close();
  store = openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true });
  try {
    const epoch = randomUUID();
    const tail = store.readTimeline({ historyEpoch: epoch, direction: "tail", cursor: null, limit: 2 });
    expect(tail.items.map(entry => entry.entryId)).toEqual(ids.slice(2));
    expect(tail.hasMoreBefore).toBe(true);
    const before = store.readTimeline({ historyEpoch: epoch, direction: "before", cursor: tail.beforeCursor, limit: 2 });
    expect(before.items.map(entry => entry.entryId)).toEqual(ids.slice(0, 2));
    expect(before.hasMoreBefore).toBe(false);
    store.projectTimeline({ entryId: ids[0]!, revision: "1", kind: "reasoning", text: "revised" });
    expect(store.readTimeline({ historyEpoch: epoch, direction: "tail", cursor: null, limit: 4 }).items[0]).toMatchObject({ entrySeq: "1", revision: "2", text: "revised" });
    expect(() => store.readTimeline({ historyEpoch: randomUUID(), direction: "before", cursor: tail.beforeCursor, limit: 2 })).toThrow(/cursor/i);
  } finally { store.close(); }
});

it.each(["task", "test"])("preserves the original %s ticket bytes and journal hash when instructions are absent", async scope => {
  const { home, ticket: task } = await fixture();
  const { claimId, projectId, taskId, workerId, worktreeId, userId, ...common } = task;
  const ticket: ControllerLaunchTicket = scope === "task" ? task : { ...common, testExecutionId: randomUUID(), ownerUserId: randomUUID(), initialInput: "none", initialPrompt: "" };
  const original = JSON.stringify(ticket), hash = controllerPayloadHash(ticket);
  expect(parseLaunchTicket(ticket)).toBe(ticket);
  const file = await writeLaunchTicket(home, ticket);
  const read = await readLaunchTicket(home, ticket.launchId);
  expect(read).not.toHaveProperty("instructions");
  expect(await readFile(file, "utf8")).toBe(`${original}\n`);
  expect(controllerPayloadHash(read)).toBe(hash);
  const journal = path.join(home, "legacy.sqlite");
  openControllerLifecycleStore(journal, ticket).close();
  const reopened = openControllerLifecycleStore(journal, read);
  try { expect(reopened.getSnapshot().initialInputState).toBe(scope === "task" ? "not_submitted" : "not_required"); }
  finally { reopened.close(); }
});

it("carries persisted role instructions through stopped generations without replaying unknown user input", async () => {
  const { home, ticket: task } = await fixture();
  const { claimId, projectId, taskId, workerId, worktreeId, userId, ...common } = task;
  let ticket: ControllerLaunchTicket = { ...common, testExecutionId: randomUUID(), ownerUserId: randomUUID(), initialInput: "none", initialPrompt: "", instructions: "固定角色\nUse the CLI. 😀" };
  const nativeSessionId = randomUUID(), journal = path.join(home, "role.sqlite"), operationId = randomUUID();
  for (const generation of ["1", "2", "3"]) {
    await writeLaunchTicket(home, ticket);
    const persisted = await readLaunchTicket(home, ticket.launchId);
    expect(() => validateControllerLocalRequest({ requestId: randomUUID(), executionId: persisted.executionId, testExecutionId: persisted.testExecutionId, executionGeneration: persisted.executionGeneration, controllerInstanceId: persisted.controllerInstanceId, secret: persisted.ipcSecret, action: { kind: "submit_initial", operationId: persisted.initialOperationId } }, persisted)).toThrow(/initial operation/);
    expect(persisted.instructions).toBe("固定角色\nUse the CLI. 😀");
    const store = openControllerLifecycleStore(journal, persisted);
    try {
      expect(store.getSnapshot()).toMatchObject({ executionGeneration: generation, initialInputState: "not_required" });
      if (generation === "1") {
        expect(store.listOperations()).toEqual([]);
        store.prepareOperation({ operationId, kind: "send_message", payload: { text: "actual user request" } });
        store.markDispatching(operationId); store.recordOperation(operationId, "unknown");
      } else {
        expect(store.getSnapshot().nativeSessionId).toBe(nativeSessionId);
        expect(store.listOperations()).toMatchObject([{ operationId, state: "unknown" }]);
        expect(() => store.markDispatching(operationId)).toThrow(/replay/);
      }
      store.patchSnapshot({ nativeSessionId, lifecycle: "stopped", nativeStopped: true });
    } finally { store.close(); }
    ticket = { ...persisted, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: String(Number(generation) + 1), resumeNativeSessionId: nativeSessionId };
  }
});

it("bounds reconciliation pages and persists acknowledged terminal tombstones", async () => {
  const { home, ticket } = await fixture(); const filename = path.join(home, "state.sqlite"); let store = openControllerLifecycleStore(filename, ticket);
  for (let i = 0; i < 105; i++) store.prepareOperation({ operationId: randomUUID(), kind: "cancel", payload: { index: i } });
  expect(store.listUnacknowledgedOperations()).toHaveLength(100);
  const first = store.listUnacknowledgedOperations()[0]!;
  store.markDispatching(first.operationId); store.recordOperation(first.operationId, "confirmed"); store.markOperationAcknowledged(first.operationId); store.close();
  store = openControllerLifecycleStore(filename, ticket);
  expect(store.listUnacknowledgedOperations().some(op => op.operationId === first.operationId)).toBe(false);
  expect(store.prepareOperation(first).state).toBe("confirmed"); store.close();
});
