import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomically } from "../../platform/files.js";
import { isProcessBirth } from "../controller/linux-process-proof.js";
import { confirmControllerProcessesStopped, type ProcessProof } from "../controller/process-proof.js";
import type { ControllerJobLease } from "../controller/windows-job.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, type OwnedCommandLifecycleEvent, type OwnedCommandLifecycleSink } from "./owned-command-lifecycle.js";
import { withinExecutionDeadline } from "./execution-scope.js";
import { reconcileBotCliProbe, retainedBotCliProbes } from "./bots/cli-probe.js";

export type ExecutionResourceIdentity = { serverOrigin: string; userId: string; workerId: string };
export type ExecutionResourceRecord = {
  schemaVersion: 1; identity: ExecutionResourceIdentity; generation: string; event: OwnedCommandLifecycleEvent;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validId = (value: unknown): value is string => typeof value === "string" && uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const generationValue = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9223372036854775807n;
const exact = (input: unknown, keys: string[]): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== keys.sort().join()) throw new Error("Execution resource journal has invalid fields.");
  return input as Record<string, unknown>;
};
const identityValue = (input: unknown): ExecutionResourceIdentity => {
  const value = exact(input, ["serverOrigin", "userId", "workerId"]);
  if (typeof value.serverOrigin !== "string" || new URL(value.serverOrigin).origin !== value.serverOrigin || !validId(value.userId) || !validId(value.workerId)) throw new Error("Execution resource journal identity is invalid.");
  return { serverOrigin: value.serverOrigin, userId: value.userId, workerId: value.workerId };
};
const proofValue = (input: unknown): ProcessProof | null => {
  if (input === null) return null;
  const value = exact(input, ["pid", "parentPid", "processGroupId", "startedAt", "commandHash", ...(typeof input === "object" && Object.hasOwn(input, "jobObjectName") ? ["jobObjectName"] : [])]);
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || (value.pid as number) > 2147483647
    || !Number.isSafeInteger(value.parentPid) || (value.parentPid as number) < 0 || (value.parentPid as number) > 2147483647
    || !(value.processGroupId === null || Number.isSafeInteger(value.processGroupId) && (value.processGroupId as number) > 0)
    || !isProcessBirth(value.startedAt) || typeof value.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(value.commandHash)
    || value.jobObjectName !== undefined && (typeof value.jobObjectName !== "string" || value.jobObjectName.trim() === "" || value.jobObjectName.includes("\0"))) throw new Error("Execution resource journal process proof is invalid.");
  return { pid: value.pid as number, parentPid: value.parentPid as number, processGroupId: value.processGroupId as number | null,
    startedAt: value.startedAt, commandHash: value.commandHash, ...(value.jobObjectName === undefined ? {} : { jobObjectName: value.jobObjectName as string }) };
};
const eventValue = (input: unknown): OwnedCommandLifecycleEvent => {
  const value = exact(input, ["resourceId", "sequence", "stage", "proof"]);
  if (!validId(value.resourceId) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !["prepared", "bound", "stopped", "unknown"].includes(value.stage as string)) throw new Error("Execution resource journal event is invalid.");
  const proof = proofValue(value.proof);
  if (value.stage === "prepared" && (value.sequence !== 1 || proof !== null) || value.stage === "bound" && proof === null) throw new Error("Execution resource journal event has inconsistent birth evidence.");
  return { resourceId: value.resourceId, sequence: value.sequence as number, stage: value.stage as OwnedCommandLifecycleEvent["stage"], proof };
};
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const syncDirectory = async (directory: string): Promise<void> => {
  // Windows cannot open directories with fs.open; the replacement file is flushed.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};

/** The original Worker instance lock must cover the journal and all of its writers. */
export const openExecutionResourceJournal = async (options: { directory: string; identity: ExecutionResourceIdentity; syncDirectory?: (directory: string) => Promise<void> }) => {
  const directory = path.resolve(options.directory), identity = identityValue(options.identity);
  const flushDirectory = options.syncDirectory ?? syncDirectory;
  const records = new Map<string, ExecutionResourceRecord>(), failures = new Map<string, unknown>();
  const admitted = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  let tail = Promise.resolve();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const location = await lstat(directory);
  if (!location.isDirectory() || location.isSymbolicLink() || process.platform !== "win32" && (location.uid !== process.getuid!() || (location.mode & 0o077) !== 0)) throw new Error("Execution resource journal requires a private physical directory.");
  await flushDirectory(path.dirname(directory));
  const file = (resourceId: string): string => path.join(directory, `${resourceId}.json`);
  const readRecord = async (filename: string): Promise<ExecutionResourceRecord> => {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 || process.platform !== "win32" && (metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0)) throw new Error("Execution resource journal requires bounded private physical records.");
    const value = exact(JSON.parse(await readFile(filename, "utf8")), ["schemaVersion", "identity", "generation", "event"]);
    if (value.schemaVersion !== 1 || !same(identityValue(value.identity), identity) || !generationValue(value.generation)) throw new Error("Execution resource journal conflicts with the original Worker identity.");
    const event = eventValue(value.event);
    if (path.basename(filename) !== `${event.resourceId}.json`) throw new Error("Execution resource journal filename conflicts with its resource identity.");
    return { schemaVersion: 1, identity: { ...identity }, generation: value.generation, event };
  };
  const read = (): Promise<ExecutionResourceRecord[]> => {
    const work = tail.then(async () => {
      const observed = new Map<string, ExecutionResourceRecord>();
      for (const name of await readdir(directory)) {
        // Interrupted atomic replacements never authorize dispatch; the preceding
        // committed reservation remains authoritative and temporary bytes stay intact.
        if (name.endsWith(".tmp")) continue;
        if (!name.endsWith(".json")) throw new Error("Execution resource journal contains an unrecognized record.");
        const record = await readRecord(path.join(directory, name)); observed.set(record.event.resourceId, record);
      }
      for (const [resourceId] of records) if (!observed.has(resourceId)) throw new Error("Execution resource journal lost a previously observed reservation.");
      records.clear(); for (const [resourceId, record] of observed) records.set(resourceId, record);
      return structuredClone([...records.values()]);
    });
    tail = work.then(() => undefined, () => undefined);
    return work;
  };
  await read();
  const sink = (generation: string): OwnedCommandLifecycleSink => {
    if (!generationValue(generation)) throw new TypeError("Execution resource generation must be a positive int64 string.");
    return input => {
      const event = eventValue(structuredClone(input));
      // Keep this journal's original admission even if its first atomic write
      // fails before a file exists. A global live owner cannot select a journal.
      const originalGeneration = records.get(event.resourceId)?.generation ?? admitted.get(event.resourceId);
      if (originalGeneration !== undefined && originalGeneration !== generation) return Promise.reject(new Error("Execution resource generation conflicts with its original reservation."));
      admitted.set(event.resourceId, generation);
      const work = tail.then(async () => {
        let previous: ExecutionResourceRecord | undefined;
        try { previous = await readRecord(file(event.resourceId)); records.set(event.resourceId, previous); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          if (records.has(event.resourceId)) throw new Error("Execution resource journal lost a previously observed reservation.");
        }
        if (previous !== undefined) {
          if (previous.generation !== generation) throw new Error("Execution resource generation conflicts with its original reservation.");
          if (previous.event.proof !== null && event.proof !== null && !same(previous.event.proof, event.proof)) throw new Error("Execution resource boundary conflicts with its original birth identity.");
          if (event.sequence < previous.event.sequence) return;
          if (event.sequence === previous.event.sequence) {
            if (!same(previous.event, event)) throw new Error("Execution resource event sequence conflicts with its saved event.");
            // Rename can commit before its directory durability barrier fails.
            // Re-observing identical bytes must finish that barrier before acknowledgement.
            await flushDirectory(directory);
            failures.delete(event.resourceId);
            return;
          }
          if (previous.event.stage === "stopped") {
            if (!same(previous.event.proof, event.proof) || event.stage !== "stopped" && event.stage !== "unknown") throw new Error("A stopped execution resource cannot become active again.");
            // A late failure observation cannot reopen a proven boundary. Preserve
            // the original terminal fact and finish any failed persistence barrier.
            await flushDirectory(directory);
            failures.delete(event.resourceId);
            return;
          }
          if (previous.event.proof !== null && event.proof === null) throw new Error("Execution resource event cannot discard original boundary evidence.");
        } else if (event.stage !== "prepared" || event.sequence !== 1) throw new Error("Execution resource has no original prepared reservation.");
        const record: ExecutionResourceRecord = { schemaVersion: 1, identity: { ...identity }, generation, event };
        await replaceFileAtomically(file(event.resourceId), JSON.stringify(record), 0o600);
        await flushDirectory(directory);
        records.set(event.resourceId, record);
        failures.delete(event.resourceId);
      });
      const observed = work.catch(error => { failures.set(event.resourceId, error); throw error; }).finally(() => pending.delete(observed));
      pending.add(observed); tail = observed.catch(() => undefined); return observed;
    };
  };
  const drain = async (): Promise<void> => { await tail; if (failures.size) throw new AggregateError([...failures.values()], "Execution resource responsibility could not be saved."); };
  const assertClosed = async (): Promise<void> => {
    await read();
    if (pending.size || failures.size || [...records.values()].some(record => record.event.stage !== "stopped")) throw new Error("Execution resource journal retains unconfirmed boundaries; a replacement scope is forbidden.");
  };
  /** Observe only the saved boundary. A PID's absence alone cannot close its descendants. */
  const reconcile = async (resourceId: string, settings: { deadline: number; lease?: ControllerJobLease }): Promise<void> => {
    await read();
    const original = records.get(resourceId);
    if (original === undefined) throw new Error("Execution resource has no original reservation.");
    if (original.event.stage === "stopped") {
      await sink(original.generation)(original.event);
      return;
    }
    if (original.event.proof === null) throw new Error("Execution resource birth evidence is unavailable; responsibility is retained.");
    if (!await confirmControllerProcessesStopped(original.event.proof, [], settings.deadline, settings.lease)) throw new Error("Execution resource original boundary remains occupied.");
    if (Date.now() >= settings.deadline) throw new Error("Original execution resource reconciliation exceeded its deadline.");
    await sink(original.generation)({ ...original.event, sequence: original.event.sequence + 1, stage: "stopped" });
  };
  return {
    sink, read, drain, assertClosed, reconcile,
    snapshot: () => ({ records: structuredClone([...records.values()]), pending: pending.size, failures: [...failures.keys()] }),
    /** Join each original resource owner without waiting for broader producer lifetimes. */
    reconcileRetained: async (settings: { generation?: string; deadline: number }): Promise<void> => {
      if (settings.generation !== undefined && !generationValue(settings.generation)) throw new TypeError("Execution resource generation must be a positive int64 string.");
      // Read joins pending original writes but does not let a historical save
      // rejection prevent observing the retained process and output owners.
      const observed = await withinExecutionDeadline(read(), settings.deadline);
      const live = new Map(retainedOwnedCommandBoundaries().map(entry => [entry.resourceId, entry]));
      const probes = new Map(retainedBotCliProbes().map(entry => [entry.launchId, entry]));
      const resources = new Map(observed.map(record => [record.event.resourceId, record.generation]));
      for (const [resourceId, generation] of admitted) if (!resources.has(resourceId)) resources.set(resourceId, generation);
      const results = await Promise.allSettled([...resources].filter(([, generation]) => settings.generation === undefined || generation === settings.generation).map(async ([resourceId, generation]) => {
        const original = observed.find(record => record.event.resourceId === resourceId);
        const retained = live.get(resourceId);
        const probe = probes.get(resourceId);
        if (retained !== undefined && probe !== undefined) throw new Error("Execution resource has conflicting original owners.");
        if (retained !== undefined) {
          if (original !== undefined && original.event.proof !== null && !same(original.event.proof, retained.proof)) throw new Error("Retained execution resource conflicts with its saved birth identity.");
          await reconcileOwnedCommandBoundary(resourceId, sink(generation), settings.deadline);
        } else if (probe !== undefined) {
          if (original !== undefined && original.event.proof !== null && !same(original.event.proof, probe.process)) throw new Error("Retained probe resource conflicts with its saved birth identity.");
          // Probes share the journal but retain their own process, output and
          // save owners. Their original close joins an in-flight stop; a bare
          // process observation cannot replace that receipt or its durability.
          await withinExecutionDeadline(reconcileBotCliProbe(resourceId), settings.deadline);
        } else if (original === undefined || original.event.stage !== "stopped" || failures.has(resourceId)) {
          await withinExecutionDeadline(reconcile(resourceId, settings), settings.deadline);
        }
      }));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      try { await withinExecutionDeadline(drain(), settings.deadline); } catch (error) { errors.push(error); }
      try { await withinExecutionDeadline(assertClosed(), settings.deadline); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Original execution resources remain unconfirmed after reconciliation.");
    },
  };
};
export type ExecutionResourceJournal = Awaited<ReturnType<typeof openExecutionResourceJournal>>;
