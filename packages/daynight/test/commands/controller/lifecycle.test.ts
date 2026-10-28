import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readLaunchTicket, writeLaunchTicket, controllerExecutionDirectory, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "worker-managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  return { home, ticket };
};
it.each(["codex", "claude", "copilot"] as const)("writes an immutable %s ticket and rejects launch identity reuse", async (provider) => {
  const { home, ticket: original } = await fixture();
  const ticket = { ...original, provider, configuration: { ...original.configuration, agent: provider } };
  const file = await writeLaunchTicket(home, ticket);
  expect(await readLaunchTicket(home, ticket.launchId)).toEqual(ticket);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await writeLaunchTicket(home, ticket)).toBe(file);
  await expect(writeLaunchTicket(home, { ...ticket, initialPrompt: "changed" })).rejects.toThrow(/different/);
  await expect(readLaunchTicket(home, "../escape")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toContain(ticket.initialOperationId);
});
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
it("rejects new native input at outbox capacity without consuming a sequence or losing events", async () => {
  const { home, ticket } = await fixture(); const store = openControllerLifecycleStore(path.join(home, "state.sqlite"), ticket, { maxOutboxBytes: 512 });
  store.appendEvent({ text: "a".repeat(400) });
  expect(() => store.appendEvent({ text: "b".repeat(400) })).toThrow(/capacity/);
  expect(() => store.prepareOperation({ operationId: randomUUID(), kind: "send_message", payload: { text: "test" } })).toThrow(/capacity/);
  expect(store.pendingEvents()).toHaveLength(1);
  store.acknowledgeEvents("1");
  expect(store.appendEvent({ text: "next" }).sequence).toBe("2"); store.close();
});
it("lists durable operations and refuses to reopen an unproven native generation", async () => {
  const { home, ticket } = await fixture(); const filename = path.join(home, "state.sqlite"); const store = openControllerLifecycleStore(filename, ticket);
  store.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: "start" } });
  expect(store.listOperations()).toHaveLength(1);
  store.patchSnapshot({ controllerProcess: { pid: 987654, parentPid: 1, processGroupId: 987654, startedAt: "original", commandHash: "hash" } });
  store.close(); expect(() => openControllerLifecycleStore(filename, ticket)).toThrow(/generation/);
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
it("replays numeric event order across decimal digit boundaries", async () => {
  const { home, ticket } = await fixture(); const store = openControllerLifecycleStore(path.join(home,"state.sqlite"),ticket);
  for(let i=1;i<=110;i++) store.appendEvent({index:i});
  store.acknowledgeEvents("8");
  expect(store.pendingEvents(100).map(event=>event.sequence)).toEqual(Array.from({length:100},(_,i)=>String(i+9)));
  store.close();
});

it("deduplicates equivalent operation JSON regardless of object key insertion order",async()=>{
 const {home,ticket}=await fixture();const store=openControllerLifecycleStore(path.join(home,"state.sqlite"),ticket);const operationId=randomUUID();
 const first=store.prepareOperation({operationId,kind:"send_message",payload:{text:"hello",expectedTurnId:null}});
 expect(store.prepareOperation({operationId,kind:"send_message",payload:{expectedTurnId:null,text:"hello"}})).toEqual(first);store.close();
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
it("test tickets and journals omit task identity and preserve no-input initialization", async () => {
  const { home, ticket: task } = await fixture();
  const { claimId: _, projectId: __, taskId: ___, workerId: ____, worktreeId: _____, userId: ______, ...common } = task;
  const ticket: ControllerLaunchTicket = { ...common, testExecutionId: randomUUID(), ownerUserId: randomUUID(), initialInput: "none", initialPrompt: "" };
  await writeLaunchTicket(home, ticket);
  expect(await readLaunchTicket(home, ticket.launchId)).toEqual(ticket);
  const store = openControllerLifecycleStore(path.join(home, "test.sqlite"), ticket);
  try {
    expect(store.getSnapshot()).toMatchObject({ testExecutionId: ticket.testExecutionId, initialInputState: "not_required" });
    expect(store.getSnapshot()).not.toHaveProperty("claimId");
    expect(() => store.patchSnapshot({ testExecutionId: randomUUID() } as never)).toThrow("identity");
  } finally { store.close(); }
  const resumed = { ...ticket, launchId: randomUUID(), resumeNativeSessionId: randomUUID() };
  await writeLaunchTicket(home, resumed);
  expect(await readLaunchTicket(home, resumed.launchId)).toEqual(resumed);
  await expect(writeLaunchTicket(home, { ...resumed, launchId: randomUUID(), initialInput: "prompt", initialPrompt: "replay" })).rejects.toThrow("resume binding");
  await expect(writeLaunchTicket(home, { ...ticket, claimId: randomUUID() } as never)).rejects.toThrow();
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
