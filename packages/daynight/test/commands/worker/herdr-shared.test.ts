import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import type { HerdrExecutionContext, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";
import type { ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { ToolSelectionManager } from "../../../src/commands/worker/tool-selection.js";
import { createSharedWorkerHerdr } from "../../../src/commands/worker/herdr/shared.js";
import { readHerdrSharedInstance, writeHerdrSharedInstance } from "../../../src/commands/worker/herdr/shared-instance-store.js";
import { resolveHerdrInstancePaths } from "../../../src/commands/worker/herdr/instance.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { resourceOwnerKey } from "../../../src/commands/worker/resource-owner.js";
import { toolSelectionKey, type ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";

const directories: string[] = [], operations: Operation[] = [];
afterEach(async () => { operations.splice(0).forEach(operation => operation.dispose()); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const operation = () => { const result = createOperation({ limits: { totalMs: 3000 } }); operations.push(result); return result; };
const fixture = async () => {
  const scratch = path.resolve("../../.tmp/shared-herdr-adapter"); await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "run-")); directories.push(directory);
  const paths = resolveWorkerPaths(directory), instancePaths = { ...resolveHerdrInstancePaths({ herdrDirectory: "/state/h", logsDirectory: "/state/logs" }), privateDirectory: paths.herdrDirectory, configurationFile: path.join(paths.herdrDirectory, "config.toml"), sessionDirectory: path.join(paths.herdrDirectory, "sessions") };
  const launch = async (label: string, tool: "herdr" | "codex" = "herdr"): Promise<ResolvedToolLaunch> => {
    const file = path.join(directory, `herdr-${label}`), body = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(`fixture ${label}\n`)]);
    await writeFile(file, body, { mode: 0o700 });
    const value = { schemaVersion: 1 as const, tool, context: "herdr" as const, source: "explicit" as const, entryPath: file, canonicalEntryPath: file, executablePath: file, interpreterPath: null, command: { file, prefixArgs: [] }, artifacts: [{ role: "entry" as const, path: file, realPath: file, size: String(body.length), sha256: createHash("sha256").update(body).digest("hex") }] };
    return { ...value, selectionKey: toolSelectionKey(value) };
  };
  const a = await launch("A"), b = await launch("B"), codex = await launch("codex", "codex");
  const events: string[] = [], states = new Map<string, { proof: ProcessProof; running: boolean; endpoints: boolean; ensures: number; connects: number; stops: number }>();
  const settings = { responsibilities: false, stopFails: false, captureFails: false, readinessFails: false, endpointRemains: false, mappingsStopped: true, endpointState: null as { api: boolean; client: boolean } | null, endpointFailure: null as Error | null, resourceFailure: null as Error | null, version: "0.9.9" };
  const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  const context: HerdrExecutionContext = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4), cwd: directory, agent: "codex" };
  let frozen: ExecutionConfiguration | null = { agent: "codex", agentControlMode: "herdr", model: null, args: [], recoveryLimit: 3, herdrLaunch: a, herdrObservation: { version: "0.9.9", checkedAt: "2026-01-01T00:00:00.000Z" }, toolLaunch: codex, toolObservation: { version: "0.167.1", checkedAt: "2026-01-02T00:00:00.000Z" } };
  const mapping = async (started = true, retired = false) => {
    const { projectId, taskId, claimId, worktreeId } = context, owner = { projectId, taskId, claimId, worktreeId }, nonce = uuid(5);
    const key = createHash("sha256").update(resourceOwnerKey(owner)).update(codex.selectionKey).digest("hex"), generation = uuid(6);
    const root = path.join(paths.herdrDirectory, "tool-launch", key, generation);
    for (const component of [paths.herdrDirectory, path.dirname(path.dirname(root)), path.dirname(root), root]) await mkdir(component, { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, owner, nonce, launch: codex, nativePath: null, nodeExecutable: process.execPath, childEntry: path.join(root, "entry.cjs"), platform: process.platform }), { mode: 0o600 });
    if (started) await writeFile(path.join(root, "launch-intent.json"), JSON.stringify({ schemaVersion: 1, owner, nonce, selectionKey: codex.selectionKey, logicalArgvDigest: "a".repeat(64), file: codex.command.file, prefixArgs: codex.command.prefixArgs, helperPid: 123 }), { mode: 0o600 });
    if (retired) await writeFile(path.join(root, "retired.json"), JSON.stringify({ nonce, selectionKey: codex.selectionKey, owner }), { mode: 0o600 });
    return root;
  };
  let endpointOwner: string | null = null, nextPid = 1000;
  const stateFor = (key: string) => {
    let result = states.get(key);
    if (!result) { const pid = nextPid++; result = { proof: { pid, parentPid: 1, processGroupId: pid, startedAt: `birth-${pid}`, commandHash: "a".repeat(64) }, running: false, endpoints: false, ensures: 0, connects: 0, stops: 0 }; states.set(key, result); }
    return result;
  };
  const build = () => createSharedWorkerHerdr({ paths, homeDirectory: directory, hasResponsibilities: () => settings.responsibilities,
    readExecutionConfiguration: owner => owner.claimId === context.claimId && owner.projectId === context.projectId && owner.taskId === context.taskId && owner.worktreeId === context.worktreeId ? frozen : null,
    confirmMappingsStopped: async () => { events.push("native-trees-stopped"); return settings.mappingsStopped; },
    inspectEndpoints: async () => {
      if (settings.endpointFailure !== null) throw settings.endpointFailure;
      return settings.endpointState ?? { api: endpointOwner !== null && stateFor(endpointOwner).endpoints, client: endpointOwner !== null && stateFor(endpointOwner).endpoints };
    },
    captureProcess: async pid => { events.push("capture"); if (settings.captureFails) throw new Error("Original birth identity unavailable"); const found = [...states.values()].find(state => state.proof.pid === pid); if (!found) throw new Error("Unknown fixture process"); return found.proof; },
    inspectProcess: async proof => [...states.values()].find(state => state.proof.pid === proof.pid)?.running ? "running" : "stopped",
    instanceFactory: options => {
      const key = options.herdrLaunch?.selectionKey ?? "legacy", state = stateFor(key);
      const ready = () => ({ reconnected: true, version: settings.version, protocol: 22 as const, snapshot: {} });
      return {
        paths: instancePaths, attachment: { executable: options.herdrLaunch?.command.file ?? "herdr", arguments: [], environment: {}, unsetEnvironment: [] }, createShellStartup: () => undefined,
        ensureInstance: async () => {
          events.push(`ensure:${key}`); state.ensures++;
          expect(readHerdrSharedInstance(paths)?.pending?.phase).toBe("starting");
          if (state.ensures > 1) { const pid = nextPid++; state.proof = { pid, parentPid: 1, processGroupId: pid, startedAt: `birth-${pid}`, commandHash: "a".repeat(64) }; }
          state.running = true; state.endpoints = true; endpointOwner = key;
          await options.onDaemonSpawn?.(state.proof.pid);
          if (settings.readinessFails) throw new Error("Readiness response was lost");
          return { ...ready(), reconnected: false };
        },
        connectInstance: async () => { events.push(`connect:${key}`); state.connects++; if (!state.endpoints) throw new Error("No original endpoint"); return ready(); },
        stopInstance: async () => {
          events.push(`stop:${key}`); state.stops++;
          if (settings.stopFails) throw new Error("Original stop unconfirmed");
          state.running = false; if (!settings.endpointRemains) state.endpoints = false;
          return { apiClosed: true, clientClosed: true, ownedChildClosed: null };
        },
        tasks: {
          observe: async () => { events.push(`observe:${key}`); return { selectionKey: key }; },
          listResources: async () => { events.push(`resources:${key}`); if (settings.resourceFailure !== null) throw settings.resourceFailure; return []; },
        },
      } as unknown as WorkerHerdrAdapter;
    } });
  return { paths, directory, context, a, b, codex, mapping, events, states, settings, stateFor, build, changeFrozen: (value: ExecutionConfiguration | null) => { frozen = value; }, setLegacy: async () => { await mkdir(paths.herdrDirectory, { recursive: true, mode: 0o700 }); await writeFile(instancePaths.configurationFile, "legacy private configuration", { mode: 0o600 }); const state = stateFor("legacy"); state.running = true; state.endpoints = true; endpointOwner = "legacy"; } };
};

test("observes an absent shared instance through real endpoints without creating its configuration", async () => {
  const f = await fixture();
  let root = f.directory;
  // Real AF_UNIX endpoint names retain their platform limit inside long checkouts.
  if (process.platform !== "win32") {
    root = path.join("/tmp", `dn-h-${randomUUID().slice(0, 8)}`);
    await symlink(f.directory, root); directories.push(root);
  }
  const paths = resolveWorkerPaths(root), shared = createSharedWorkerHerdr({ paths, homeDirectory: root, hasResponsibilities: () => false });
  await expect(shared.observeResources!(operation())).resolves.toEqual([]);
  expect(readHerdrSharedInstance(paths)).toBeNull();
  await expect(access(shared.paths.configurationFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["responsibility", "native mapping", "partial endpoint", "endpoint error", "retained configuration", "retained session", "unknown startup", "invalid journal"] as const)("retains an absent instance with %s during resource observation", async variant => {
  const f = await fixture(), shared = f.build();
  if (variant === "responsibility") f.settings.responsibilities = true;
  if (variant === "native mapping") f.settings.mappingsStopped = false;
  if (variant === "partial endpoint") f.settings.endpointState = { api: true, client: false };
  if (variant === "endpoint error") f.settings.endpointFailure = new Error("Endpoint permission denied");
  if (variant === "retained configuration") {
    await mkdir(f.paths.herdrDirectory, { recursive: true, mode: 0o700 });
    await writeFile(shared.paths.configurationFile, "retained configuration", { mode: 0o600 });
  }
  if (variant === "retained session") await mkdir(shared.paths.sessionDirectory, { recursive: true, mode: 0o700 });
  if (variant === "unknown startup") await writeHerdrSharedInstance(f.paths, { schemaVersion: 1, current: { launch: f.a, observation: null, daemon: null, phase: "starting" }, pending: { launch: f.a, phase: "starting" } });
  if (variant === "invalid journal") {
    await mkdir(f.paths.herdrDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(f.paths.herdrDirectory, "tool-instance.json"), "{}", { mode: 0o600 });
  }
  await expect(shared.observeResources!(operation())).rejects.toThrow();
  expect([...f.states.values()].every(state => state.ensures === 0)).toBe(true);
  expect(f.events.some(event => event.startsWith("resources:"))).toBe(false);
});

test("observes a running original daemon and propagates its resource failure without spawning", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation());
  await expect(shared.observeResources!(operation())).resolves.toEqual([]);
  expect(f.events).toContain(`resources:${f.a.selectionKey}`);
  const error = new Error("Original resource inventory failed"); f.settings.resourceFailure = error;
  await expect(shared.observeResources!(operation())).rejects.toBe(error);
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1);
});

test("starts a frozen shared instance and records the real handshake before admission", async () => {
  const f = await fixture(), shared = f.build();
  await expect(shared.prepareSelection(f.a, operation())).resolves.toMatchObject({ state: "applied", version: "0.9.9" });
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.a, observation: { version: "0.9.9" }, daemon: f.stateFor(f.a.selectionKey).proof, phase: "ready" }, pending: null });
  expect(shared.activeToolSelections()).toEqual([expect.objectContaining({ launch: f.a, version: "0.9.9", instanceCount: 1, unconfirmedCount: 0 })]);
});

test("reports retained native mapping intent with only its original frozen observation", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); await f.mapping();
  expect(shared.activeToolSelections()).toContainEqual({ tool: "codex", context: "herdr", launch: f.codex, version: "0.167.1", checkedAt: "2026-01-02T00:00:00.000Z", executionCount: null, instanceCount: 0, unconfirmedCount: 1 });
  f.changeFrozen(null);
  expect(shared.activeToolSelections()).toContainEqual({ tool: "codex", context: "herdr", launch: f.codex, version: null, checkedAt: null, executionCount: null, instanceCount: 0, unconfirmedCount: 1 });
  f.changeFrozen({ agent: "codex", agentControlMode: "herdr", model: null, args: [], recoveryLimit: 3, toolLaunch: f.b, toolObservation: { version: "99.0.0", checkedAt: "2026-01-03T00:00:00.000Z" } });
  expect(shared.activeToolSelections()).toContainEqual({ tool: "codex", context: "herdr", launch: f.codex, version: null, checkedAt: null, executionCount: null, instanceCount: 0, unconfirmedCount: 1 });
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1);
});

test.each([[false, false], [true, true]])("excludes a mapping without retained native responsibility (%s, %s)", async (started, retired) => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); await f.mapping(started, retired);
  expect(shared.activeToolSelections()).toEqual([expect.objectContaining({ tool: "herdr", instanceCount: 1 })]);
});

test("keeps corrupted native mapping inventory unconfirmed instead of reporting no executions", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); const root = await f.mapping();
  await writeFile(path.join(root, "manifest.json"), "{}", { mode: 0o600 });
  const inventory = shared.activeToolSelections();
  for (const tool of ["codex", "copilot"]) expect(inventory).toContainEqual({ tool, context: "herdr", launch: null, version: null, checkedAt: null, executionCount: null, instanceCount: 0, unconfirmedCount: 1 });
});

test("keeps existing work on its original shared adapter while a new target waits", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.settings.responsibilities = true;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "active_instance" });
  await shared.ensureInstance(operation());
  await shared.tasks.observe({} as never, {} as never, operation());
  expect(f.events).toContain(`observe:${f.a.selectionKey}`); expect(f.stateFor(f.a.selectionKey).stops).toBe(0); expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
  expect(readHerdrSharedInstance(f.paths)?.current?.launch).toEqual(f.a);
});

test("switches only after both old endpoints and the original daemon close", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation());
  await expect(shared.prepareSelection(f.b, operation())).resolves.toMatchObject({ state: "applied" });
  expect(f.stateFor(f.a.selectionKey)).toMatchObject({ running: false, endpoints: false, stops: 1 });
  expect(f.stateFor(f.b.selectionKey).ensures).toBe(1);
  expect(f.events.indexOf(`stop:${f.a.selectionKey}`)).toBeLessThan(f.events.indexOf(`ensure:${f.b.selectionKey}`));
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.b, phase: "ready" }, pending: null });
});

test("keeps a failed stop pending and never ensures the old binary again", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.settings.stopFails = true;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.a, daemon: f.stateFor(f.a.selectionKey).proof, phase: "stopping" }, pending: { launch: f.b, phase: "intent" } });
  await shared.ensureInstance(operation());
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1); expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
  f.settings.stopFails = false;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toMatchObject({ state: "applied" });
});

test("retains an unknown startup across restart and target changes when process capture failed", async () => {
  const f = await fixture(), shared = f.build(); f.settings.captureFails = true;
  await expect(shared.prepareSelection(f.a, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  const original = readHerdrSharedInstance(f.paths)!;
  expect(original).toMatchObject({ current: { launch: f.a, daemon: null, phase: "starting" }, pending: { launch: f.a, phase: "starting" } });
  f.settings.captureFails = false;
  await expect(f.build().prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(readHerdrSharedInstance(f.paths)).toEqual(original);
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1); expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
  expect(shared.activeToolSelections()).toEqual([expect.objectContaining({ launch: f.a, version: null, instanceCount: null, unconfirmedCount: 1 })]);
});

test("recovers a captured startup by reconnecting its original daemon without replaying spawn", async () => {
  const f = await fixture(), shared = f.build(); f.settings.readinessFails = true;
  await expect(shared.prepareSelection(f.a, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(readHerdrSharedInstance(f.paths)?.current?.daemon).toEqual(f.stateFor(f.a.selectionKey).proof);
  f.settings.readinessFails = false; f.settings.version = "0.9.10";
  await expect(f.build().prepareSelection(f.a, operation())).resolves.toMatchObject({ state: "applied", version: "0.9.10" });
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1);
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { observation: { version: "0.9.10" }, phase: "ready" }, pending: null });
});

test.each(["intent", "old_stopped"] as const)("recovers a %s switch stage with its original process boundary", async stage => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation());
  const record = readHerdrSharedInstance(f.paths)!;
  if (stage === "old_stopped") { f.stateFor(f.a.selectionKey).running = false; f.stateFor(f.a.selectionKey).endpoints = false; }
  await writeHerdrSharedInstance(f.paths, { ...record, current: { ...record.current!, phase: stage === "intent" ? "stopping" : "stopped" }, pending: { launch: f.b, phase: stage } });
  await expect(f.build().prepareSelection(f.b, operation())).resolves.toMatchObject({ state: "applied" });
  expect(f.stateFor(f.a.selectionKey).stops).toBe(stage === "intent" ? 1 : 0); expect(f.stateFor(f.b.selectionKey).ensures).toBe(1);
});

test("does not trust endpoint closure while the original legacy daemon has no process proof", async () => {
  const f = await fixture(); await f.setLegacy(); const shared = f.build(); f.settings.responsibilities = true;
  await expect(shared.prepareSelection(f.a, operation())).resolves.toEqual({ state: "pending", reason: "active_instance" });
  await shared.ensureInstance(operation()); await shared.tasks.observe({} as never, {} as never, operation());
  expect(f.events).toContain("observe:legacy");
  f.settings.responsibilities = false;
  await expect(shared.prepareSelection(f.a, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: null, daemon: null, phase: "stopping" }, pending: { launch: f.a, phase: "intent" } });
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(0);
});

test("does not stop an unowned reachable endpoint after the original process exited", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.stateFor(f.a.selectionKey).running = false;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(f.stateFor(f.a.selectionKey).stops).toBe(0); expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
});

test("checks actual endpoint closure after a stop acknowledgement", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.settings.endpointRemains = true;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.a, phase: "stopping" }, pending: { phase: "intent" } });
});

test("serializes concurrent target admission without overlapping startup ownership", async () => {
  const f = await fixture(), shared = f.build();
  const results = await Promise.all([shared.prepareSelection(f.a, operation()), shared.prepareSelection(f.b, operation())]);
  expect(results.map(result => result.state)).toEqual(["applied", "applied"]);
  expect(f.events.filter(value => value.startsWith("ensure:"))).toEqual([`ensure:${f.a.selectionKey}`, `ensure:${f.b.selectionKey}`]);
  expect(f.events.indexOf(`stop:${f.a.selectionKey}`)).toBeLessThan(f.events.indexOf(`ensure:${f.b.selectionKey}`));
});

test("reserves the frozen selection before a queued target can replace its daemon", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation());
  let persisted = false;
  const reserve = shared.reserveSelection(f.a, () => { persisted = true; f.settings.responsibilities = true; }, operation());
  const replace = shared.prepareSelection(f.b, operation());
  const results = await Promise.allSettled([reserve, replace]);
  expect(results).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: { state: "pending", reason: "active_instance" } }]);
  expect(persisted).toBe(true);
  expect(f.stateFor(f.a.selectionKey).stops).toBe(0); expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
  f.settings.responsibilities = false;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toMatchObject({ state: "applied" });
});

test("refuses an obsolete frozen selection when another target won admission before reservation", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation());
  const replace = shared.prepareSelection(f.b, operation());
  let persisted = false;
  const reserve = shared.reserveSelection(f.a, () => { persisted = true; }, operation());
  const results = await Promise.allSettled([replace, reserve]);
  expect(results[0]!.status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/selection.*changed/i) }) });
  expect(persisted).toBe(false); expect(readHerdrSharedInstance(f.paths)?.current?.launch).toEqual(f.b);
});

test("does not publish a reservation when the original daemon has stopped", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.stateFor(f.a.selectionKey).running = false;
  let persisted = false;
  await expect(shared.reserveSelection(f.a, () => { persisted = true; }, operation())).rejects.toThrow(/daemon/i);
  expect(persisted).toBe(false);
});

test("reconnects a ready journal after restart using the daemon handshake rather than a new launch", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.settings.version = "0.9.11";
  await expect(f.build().prepareSelection(f.a, operation())).resolves.toMatchObject({ state: "applied", version: "0.9.11" });
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1);
});

test("stopping a shared instance does not authorize coordinator ensure to restart it", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); await shared.stopInstance(operation());
  await expect(shared.ensureInstance(operation())).rejects.toThrow();
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1); expect(readHerdrSharedInstance(f.paths)?.current?.phase).toBe("stopped");
});

test("refuses coordinator connection when the original process identity no longer runs", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.stateFor(f.a.selectionKey).running = false;
  await expect(shared.ensureInstance(operation())).rejects.toThrow(/original.*daemon/i);
});

test("repairs a known exited shared daemon only after confirming both endpoints absent", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); const original = f.stateFor(f.a.selectionKey); original.running = false; original.endpoints = false;
  await expect(shared.prepareSelection(f.a, operation())).resolves.toMatchObject({ state: "applied" });
  expect(original.ensures).toBe(2); expect(original.stops).toBe(0);
});

test("keeps a conflicting old_stopped journal unknown while its original daemon still runs", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); const record = readHerdrSharedInstance(f.paths)!; f.stateFor(f.a.selectionKey).endpoints = false;
  await writeHerdrSharedInstance(f.paths, { ...record, current: { ...record.current!, phase: "stopped" }, pending: { launch: f.b, phase: "old_stopped" } });
  await expect(f.build().prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
});

test("never starts an unjournaled instance through coordinator ensure", async () => {
  const f = await fixture(), shared = f.build();
  await expect(shared.ensureInstance(operation())).rejects.toThrow("No original endpoint");
  expect([...f.states.values()].every(state => state.ensures === 0)).toBe(true);
  expect(readHerdrSharedInstance(f.paths)).toBeNull();
});

test("verifies a changed candidate before disturbing the original shared instance", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); await writeFile(f.b.entryPath, "changed candidate");
  await expect(shared.prepareSelection(f.b, operation())).rejects.toMatchObject({ code: "tool_identity_changed" });
  expect(f.stateFor(f.a.selectionKey)).toMatchObject({ running: true, endpoints: true, stops: 0 });
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.a, phase: "ready" }, pending: null });
});

test("keeps an incompatible startup handshake pending with its captured daemon owner", async () => {
  const f = await fixture(), shared = f.build(); f.settings.version = "0.9.4";
  await expect(shared.prepareSelection(f.a, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.a, daemon: f.stateFor(f.a.selectionKey).proof, phase: "starting", observation: null }, pending: { phase: "starting" } });
});

test("retries a captured failed startup only after its original process and both endpoints are absent", async () => {
  const f = await fixture(), shared = f.build(); f.settings.readinessFails = true; await shared.prepareSelection(f.a, operation());
  const record = readHerdrSharedInstance(f.paths)!, original = f.stateFor(f.a.selectionKey); original.running = false; original.endpoints = false; f.settings.readinessFails = false;
  await expect(f.build().prepareSelection(f.a, operation())).resolves.toMatchObject({ state: "applied" });
  expect(original.ensures).toBe(2); expect(readHerdrSharedInstance(f.paths)?.current?.daemon).not.toEqual(record.current!.daemon);
});

test("recovers an original claim with its frozen launch while a different target remains blocked", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); const original = f.stateFor(f.a.selectionKey); original.running = false; original.endpoints = false; f.settings.responsibilities = true;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "active_instance" });
  await expect(shared.ensureExecution(f.context, operation())).resolves.toMatchObject({ version: "0.9.9", protocol: 22 });
  expect(original.ensures).toBe(2); expect(f.stateFor(f.b.selectionKey).ensures).toBe(0);
  expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.a, phase: "ready" }, pending: null });
  await expect(shared.prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "active_instance" });
});

test("restores a stopped original claim without admitting the mutable target", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); await shared.stopInstance(operation()); f.settings.responsibilities = true;
  await expect(f.build().ensureExecution(f.context, operation())).resolves.toMatchObject({ protocol: 22 });
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(2); expect(readHerdrSharedInstance(f.paths)?.current?.launch).toEqual(f.a);
});

test("does not recover a claim from a different frozen shared selection", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.b, operation()); await shared.stopInstance(operation()); f.settings.responsibilities = true;
  const journal = readHerdrSharedInstance(f.paths);
  await expect(shared.ensureExecution(f.context, operation())).rejects.toThrow(/original.*selection|frozen.*selection/i);
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(0); expect(readHerdrSharedInstance(f.paths)).toEqual(journal);
});

test("does not replay unknown shared startup during original-claim recovery", async () => {
  const f = await fixture(), shared = f.build(); f.settings.captureFails = true; await shared.prepareSelection(f.a, operation()); f.settings.captureFails = false; f.settings.responsibilities = true;
  const journal = readHerdrSharedInstance(f.paths);
  await expect(f.build().ensureExecution(f.context, operation())).rejects.toThrow(/unknown|identity|unconfirmed/i);
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1); expect(readHerdrSharedInstance(f.paths)).toEqual(journal);
});

test("does not restore the original claim while an endpoint survived its daemon", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.stateFor(f.a.selectionKey).running = false; f.settings.responsibilities = true;
  await expect(shared.ensureExecution(f.context, operation())).rejects.toThrow(/endpoint/i);
  expect(f.stateFor(f.a.selectionKey)).toMatchObject({ ensures: 1, stops: 0 });
});

test("requires the original claim configuration before shared recovery", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); await shared.stopInstance(operation());
  await expect(shared.ensureExecution({ ...f.context, claimId: "unrelated-claim" }, operation())).rejects.toMatchObject({ code: "legacy_tool_identity_missing" });
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1);
});

test("keeps a stopped daemon's native trees owned before restoring an original claim", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); await shared.stopInstance(operation()); f.settings.responsibilities = true; f.settings.mappingsStopped = false;
  await expect(shared.ensureExecution(f.context, operation())).rejects.toThrow(/native.*trees.*stopped/i);
  expect(f.stateFor(f.a.selectionKey).ensures).toBe(1); expect(readHerdrSharedInstance(f.paths)?.current?.phase).toBe("stopped");
});

test("does not switch targets until every old native mapping tree is stopped", async () => {
  const f = await fixture(), shared = f.build(); await shared.prepareSelection(f.a, operation()); f.settings.mappingsStopped = false;
  await expect(shared.prepareSelection(f.b, operation())).resolves.toEqual({ state: "pending", reason: "cleanup_unconfirmed" });
  expect(f.stateFor(f.b.selectionKey).ensures).toBe(0); expect(readHerdrSharedInstance(f.paths)).toMatchObject({ current: { launch: f.a, phase: "stopped" }, pending: { launch: f.b, phase: "old_stopped" } });
});


test("cached tool admission recreates an exited shared daemon only after every old responsibility closes", async () => {
  const f = await fixture(), shared = f.build();
  const manager = new ToolSelectionManager({ environment: {}, cwd: f.directory, readActiveSelections: () => shared.activeToolSelections(),
    resolve: async () => f.a, admitHerdr: shared.prepareSelection,
    probe: { check: async () => ({ version: "0.9.9" }), close: async () => {} },
  });
  manager.setTargets({ source: "local", revision: null, choices: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "path", path: f.a.entryPath } } });
  try {
    await manager.selectForNewExecution("herdr", "herdr", operation());
    const original = f.stateFor(f.a.selectionKey); original.running = false; original.endpoints = false;
    f.settings.mappingsStopped = false;
    await expect(manager.selectForNewExecution("herdr", "herdr", operation())).rejects.toThrow("cleanup_unconfirmed");
    expect(original.ensures).toBe(1);
    f.settings.mappingsStopped = true;
    await expect(manager.selectForNewExecution("herdr", "herdr", operation())).resolves.toEqual(f.a);
    expect(original.ensures).toBe(2);
    expect(readHerdrSharedInstance(f.paths)?.current?.daemon).toEqual(original.proof);
    await shared.ensureInstance(operation());
  } finally { await manager.close(operation()); }
});
