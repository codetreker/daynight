import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { controllerExecutionDirectory, controllerPayloadHash, parseLaunchTicket, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import { createBotProcess } from "../../../src/commands/worker/bots/process.js";
import type { BotDefinition, BotRecord } from "../../../src/commands/worker/bots/types.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/tool-launch-persistence");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "launch-")); roots.push(root);
  const entry = path.join(root, "codex.js"); await writeFile(entry, "console.log('codex fixture');\n");
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  let toolLaunch;
  try { toolLaunch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: entry }, environment: process.env, cwd: root }, operation); }
  finally { operation.dispose(); }
  const project = { projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: root };
  const claim = { projectId: project.projectId, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID() };
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2, toolLaunch };
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, ...claim, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, ".codex"), configuration, initialOperationId: randomUUID(), initialPrompt: "original input", resumeNativeSessionId: null, credentialFile: path.join(root, "credential.json"), ipcEndpoint: path.join(root, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  return { root, project, claim, configuration, toolLaunch, ticket };
};

it("keeps the complete tool recipe in the claim and Web records across SQLite reopen", async () => {
  const f = await fixture(), file = path.join(f.root, "worker.sqlite");
  let store = openWorkerStore(file, { onMigration: () => {} });
  try {
    store.registerProject(f.project);
    store.registerPending({ ...f.claim, agent: "codex", agentControlMode: "web", nativeConfiguration: f.configuration });
  } finally { store.close(); }
  store = openWorkerStore(file);
  try { expect(store.getNativeConfiguration(f.claim)).toEqual({ agent: "codex", model: null, args: [], toolLaunch: f.toolLaunch }); }
  finally { store.close(); }
  const webFile = path.join(f.root, "web.sqlite"); let web = openWebExecutionStore(webFile, { onMigration: () => {} });
  try { web.register({ ...f.claim, project: f.project, configuration: f.configuration, serverOrigin: f.ticket.serverOrigin, userId: f.ticket.userId! }, 1); }
  finally { web.close(); }
  web = openWebExecutionStore(webFile);
  try { expect(web.getTask(f.claim)?.configuration).toEqual(f.configuration); }
  finally { web.close(); }
});

it("strictly binds an immutable ticket recipe to its provider, context and complete hash", async () => {
  const { root, ticket, toolLaunch } = await fixture();
  await writeLaunchTicket(root, ticket);
  expect(await readLaunchTicket(root, ticket.launchId)).toEqual(ticket);
  for (const invalid of [{ ...toolLaunch, context: "herdr" }, { ...toolLaunch, tool: "copilot" }, { ...toolLaunch, selectionKey: "b".repeat(64) }, { ...toolLaunch, extra: true }, { ...toolLaunch, command: { file: "codex", prefixArgs: [] } }]) {
    expect(() => parseLaunchTicket({ ...ticket, configuration: { ...ticket.configuration, toolLaunch: invalid } })).toThrow();
  }
});

it("creates an immutable selection sidecar without rewriting the legacy ticket and reuses it after reopen", async () => {
  const { readLaunchToolSelection, writeLaunchToolSelection } = await import("../../../src/commands/controller/launch-tool-selection.js");
  const { root, ticket: current, toolLaunch } = await fixture();
  const { toolLaunch: _launch, ...configuration } = current.configuration;
  const ticket = { ...current, configuration }, hash = controllerPayloadHash(ticket);
  const ticketFile = await writeLaunchTicket(root, ticket), original = await readFile(ticketFile);
  const checks: number[] = [];
  await writeLaunchToolSelection(root, ticket, toolLaunch, () => { checks.push(1); });
  expect(checks.length).toBeGreaterThanOrEqual(2);
  expect(await readLaunchToolSelection(root, await readLaunchTicket(root, ticket.launchId))).toEqual(toolLaunch);
  expect(await readFile(ticketFile)).toEqual(original);
  expect(controllerPayloadHash(ticket)).toBe(hash);
  await writeLaunchToolSelection(root, ticket, toolLaunch, () => {});
  await expect(readLaunchToolSelection(root, { ...ticket, initialPrompt: "different ticket" })).rejects.toThrow(/ticket|binding/i);
  const filename = path.join(controllerExecutionDirectory(root, ticket.executionId), "tool-selections", `${ticket.launchId}.json`);
  if (process.platform !== "win32") {
    await chmod(filename, 0o400); expect(await readLaunchToolSelection(root, ticket)).toEqual(toolLaunch);
    await chmod(filename, 0o640); await expect(readLaunchToolSelection(root, ticket)).rejects.toThrow();
    await chmod(filename, 0o600);
  }
  const stored = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({ ...stored, toolLaunch: { ...toolLaunch, selectionKey: "b".repeat(64) } }));
  await expect(readLaunchToolSelection(root, ticket)).rejects.toThrow();
  await truncate(filename, 1_048_577);
  await expect(readLaunchToolSelection(root, ticket)).rejects.toMatchObject({ code: "not_executable" });
});

it.skipIf(process.platform === "win32")("refuses a symlink sidecar and never fills a selection after submission starts", async () => {
  const { readLaunchToolSelection, writeLaunchToolSelection } = await import("../../../src/commands/controller/launch-tool-selection.js");
  const { root, ticket: current, toolLaunch } = await fixture();
  const { toolLaunch: _launch, ...configuration } = current.configuration;
  const ticket = { ...current, configuration };
  await writeLaunchTicket(root, ticket);
  let checks = 0;
  await expect(writeLaunchToolSelection(root, ticket, toolLaunch, () => { if (++checks > 1) throw new Error("submitted"); })).rejects.toThrow("submitted");
  expect(await readLaunchToolSelection(root, ticket)).toBeUndefined();
  await writeLaunchToolSelection(root, ticket, toolLaunch, () => {});
  const file = path.join(controllerExecutionDirectory(root, ticket.executionId), "tool-selections", `${ticket.launchId}.json`);
  const other = path.join(root, "foreign.json"); await writeFile(other, await readFile(file)); await rm(file); await symlink(other, file);
  await expect(readLaunchToolSelection(root, ticket)).rejects.toThrow();
  await expect(writeLaunchToolSelection(root, ticket, toolLaunch, () => {})).rejects.toThrow();
  await rm(file); await promisify(execFile)("mkfifo", [file], { timeout: 5000 });
  await expect(readLaunchToolSelection(root, ticket)).rejects.toMatchObject({ code: "not_executable" });
});

const webFixture = async (persistTicket: boolean) => {
  const f = await fixture(), store = openWebExecutionStore(path.join(f.root, "web-launch.sqlite"), { onMigration: () => {} });
  const { toolLaunch: _launch, ...configuration } = f.configuration;
  let task = store.register({ ...f.claim, project: f.project, configuration, serverOrigin: f.ticket.serverOrigin, userId: f.ticket.userId! }, 1);
  task = store.bindWorktree(task, { repositoryPath: f.root, commonDirectory: path.join(f.root, ".git"), worktreePath: f.root, branch: "original" }, 2);
  task = store.initializeWebExecution(task, 3);
  task = store.updateWebExecution(task, { sessionId: f.ticket.sessionId, initialPrompt: f.ticket.initialPrompt }, 4);
  const execution = task.webExecution!;
  const ticket = { ...f.ticket, configuration, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, initialOperationId: execution.initialOperationId };
  if (persistTicket) task = store.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.root, ticket) }, 5);
  const sessionApi = { register: vi.fn(async () => ({ sessionId: ticket.sessionId })), grant: vi.fn(async () => ({ token: "fixture", expiresAt: new Date(Date.now() + 300_000).toISOString() })) } as unknown as WorkerSessionApi;
  const selectToolLaunch = vi.fn(async () => f.toolLaunch);
  const toolObservation = { version: "fixture-version", checkedAt: "2026-11-12T00:00:00.000Z" };
  const launcher = () => createWebControllerLauncher({ homeDirectory: f.root, packageDirectory: f.root, store, sessionApi, now: () => 6, selectToolLaunch, toolObservationFor: () => toolObservation });
  return { ...f, store, task, ticket, selectToolLaunch, sessionApi, launcher, toolObservation };
};

it.each([false, true])("freezes a never-submitted Web launch before its first submission (ticket=%s)", async persistTicket => {
  const f = await webFixture(persistTicket);
  try {
    const ticket = await f.launcher().prepare(f.task, "must not replace original", new AbortController().signal);
    const { readLaunchToolSelection } = await import("../../../src/commands/controller/launch-tool-selection.js");
    expect(await readLaunchToolSelection(f.root, ticket)).toEqual(f.toolLaunch);
    expect(ticket.initialPrompt).toBe(f.ticket.initialPrompt);
    expect(ticket.launchId).toBe(f.ticket.launchId);
    expect(f.store.getTask(f.task)?.configuration?.toolObservation).toEqual(f.toolObservation);
    if (persistTicket) expect(ticket).toEqual(f.ticket);
    else expect(f.store.getTask(f.task)?.configuration?.toolLaunch).toEqual(f.toolLaunch);
    f.selectToolLaunch.mockRejectedValue(new Error("new target unavailable"));
    expect(await f.launcher().prepare(f.task, "new input", new AbortController().signal)).toEqual(ticket);
    expect(f.selectToolLaunch).toHaveBeenCalledOnce();
  } finally { f.store.close(); }
});

const botFixture = async (legacy: boolean) => {
  const f = await fixture(), file = path.join(f.root, "bot.sqlite");
  let bots = openBotStore(file, { onMigration: () => {} }), executions = openBotExecutionStore(file, { onMigration: () => {} });
  const owner = { serverOrigin: f.ticket.serverOrigin, ownerUserId: f.ticket.userId!, workerId: f.claim.workerId };
  let definition: BotDefinition = { id: randomUUID(), workerId: owner.workerId, version: "1", deletion: null, ownerUserId: owner.ownerUserId, name: "Fixture", creationOrder: "1", requestedOverrides: {},
    resolvedConfiguration: { workerId: owner.workerId, cwd: f.root, provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z" };
  bots.observe(owner, definition, 1);
  const current = () => bots.get(owner, definition.id)!;
  let originalTicket: ControllerLaunchTicket | undefined;
  if (legacy) {
    bots.prepare(owner, definition.id, { homeDirectory: f.root, recoveryLimit: 2 });
    const instructions = "Original frozen role";
    bots.freezeRole(owner, definition.id, { instructions, revision: "1", digest: createHash("sha256").update(instructions).digest("hex") });
    const intent = current().intent!;
    definition = { ...definition, version: "2", sessionId: randomUUID(), testExecutionId: intent.executionId, roleConfiguration: intent.roleConfiguration };
    bots.observe(owner, definition, 2);
    executions.prepare(current());
    originalTicket = { schemaVersion: 1, launchId: intent.launchId, executionId: intent.executionId, testExecutionId: intent.executionId, controllerId: intent.registration.controllerId,
      controllerInstanceId: intent.controllerInstanceId, sessionId: definition.sessionId!, executionGeneration: "1", serverOrigin: owner.serverOrigin, ownerUserId: owner.ownerUserId,
      provider: "codex", cwd: f.root, nativeHome: path.join(f.root, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
      initialInput: "none", initialOperationId: intent.initialOperationId, initialPrompt: "", instructions, resumeNativeSessionId: null, credentialFile: intent.credentialFile,
      ipcEndpoint: path.join(f.root, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: "2026-11-12T00:00:00Z" };
    await writeLaunchTicket(f.root, originalTicket);
  }
  const toolObservation = { version: "fixture-version", checkedAt: "2026-11-12T00:00:00.000Z" };
  const snapshot = (ticket: ControllerLaunchTicket): ControllerSnapshot => ({ executionId: ticket.executionId, testExecutionId: ticket.executionId, sessionId: ticket.sessionId,
    executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, nativeSessionId: f.ticket.sessionId, lifecycle: "ready", activity: "idle", initialInputState: "not_required",
    currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: true }, controllerProcess: { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "fixture", commandHash: "a".repeat(64) }, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null });
  const selectToolLaunch = vi.fn(async () => f.toolLaunch), register = vi.fn(async (record: BotRecord) => {
    expect(record.intent?.toolLaunch).toEqual(f.toolLaunch);
    expect(record.intent?.toolObservation).toEqual(toolObservation);
    definition = { ...definition, version: "2", sessionId: randomUUID(), testExecutionId: record.intent!.executionId, roleConfiguration: record.intent!.roleConfiguration };
    return { bot: definition, snapshot: {} as never };
  });
  const dependencies = { prepareEnvironment: vi.fn(async () => ({ environment: { ...process.env }, aliasDirectory: null, bindings: [], release: async () => {} })),
    launch: vi.fn<NonNullable<NonNullable<Parameters<typeof createBotProcess>[0]["dependencies"]>["launch"]>>(async options => { await options.onSubmitting?.(); const value = snapshot(options.ticket); await options.onObserved?.(value); return value; }),
    observe: vi.fn(async (ticket: ControllerLaunchTicket) => snapshot(ticket)), readSnapshot: vi.fn((): ControllerSnapshot | null => null), confirmStopped: vi.fn(async () => true) };
  const sessionApi = { register, grant: vi.fn(async () => ({ token: "fixture", expiresAt: new Date(Date.now() + 300_000).toISOString() })) } as unknown as Parameters<typeof createBotProcess>[0]["sessionApi"];
  const manager = () => createBotProcess({ homeDirectory: f.root, packageDirectory: f.root, store: bots, executions, sessionApi, recoveryLimit: 2, selectToolLaunch, toolObservationFor: () => toolObservation, dependencies });
  return { ...f, current, manager, dependencies, selectToolLaunch, register, originalTicket, snapshot, toolObservation,
    executions: () => executions,
    reopen: () => { executions.close(); bots.close(); bots = openBotStore(file); executions = openBotExecutionStore(file); },
    close: () => { executions.close(); bots.close(); } };
};

it.each([false, true])("persists the original Bot selection before spawn and reuses it across reopen (legacy ticket=%s)", async legacy => {
  const f = await botFixture(legacy);
  try {
    const bytes = f.originalTicket === undefined ? undefined : await readFile(f.current().intent!.ticketPath);
    f.dependencies.launch.mockRejectedValueOnce(new Error("before dispatch"));
    await expect(f.manager().advance(f.current(), new AbortController().signal)).rejects.toThrow("before dispatch");
    const original = f.current().intent!;
    expect(original.toolLaunch).toEqual(f.toolLaunch);
    expect(original.toolObservation).toEqual(f.toolObservation);
    if (bytes !== undefined) expect(await readFile(original.ticketPath)).toEqual(bytes);
    f.reopen();
    f.selectToolLaunch.mockRejectedValue(new Error("replacement target unavailable"));
    expect((await f.manager().advance(f.current(), new AbortController().signal)).lifecycle).toBe("ready");
    expect(f.current().intent).toEqual(original);
    expect(f.selectToolLaunch).toHaveBeenCalledOnce();
    expect(f.register).toHaveBeenCalledTimes(legacy ? 0 : 1);
  } finally { f.close(); }
});

it("keeps a legacy submitted Bot observable and refuses recovery before allocating another launch", async () => {
  const f = await botFixture(true);
  try {
    const original = f.current().intent!, ready = f.snapshot(f.originalTicket!);
    f.executions().update(f.current(), { launchSubmission: "unknown" });
    expect((await f.manager().advance(f.current(), new AbortController().signal)).lifecycle).toBe("ready");
    const stopped: ControllerSnapshot = { ...ready, lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: "2026-11-12T00:00:00Z" };
    f.dependencies.observe.mockResolvedValue(stopped);
    f.dependencies.readSnapshot.mockReturnValue(stopped);
    await expect(f.manager().advance(f.current(), new AbortController().signal)).rejects.toThrow("legacy_tool_identity_missing");
    expect(f.current().intent).toEqual(original);
    expect(f.selectToolLaunch).not.toHaveBeenCalled();
    expect(f.dependencies.launch).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it("keeps a legacy live ticket usable but rejects a new generation without its original tool identity", async () => {
  const f = await webFixture(true);
  try {
    f.store.updateWebExecution(f.task, { launchSubmission: "acknowledged" }, 6);
    f.selectToolLaunch.mockRejectedValue(new Error("must not select a replacement"));
    expect(await f.launcher().prepare(f.task, "new input", new AbortController().signal)).toEqual(f.ticket);
    expect(f.selectToolLaunch).not.toHaveBeenCalled();
    const nativeSessionId = randomUUID();
    f.store.bindNativeSession(f.task, { source: "controller", sessionId: nativeSessionId }, 7);
    expect(() => f.store.beginWebGeneration(f.task, { executionGeneration: "1", controllerInstanceId: f.ticket.controllerInstanceId, nativeSessionId, nativeStopped: true }, 8)).toThrow(/legacy_tool_identity_missing/);
    expect(f.store.getTask(f.task)?.webExecution?.launchId).toBe(f.ticket.launchId);
  } finally { f.store.close(); }
});
