import { lstat } from "node:fs/promises";
import { Socket } from "node:net";
import { gte, valid } from "semver";
import type { Operation } from "../../../api/operation.js";
import { withinOperation } from "../../../platform/tool-io.js";
import { parseResolvedToolLaunch } from "../../../platform/tool-launch-record.js";
import { ToolSelectionError, verifyToolLaunch, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { captureProcessProof, inspectProcessProof } from "../../controller/process-proof.js";
import { createWorkerHerdr, type HerdrExecutionContext, type WorkerHerdrAdapter } from "../herdr.js";
import type { ActiveToolSelection, HerdrToolAdmission } from "../tool-selection.js";
import { parseFrozenToolObservation } from "../tool-observation.js";
import type { HerdrInstanceReady, HerdrInstanceStopped } from "./instance.js";
import { herdrIpcAddress } from "./rpc.js";
import { readHerdrSharedInstance, writeHerdrSharedInstance, type HerdrSharedInstanceRecord } from "./shared-instance-store.js";
import { confirmToolLaunchMappingsStopped, readToolLaunchMappingInventory } from "./tool-launch-inventory.js";

type EndpointState = { api: boolean; client: boolean };
type Options = Parameters<typeof createWorkerHerdr>[0] & {
  hasResponsibilities(): boolean;
  instanceFactory?: typeof createWorkerHerdr;
  captureProcess?: typeof captureProcessProof;
  inspectProcess?: typeof inspectProcessProof;
  inspectEndpoints?: (operation: Operation) => Promise<EndpointState>;
  confirmMappingsStopped?: (operation: Operation) => Promise<boolean>;
};
const pending = (reason: "active_instance" | "cleanup_unconfirmed") => ({ state: "pending" as const, reason });
const empty = (): HerdrSharedInstanceRecord => ({ schemaVersion: 1, current: null, pending: null });
const exists = async (file: string): Promise<boolean> => {
  try { await lstat(file); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
};
const probe = (endpoint: string, operation: Operation): Promise<boolean> => new Promise((resolve, reject) => {
  operation.check();
  const socket = new Socket(); let outcome: boolean | Error | undefined;
  const finish = (value: boolean | Error) => { if (outcome !== undefined) return; outcome = value; socket.destroy(); };
  const abort = () => finish(operation.signal.reason instanceof Error ? operation.signal.reason : new Error("Shared Herdr endpoint inspection was cancelled."));
  const timer = setTimeout(() => finish(new Error("Shared Herdr endpoint inspection timed out.")), Math.max(1, Math.ceil(Math.min(1000, operation.remainingMs()))));
  socket.once("connect", () => finish(true));
  socket.once("error", error => finish("code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED") ? false : error));
  socket.once("close", () => {
    clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
    if (outcome instanceof Error) reject(outcome); else if (outcome === undefined) reject(new Error("Shared Herdr endpoint inspection did not complete.")); else resolve(outcome);
  });
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  else try { socket.connect({ path: herdrIpcAddress(endpoint) }); } catch (error) { finish(error instanceof Error ? error : new Error("Cannot inspect the shared Herdr endpoint.", { cause: error })); }
});

/** Keep the shared daemon's process owner separate from mutable Worker targets. */
export const createSharedWorkerHerdr = (options: Options): WorkerHerdrAdapter & { prepareSelection: HerdrToolAdmission; reserveSelection(launch: ResolvedToolLaunch, persist: () => void, operation: Operation): Promise<void>; ensureExecution(context: Omit<HerdrExecutionContext, "cwd">, operation: Operation): Promise<HerdrInstanceReady>; activeToolSelections(): ActiveToolSelection[] } => {
  const { hasResponsibilities, instanceFactory = createWorkerHerdr, captureProcess = captureProcessProof, inspectProcess = inspectProcessProof, inspectEndpoints, confirmMappingsStopped, ...base } = options;
  const adapters = new Map<string, WorkerHerdrAdapter>();
  let tail = Promise.resolve(), startup: { selectionKey: string; operation: Operation } | null = null;
  const read = () => readHerdrSharedInstance(base.paths);
  const write = async (record: HerdrSharedInstanceRecord) => { await writeHerdrSharedInstance(base.paths, record); return record; };
  const serialized = async <T>(operation: Operation, action: () => Promise<T>): Promise<T> => {
    const previous = tail; let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }); tail = previous.then(() => current);
    try { await withinOperation(previous, operation); operation.check(); return await action(); }
    finally { release(); }
  };
  const adapter = (launch: ResolvedToolLaunch | null): WorkerHerdrAdapter => {
    const key = launch?.selectionKey ?? "legacy"; let result = adapters.get(key);
    if (result === undefined) {
      result = instanceFactory({ ...base, herdrLaunch: launch ?? undefined, retainOnStartupFailure: true,
        onDaemonSpawn: async pid => {
          const owner = startup;
          if (owner === null || owner.selectionKey !== key) throw new Error("A shared daemon spawn requires its original durable startup intent.");
          const proof = await withinOperation(captureProcess(pid, Math.max(1, Math.ceil(Math.min(5000, owner.operation.remainingMs())))), owner.operation);
          const record = read();
          if (record?.pending?.phase !== "starting" || record.current?.phase !== "starting" || record.current.launch?.selectionKey !== key || record.current.daemon !== null) throw new Error("The original shared daemon startup intent changed before process registration.");
          await write({ ...record, current: { ...record.current, daemon: proof } });
          await base.onDaemonSpawn?.(pid);
        } });
      adapters.set(key, result);
    }
    return result;
  };
  const original = () => adapter(read()?.current?.launch ?? null);
  const paths = original().paths;
  const endpoints = async (operation: Operation): Promise<EndpointState> => {
    operation.check();
    if (inspectEndpoints) return withinOperation(inspectEndpoints(operation), operation);
    const [api, client] = await Promise.all([probe(paths.apiEndpoint, operation), probe(paths.clientEndpoint, operation)]);
    return { api, client };
  };
  const closedEndpoints = async (operation: Operation): Promise<boolean> => { const state = await endpoints(operation); return !state.api && !state.client; };
  const mappingsStopped = (operation: Operation) => confirmMappingsStopped ? withinOperation(confirmMappingsStopped(operation), operation) : confirmToolLaunchMappingsStopped(base.paths.herdrDirectory, base.environment ?? process.env, operation);
  const legacyPresence = async (operation: Operation): Promise<boolean> => {
    const [configuration, session, state] = await Promise.all([withinOperation(exists(paths.configurationFile), operation), withinOperation(exists(paths.sessionDirectory), operation), endpoints(operation)]);
    return configuration || session || state.api || state.client;
  };
  const observation = (ready: HerdrInstanceReady) => {
    if (ready.protocol !== 22 || valid(ready.version) === null || !gte(ready.version, "0.9.5")) throw new Error("The shared Herdr handshake is incompatible with protocol 22.");
    return parseFrozenToolObservation({ version: ready.version, checkedAt: new Date().toISOString() });
  };
  const inspect = (record: NonNullable<HerdrSharedInstanceRecord["current"]>, operation: Operation) => {
    if (record.daemon === null) throw new Error("The original shared daemon has no process identity; its startup or shutdown remains unknown.");
    return withinOperation(inspectProcess(record.daemon), operation);
  };
  const connectOriginal = async (operation: Operation) => {
    const current = read()?.current;
    if (current?.launch !== null && current?.launch !== undefined && (current.phase === "stopped" || current.daemon === null || await inspect(current, operation) !== "running")) throw new Error("The original shared Herdr daemon cannot be confirmed running.");
    const result = await adapter(current?.launch ?? null).connectInstance(operation);
    if (current?.daemon !== null && current?.daemon !== undefined && await inspect(current, operation) !== "running") throw new Error("The original shared Herdr daemon changed during connection.");
    return result;
  };
  const reconnect = async (record: HerdrSharedInstanceRecord, operation: Operation): Promise<HerdrSharedInstanceRecord> => {
    const current = record.current;
    if (current?.launch === null || current?.launch === undefined || await inspect(current, operation) !== "running") throw new Error("The original shared daemon cannot be confirmed running.");
    const ready = await adapter(current.launch).connectInstance(operation), observed = observation(ready);
    if (await inspect(current, operation) !== "running") throw new Error("The original shared daemon changed during its handshake.");
    return write({ ...record, current: { ...current, observation: observed, phase: "ready" }, pending: null });
  };
  const closeOriginal = async (record: HerdrSharedInstanceRecord, operation: Operation): Promise<{ record: HerdrSharedInstanceRecord; stopped: HerdrInstanceStopped }> => {
    let current = record.current;
    if (current === null) {
      if (!await closedEndpoints(operation)) throw new Error("An unowned shared Herdr endpoint remains reachable.");
      return { record: await write({ ...record, pending: record.pending === null ? null : { ...record.pending, phase: "old_stopped" } }), stopped: { apiClosed: true, clientClosed: true, ownedChildClosed: null } };
    }
    const state = current.daemon === null ? null : await inspect(current, operation);
    if (state !== null && state !== "running") {
      // Do not send server.stop to an endpoint after the original process has gone.
      if (!await closedEndpoints(operation)) throw new Error("The original shared daemon exited but an unowned endpoint remains reachable.");
    } else {
      record = await write({ ...record, current: { ...current, phase: "stopping" } }); current = record.current!;
      const stopped = await adapter(current.launch).stopInstance(operation);
      if (!stopped.apiClosed || !stopped.clientClosed || !await closedEndpoints(operation)) throw new Error("The original shared endpoints have not both closed.");
      // Legacy RPC acknowledgements establish endpoint closure, never a missing birth identity.
      if (current.daemon === null) throw new Error("The legacy shared daemon has no original process proof; cleanup remains unconfirmed.");
      while (await inspect(current, operation) === "running") {
        operation.check(); await new Promise(resolve => setTimeout(resolve, Math.min(25, operation.remainingMs())));
      }
    }
    record = await write({ ...record, current: { ...current, phase: "stopped" }, pending: record.pending === null ? null : { ...record.pending, phase: "old_stopped" } });
    return { record, stopped: { apiClosed: true, clientClosed: true, ownedChildClosed: null } };
  };
  const startOriginal = async (launch: ResolvedToolLaunch, operation: Operation): Promise<HerdrInstanceReady> => {
    await verifyToolLaunch(launch, operation);
    if (!await mappingsStopped(operation)) throw new Error("The original shared native process trees are not confirmed stopped.");
    if (!await closedEndpoints(operation)) throw new Error("The original shared endpoints are not confirmed closed.");
    await write({ schemaVersion: 1, current: { launch, observation: null, daemon: null, phase: "starting" }, pending: { launch, phase: "starting" } });
    startup = { selectionKey: launch.selectionKey, operation };
    try {
      const ready = await adapter(launch).ensureInstance(operation), observed = observation(ready), record = read();
      if (record?.current?.launch?.selectionKey !== launch.selectionKey || await inspect(record.current, operation) !== "running") throw new Error("The original shared daemon startup identity remains unconfirmed.");
      await write({ schemaVersion: 1, current: { ...record.current, observation: observed, phase: "ready" }, pending: null });
      return ready;
    } finally { startup = null; }
  };
  const ensureExecution = (context: Omit<HerdrExecutionContext, "cwd">, operation: Operation) => serialized(operation, async (): Promise<HerdrInstanceReady> => {
    const configuration = base.readExecutionConfiguration?.(context);
    if (configuration?.herdrLaunch === undefined) throw new ToolSelectionError("herdr", "herdr", "launch", "legacy_tool_identity_missing");
    if (configuration.agentControlMode !== "herdr" || configuration.agent !== context.agent) throw new Error("The frozen shared execution configuration belongs to another provider or mode.");
    const launch = parseResolvedToolLaunch(configuration.herdrLaunch, { tool: "herdr", context: "herdr" });
    let record = read();
    if (record?.current?.launch === null || record?.current === null || record === null) throw new ToolSelectionError("herdr", "herdr", "launch", "legacy_tool_identity_missing");
    if (record.current.launch.selectionKey !== launch.selectionKey) throw new Error("The original shared selection differs from the claim's frozen selection; recovery cannot switch tools.");
    if (record.current.daemon === null) throw new Error("The original shared startup process identity is unknown; recovery cannot replay it.");
    if (record.pending?.phase === "starting" && (record.current.phase !== "starting" || record.pending.launch.selectionKey !== launch.selectionKey)) throw new Error("The original shared startup intent conflicts with the frozen execution selection.");
    if (await inspect(record.current, operation) === "running") {
      if (record.current.phase !== "ready" && record.current.phase !== "starting") throw new Error("The original shared daemon shutdown remains unconfirmed.");
      const ready = await adapter(record.current.launch).connectInstance(operation), observed = observation(ready);
      if (await inspect(record.current, operation) !== "running") throw new Error("The original shared daemon changed during execution recovery.");
      await write({ ...record, current: { ...record.current, phase: "ready", observation: observed }, pending: record.pending?.phase === "starting" ? null : record.pending });
      return ready;
    }
    // This entry point receives an already authorized original claim. It may
    // recreate only that same frozen daemon after every old process tree closes.
    await verifyToolLaunch(launch, operation);
    if (!await mappingsStopped(operation)) throw new Error("The original shared native process trees are not confirmed stopped.");
    record = (await closeOriginal(record, operation)).record;
    return startOriginal(launch, operation);
  });
  const prepareSelection: HerdrToolAdmission = (input, operation) => serialized(operation, async () => {
    const launch = parseResolvedToolLaunch(input, { tool: "herdr", context: "herdr" });
    await verifyToolLaunch(launch, operation);
    let record = read();
    if (record === null) {
      const legacy = await legacyPresence(operation);
      record = empty();
      if (legacy) record.current = { launch: null, observation: null, daemon: null, phase: "ready" };
      await write(record);
    }
    if (record.pending?.phase === "starting") {
      if (record.current?.daemon === null || record.current === null || record.current.phase !== "starting" || record.current.launch?.selectionKey !== record.pending.launch.selectionKey) return pending("cleanup_unconfirmed");
      try {
        if (await inspect(record.current, operation) === "running") record = await reconnect(record, operation);
        else record = (await closeOriginal(record, operation)).record;
      } catch { operation.check(); return pending("cleanup_unconfirmed"); }
    }
    if (record.pending === null && record.current?.phase === "ready" && record.current.launch?.selectionKey === launch.selectionKey) {
      try {
        if (await inspect(record.current, operation) === "running") {
          record = await reconnect(record, operation);
          return { state: "applied", ...record.current!.observation! };
        }
      } catch { operation.check(); return pending("cleanup_unconfirmed"); }
    }
    if (hasResponsibilities()) return pending("active_instance");
    if (record.pending?.phase !== "old_stopped") {
      record = await write({ ...record, pending: { launch, phase: "intent" } });
      try { record = (await closeOriginal(record, operation)).record; }
      catch { operation.check(); return pending("cleanup_unconfirmed"); }
    }
    try {
      if (record.current !== null && (record.current.phase !== "stopped" || record.current.daemon === null || await inspect(record.current, operation) === "running")) return pending("cleanup_unconfirmed");
      if (!await closedEndpoints(operation)) return pending("cleanup_unconfirmed");
    } catch { operation.check(); return pending("cleanup_unconfirmed"); }
    if (hasResponsibilities()) return pending("active_instance");
    // Nothing was submitted in old_stopped; a newer target may replace this candidate.
    try {
      await startOriginal(launch, operation);
      return { state: "applied", ...read()!.current!.observation! };
    } catch { operation.check(); return pending("cleanup_unconfirmed"); }
  });
  const reserveSelection = (input: ResolvedToolLaunch, persist: () => void, operation: Operation): Promise<void> => serialized(operation, async () => {
    const launch = parseResolvedToolLaunch(input, { tool: "herdr", context: "herdr" });
    await verifyToolLaunch(launch, operation);
    const record = read();
    if (record?.pending !== null || record.current?.phase !== "ready" || record.current.launch?.selectionKey !== launch.selectionKey) throw new Error("The shared Herdr selection changed before claim reservation.");
    if (await inspect(record.current, operation) !== "running") throw new Error("The original shared daemon stopped before claim reservation.");
    operation.check();
    // The synchronous durable write becomes a responsibility before releasing
    // the same mutex used to replace this daemon. No claim has been sent yet.
    persist();
  });
  const tasks = new Proxy({} as WorkerHerdrAdapter["tasks"], { get: (_target, key) => {
    const manager = original().tasks, value = Reflect.get(manager, key) as unknown;
    return typeof value === "function" ? value.bind(manager) : value;
  } });
  const nativeSelections = (): ActiveToolSelection[] => {
    let mappings: ReturnType<typeof readToolLaunchMappingInventory>;
    try { mappings = readToolLaunchMappingInventory(base.paths.herdrDirectory); }
    catch {
      // Damaged evidence cannot establish which original native tools remain.
      return (["codex", "copilot"] as const).map(tool => ({ tool, context: "herdr", launch: null, version: null, checkedAt: null, executionCount: null, instanceCount: 0, unconfirmedCount: 1 }));
    }
    return mappings.filter(mapping => mapping.started && !mapping.retired).map(mapping => {
      let observed: ReturnType<typeof parseFrozenToolObservation> | null = null;
      try {
        const configuration = base.readExecutionConfiguration?.(mapping.owner);
        if (configuration?.agentControlMode === "herdr" && configuration.agent === mapping.launch.tool && configuration.toolLaunch?.selectionKey === mapping.launch.selectionKey && configuration.toolObservation !== undefined) observed = parseFrozenToolObservation(configuration.toolObservation);
      } catch { /* Missing historical configuration cannot supply a new observation. */ }
      // A synchronous retained intent proves responsibility, not process liveness.
      return { tool: mapping.launch.tool, context: "herdr", launch: mapping.launch, version: observed?.version ?? null, checkedAt: observed?.checkedAt ?? null, executionCount: null, instanceCount: 0, unconfirmedCount: 1 };
    });
  };
  return {
    paths, tasks, prepareSelection, reserveSelection, ensureExecution,
    get attachment() { return original().attachment; },
    createShellStartup: () => original().createShellStartup(),
    // Only admission owns spawning. Repeated coordinator ensures reconnect to the retained owner.
    ensureInstance: operation => serialized(operation, () => connectOriginal(operation)),
    connectInstance: operation => serialized(operation, () => connectOriginal(operation)),
    stopInstance: operation => serialized(operation, async () => {
      let record = read();
      if (record === null) {
        if (!await legacyPresence(operation)) return original().stopInstance(operation);
        record = await write({ schemaVersion: 1, current: { launch: null, observation: null, daemon: null, phase: "stopping" }, pending: null });
      }
      return (await closeOriginal(record, operation)).stopped;
    }),
    activeToolSelections: () => {
      const record = read(), current = record?.current, native = nativeSelections();
      if (current === null || current === undefined || current.phase === "stopped") {
        if (record !== null || !hasResponsibilities()) return native;
        return [{ tool: "herdr", context: "herdr", launch: null, version: null, checkedAt: null, executionCount: 0, instanceCount: null, unconfirmedCount: 1 }, ...native];
      }
      const uncertain = current.phase !== "ready" || current.daemon === null || current.observation === null;
      return [{ tool: "herdr", context: "herdr", launch: current.launch, version: current.observation?.version ?? null, checkedAt: current.observation?.checkedAt ?? null, executionCount: 0, instanceCount: uncertain ? null : 1, unconfirmedCount: uncertain ? 1 : 0 }, ...native];
    },
  };
};
