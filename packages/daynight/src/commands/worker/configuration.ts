import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeWorkerCloudJsonSource, parseWorkerCloudDesired, parseWorkerCloudItem, parseWorkerCloudReceipt, parseWorkerCloudRevision, parseWorkerCloudValue } from "../../api/worker-configuration.js";
import { canonicalId } from "../../api/parse.js";
import { ProtocolError } from "../../api/validation.js";
import type { WorkerCloudDesired, WorkerCloudFailure, WorkerCloudItem, WorkerCloudItemKey, WorkerCloudNative, WorkerCloudProject, WorkerCloudReceipt, WorkerCloudReport, WorkerCloudValue } from "../../api/worker-configuration.js";
import type { AgentControlMode } from "../../api/types.js";
import { parseToolPathsBootstrap } from "../../api/worker-tool-paths.js";
import { replaceFileAtomically } from "../../platform/files.js";
import { parseLocalToolPaths, type Tool, type ToolPathChoice, type ToolPaths } from "../../platform/tool-path-choice.js";

export type WorkerConfigurationIdentity = { readonly serverOrigin: string; readonly userId: string; readonly workerId: string };
export type WorkerConfigurationToolTargets = { readonly source: "local" | "cloud"; readonly revision: string | null; readonly choices: ToolPaths };
export type WorkerNativeToolSelectionKeys = Readonly<Partial<Record<Tool, string>>>;
export type WorkerConfigurationSnapshot = {
  readonly synchronized: boolean;
  readonly desired: WorkerCloudDesired | null;
  readonly observationRevision: string;
  readonly items: readonly WorkerCloudItem[];
  readonly toolTargets: WorkerConfigurationToolTargets | null;
  readonly effective: {
    readonly agentControlMode: AgentControlMode | null;
    readonly maxConcurrent: number | null;
    readonly pollIntervalMs: number | null;
    readonly recoveryLimit: number | null;
    readonly preferPlatformSpecificTasks: boolean | null;
    readonly native: WorkerCloudNative | null;
    readonly projects: readonly { readonly projectId: string; readonly native: WorkerCloudNative | null; readonly ready: boolean }[];
  };
};
export type WorkerConfigurationProjectAdapters = {
  readonly prepare?: (projectId: string, signal: AbortSignal) => Promise<void | false>;
  readonly remove?: (projectId: string, signal: AbortSignal) => Promise<void>;
};
type WorkerNativeApplicationOutcome =
  | { readonly kind: "started" | "cancelled" | "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown; readonly nextAttemptAt: string };
export type WorkerNativeApplicationEvent = { readonly key: { readonly kind: "native" } | { readonly kind: "projectNative"; readonly projectId: string }; readonly revision: string; readonly target: WorkerCloudNative } & WorkerNativeApplicationOutcome;
export type WorkerConfigurationManagerOptions = {
  readonly file: string;
  readonly identity: WorkerConfigurationIdentity;
  readonly signal: AbortSignal;
  readonly localControlMode?: AgentControlMode;
  readonly localToolPaths?: ToolPaths;
  /** Runtime-owned, verified selections for this mode; omitted keys remain unverified. */
  readonly readToolSelectionKeys?: (native: WorkerCloudNative, mode: AgentControlMode) => WorkerNativeToolSelectionKeys;
  readonly applyNative: (native: WorkerCloudNative, signal: AbortSignal, mode: AgentControlMode) => Promise<void>;
  readonly onChange?: (snapshot: WorkerConfigurationSnapshot) => void;
  readonly onNativeApplication?: (event: WorkerNativeApplicationEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly onCapacity?: (revision: string) => void;
  readonly onInvalidDesired?: (revision: string) => void;
  readonly now?: () => number;
  readonly persist?: (file: string, contents: string) => Promise<void>;
};
type StoredItem = { readonly value: WorkerCloudItem; readonly attempts: number; readonly failureId: number | null; readonly started: boolean };
type NativeProof = { readonly mode: AgentControlMode; readonly native: WorkerCloudNative; readonly tools: readonly { readonly tool: Tool; readonly choice: ToolPathChoice | null; readonly selectionKey: string | null }[] };
type Cache = { readonly schemaVersion: 4; readonly nativeModes: Readonly<Record<string, AgentControlMode>>; readonly identity: WorkerConfigurationIdentity; readonly desired: WorkerCloudDesired | null; readonly observationRevision: string; readonly nextFailureId: number; readonly items: readonly StoredItem[] };
type Job = { readonly revision: string; readonly controller: AbortController; readonly promise: Promise<void>; readonly proof: NativeProof | null };
const supportsMode = (desired: WorkerCloudDesired | null): boolean => desired !== null && Object.hasOwn(desired.value, "agentControlMode");
const capabilities = (value: WorkerCloudValue | undefined) => ({ controlMode: value !== undefined && Object.hasOwn(value, "agentControlMode"), toolPaths: value !== undefined && Object.hasOwn(value, "toolPaths") });
const parseDesired = (value: WorkerCloudDesired, limits = true): WorkerCloudDesired => parseWorkerCloudDesired(value, limits, capabilities(value.value));
const retryDelays = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
class WorkerConfigurationCapacityError extends RangeError {}
const keyOf = (key: WorkerCloudItemKey): string => `${key.kind}:${"projectId" in key ? key.projectId : ""}`;
const equal = (first: unknown, second: unknown): boolean => JSON.stringify(first) === JSON.stringify(second);
const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const exactObject = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError("Worker configuration cache has an invalid structure.");
  return value as Record<string, unknown>;
};
const counter = (value: unknown, minimum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError("Worker configuration cache has an invalid counter.");
  return value;
};
const parseCache = (source: string, identity: WorkerConfigurationIdentity): { cache: Cache; migrated: boolean } => {
  const raw = decodeWorkerCloudJsonSource(source) as Record<string, unknown>;
  const data = exactObject(raw, ["schemaVersion", "identity", "desired", "observationRevision", "nextFailureId", "items", ...(raw.schemaVersion === 3 || raw.schemaVersion === 4 ? ["nativeModes"] : [])]);
  const scope = exactObject(data.identity, ["serverOrigin", "userId", "workerId"]);
  if (data.schemaVersion !== 1 && data.schemaVersion !== 2 && data.schemaVersion !== 3 && data.schemaVersion !== 4 || scope.serverOrigin !== identity.serverOrigin || scope.userId !== identity.userId || scope.workerId !== identity.workerId) throw new Error("Worker configuration cache identity or schema does not match this Worker.");
  const migrated = data.schemaVersion !== 4;
  const preferenceMigration = data.schemaVersion === 1;
  let desiredSource = data.desired;
  if (preferenceMigration && desiredSource !== null) {
    const previous = exactObject(desiredSource, ["revision", "updatedAt", "value"]);
    const value = exactObject(previous.value, ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "native", "projects"]);
    desiredSource = { ...previous, value: { ...value, preferPlatformSpecificTasks: false } };
  }
  // Historical cache entries are read structurally so a new valid target can repair them.
  const desired = desiredSource === null ? null : parseDesired(desiredSource as WorkerCloudDesired, false);
  if (!Array.isArray(data.items)) throw new TypeError("Worker configuration cache items must be an array.");
  const seen = new Set<string>();
  const items = data.items.map(entry => {
    const stored = exactObject(entry, ["value", "attempts", "failureId", "started"]), value = parseWorkerCloudItem(stored.value, false, supportsMode(desired)), key = keyOf(value.key);
    const failureId = stored.failureId === null ? null : counter(stored.failureId, 1);
    if (seen.has(key) || desired === null || BigInt(value.targetRevision) > BigInt(desired.revision) || typeof stored.started !== "boolean" || stored.started && value.key.kind !== "projectRemoval" || (value.lastFailure === null) !== (failureId === null)) throw new TypeError("Worker configuration cache has inconsistent application results.");
    if (preferenceMigration && value.key.kind === "preferPlatformSpecificTasks") throw new TypeError("Worker configuration cache version does not match its application results.");
    seen.add(key);
    const attempts = counter(stored.attempts, 0);
    if (attempts > retryDelays.length) throw new TypeError("Worker configuration cache retry count is invalid.");
    return { value: value.state === "applying" ? { ...value, state: "pending" as const } : value, attempts, failureId, started: stored.started };
  });
  if (preferenceMigration && desired !== null) items.push({ value: {
    key: { kind: "preferPlatformSpecificTasks" }, targetRevision: desired.revision, appliedValue: null,
    state: "pending", error: null, lastFailure: null, nextAttemptAt: null,
  }, attempts: 0, failureId: null, started: false });
  const nextFailureId = counter(data.nextFailureId, 1);
  if (items.some(item => item.failureId !== null && item.failureId >= nextFailureId)) throw new TypeError("Worker configuration cache failure sequence is invalid.");
  const observationRevision = parseWorkerCloudRevision(data.observationRevision, true);
  if (desired === null && observationRevision !== "0") throw new TypeError("Worker configuration cache has an observation without a target.");
  if (desired !== null) {
    const required: WorkerCloudItemKey[] = ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native"].map(kind => ({ kind }) as WorkerCloudItemKey);
    if (supportsMode(desired)) required.push({ kind: "agentControlMode" });
    for (const project of desired.value.projects) required.push({ kind: "projectPreparation", projectId: project.projectId }, { kind: "projectNative", projectId: project.projectId });
    if (required.some(key => !items.some(item => keyOf(item.value.key) === keyOf(key) && item.value.targetRevision === desired.revision))) throw new TypeError("Worker configuration cache is missing target application results.");
  }
  const nativeModes: Record<string, AgentControlMode> = {};
  if (data.schemaVersion === 3 || data.schemaVersion === 4) {
    if (typeof data.nativeModes !== "object" || data.nativeModes === null || Array.isArray(data.nativeModes)) throw new TypeError("Worker configuration native modes are invalid.");
    for (const [key, mode] of Object.entries(data.nativeModes)) {
      if ((mode !== "herdr" && mode !== "web") || !items.some(item => keyOf(item.value.key) === key && (item.value.key.kind === "native" || item.value.key.kind === "projectNative") && item.value.appliedValue !== null)) throw new TypeError("Worker configuration native mode has no matching applied value.");
      nativeModes[key] = mode;
    }
  }
  return { cache: { schemaVersion: 4, nativeModes, identity: { ...identity }, desired, observationRevision, nextFailureId, items }, migrated };
};

const toolTargets = (cache: Cache, local: ToolPaths): WorkerConfigurationToolTargets | null => {
  const choices = cache.desired?.value.toolPaths;
  if (choices === undefined) return { source: "local", revision: null, choices: local };
  if (choices.codex === null || choices.copilot === null || choices.herdr === null) return null;
  return { source: "cloud", revision: cache.desired!.revision, choices: { codex: choices.codex, copilot: choices.copilot, herdr: choices.herdr } };
};
const nativeTools = (native: WorkerCloudNative, mode: AgentControlMode): readonly Tool[] => [
  ...(native.agent === "codex" || native.agent === "copilot" ? [native.agent] : []), ...(mode === "herdr" ? ["herdr" as const] : []),
];

export const resolveWorkerCloudProjectNative = (native: WorkerCloudNative, project: WorkerCloudProject): WorkerCloudNative => {
  const overrides = project.nativeOverrides, agent = overrides.agent === undefined ? native.agent : overrides.agent;
  return { agent, model: Object.hasOwn(overrides, "model") ? overrides.model! : agent === native.agent ? native.model : null,
    args: Object.hasOwn(overrides, "args") ? [...overrides.args!] : agent === native.agent ? [...native.args] : [] };
};

export class WorkerConfigurationApplicationError extends Error {
  constructor(readonly diagnostic: Omit<WorkerCloudFailure, "occurredAt">, options?: ErrorOptions) {
    super("Worker configuration application failed.", options);
    this.name = "WorkerConfigurationApplicationError";
  }
}
const failure = (error: unknown, key: WorkerCloudItemKey, now: number): WorkerCloudFailure => {
  if (error instanceof WorkerConfigurationApplicationError) return { ...error.diagnostic, occurredAt: new Date(now).toISOString() };
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return { code: code === "ENOENT" ? "not_found" : code === "EACCES" || code === "EPERM" ? "permission_denied" : code === "ETIMEDOUT" ? "timeout" : error instanceof TypeError || error instanceof RangeError ? "invalid_configuration" : "unavailable",
    category: key.kind === "projectPreparation" ? "repository" : key.kind === "projectRemoval" ? "runtime" : "agent",
    phase: key.kind === "projectPreparation" ? "prepare" : key.kind === "projectRemoval" ? "stop" : "validate", occurredAt: new Date(now).toISOString() };
};
const target = (cache: Cache, key: WorkerCloudItemKey): WorkerCloudItem["appliedValue"] => {
  if (key.kind === "projectRemoval") return true;
  const desired = cache.desired;
  if (desired === null) return null;
  if (key.kind === "maxConcurrent" || key.kind === "pollIntervalMs" || key.kind === "recoveryLimit" || key.kind === "preferPlatformSpecificTasks" || key.kind === "native" || key.kind === "agentControlMode") return desired.value[key.kind] ?? null;
  if (!("projectId" in key)) throw new TypeError("Worker configuration project key is invalid.");
  const project = desired.value.projects.find(project => project.projectId === key.projectId);
  if (project === undefined) return null;
  return key.kind === "projectPreparation" ? true : resolveWorkerCloudProjectNative(desired.value.native, project);
};
const replaceItem = (cache: Cache, value: StoredItem): Cache => ({ ...cache, items: cache.items.map(item => keyOf(item.value.key) === keyOf(value.value.key) ? value : item) });
const findItem = (cache: Cache, key: WorkerCloudItemKey): StoredItem | undefined => cache.items.find(item => keyOf(item.value.key) === keyOf(key));
const hasUnfinishedRemoval = (cache: Cache, projectId: string): boolean => cache.items.some(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === projectId && item.started && item.value.state !== "applied");
const snapshot = (cache: Cache, synchronized: boolean, validatedNative: ReadonlyMap<string, NativeProof>, localMode: AgentControlMode, localTools: ToolPaths, proof: (cache: Cache, native: WorkerCloudNative, mode: AgentControlMode) => NativeProof): WorkerConfigurationSnapshot => {
  const applied = (key: WorkerCloudItemKey): WorkerCloudItem["appliedValue"] => findItem(cache, key)?.value.appliedValue ?? null;
  const scalar = (kind: "maxConcurrent" | "pollIntervalMs" | "recoveryLimit"): number | null => {
    const value = applied({ kind });
    return synchronized && cache.desired !== null && typeof value === "number" ? value : null;
  };
  const mode = cache.desired?.value.agentControlMode == null ? localMode : cache.nativeModes["native:"] ?? null;
  const native = (key: WorkerCloudItemKey): WorkerCloudNative | null => {
    const value = applied(key);
    return synchronized && cache.desired !== null && mode !== null && typeof value === "object" && value !== null && equal(proof(cache, value, mode), validatedNative.get(keyOf(key))) ? value : null;
  };
  const preference = applied({ kind: "preferPlatformSpecificTasks" });
  const projects = synchronized && cache.desired !== null ? cache.desired.value.projects.map(project => ({ projectId: project.projectId, native: native({ kind: "projectNative", projectId: project.projectId }),
    ready: findItem(cache, { kind: "projectPreparation", projectId: project.projectId })?.value.state === "applied" && applied({ kind: "projectPreparation", projectId: project.projectId }) === true && !hasUnfinishedRemoval(cache, project.projectId) })) : [];
  return freeze({ synchronized, desired: cache.desired, observationRevision: cache.observationRevision, items: cache.items.map(item => item.value), toolTargets: toolTargets(cache, localTools), effective: {
    agentControlMode: cache.desired?.value.agentControlMode == null || native({ kind: "native" }) !== null || projects.some(project => project.native !== null) ? mode : null, maxConcurrent: scalar("maxConcurrent"), pollIntervalMs: scalar("pollIntervalMs"), recoveryLimit: scalar("recoveryLimit"), preferPlatformSpecificTasks: synchronized && cache.desired !== null && typeof preference === "boolean" ? preference : null, native: native({ kind: "native" }), projects,
  } });
};
const desiredTransition = (cache: Cache, desired: WorkerCloudDesired | null, localMode: AgentControlMode): Cache => {
  if (desired === null) return { ...cache, desired: null, items: [], nativeModes: {} };
  const priorSelected = new Set(cache.desired?.value.projects.map(project => project.projectId));
  const selected = new Set(desired.value.projects.map(project => project.projectId));
  const projected = new Set(cache.items.map(item => keyOf(item.value.key)));
  if (supportsMode(desired)) projected.add("agentControlMode:"); else projected.delete("agentControlMode:");
  for (const project of desired.value.projects) {
    const key: WorkerCloudItemKey = { kind: "projectRemoval", projectId: project.projectId }, removal = findItem(cache, key);
    if (removal !== undefined && !removal.started && removal.value.lastFailure === null) projected.delete(keyOf(key));
    projected.add(keyOf({ kind: "projectPreparation", projectId: project.projectId }));
    projected.add(keyOf({ kind: "projectNative", projectId: project.projectId }));
  }
  for (const kind of ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native"] as const) projected.add(keyOf({ kind }));
  for (const projectId of priorSelected) if (!selected.has(projectId)) projected.add(keyOf({ kind: "projectRemoval", projectId }));
  if (projected.size > (supportsMode(desired) ? 1026 : 1025) && projected.size > cache.items.length) throw new WorkerConfigurationCapacityError("Worker configuration observation has no capacity for additional items.");
  const nextCache = { ...cache, desired };
  const desiredMode = desired.value.agentControlMode ?? localMode;
  const items = new Map(cache.items.map(item => [keyOf(item.value.key), item]));
  if (!supportsMode(desired)) items.delete("agentControlMode:");
  const update = (key: WorkerCloudItemKey, reset = false): void => {
    const previous = items.get(keyOf(key)), appliedValue = reset ? null : previous?.value.appliedValue ?? null, desiredValue = target(nextCache, key);
    const unchanged = previous?.value.state === "applied" && appliedValue !== null && equal(appliedValue, desiredValue) && (key.kind !== "native" && key.kind !== "projectNative" || cache.nativeModes[keyOf(key)] === desiredMode && (key.kind !== "native" || cache.desired?.value.agentControlMode === desired.value.agentControlMode));
    items.set(keyOf(key), { value: { key, targetRevision: desired.revision, appliedValue, state: unchanged ? "applied" : "pending", error: null, lastFailure: previous?.value.lastFailure ?? null, nextAttemptAt: null }, attempts: 0, failureId: previous?.failureId ?? null, started: false });
  };
  for (const kind of ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native"] as const) update({ kind });
  if (supportsMode(desired)) update({ kind: "agentControlMode" });
  for (const project of desired.value.projects) {
    const removalKey: WorkerCloudItemKey = { kind: "projectRemoval", projectId: project.projectId }, removal = items.get(keyOf(removalKey));
    if (removal !== undefined && !removal.started && removal.value.lastFailure === null) items.delete(keyOf(removalKey));
    update({ kind: "projectPreparation", projectId: project.projectId }, !priorSelected.has(project.projectId));
    update({ kind: "projectNative", projectId: project.projectId });
  }
  for (const projectId of priorSelected) if (!selected.has(projectId)) {
    const key: WorkerCloudItemKey = { kind: "projectRemoval", projectId }, removal = items.get(keyOf(key));
    // A started stop owns its original revision until it finishes, even if selection changes again.
    if (removal === undefined || !removal.started || removal.value.state === "applied") update(key, true);
  }
  return { ...nextCache, items: [...items.values()].sort((first, second) => keyOf(first.value.key).localeCompare(keyOf(second.value.key))) };
};

export const createWorkerConfigurationManager = async (options: WorkerConfigurationManagerOptions) => {
  options.signal.throwIfAborted();
  const localMode = options.localControlMode ?? "herdr";
  const localTools = freeze(parseToolPathsBootstrap(options.localToolPaths ?? parseLocalToolPaths(undefined)));
  const proofFor = (current: Cache, native: WorkerCloudNative, mode: AgentControlMode): NativeProof => {
    const choices = toolTargets(current, localTools)?.choices, keys = options.readToolSelectionKeys?.(native, mode);
    return { mode, native, tools: nativeTools(native, mode).map(tool => ({ tool, choice: choices?.[tool] ?? null, selectionKey: keys?.[tool] ?? null })) };
  };
  // Legacy native validation establishes no tool-selection authority.
  const canValidateNative = (proof: NativeProof): boolean => options.readToolSelectionKeys === undefined || proof.tools.every(tool => tool.choice !== null && tool.selectionKey !== null && /^[a-f0-9]{64}$/.test(tool.selectionKey));
  const matchesProof = (current: Cache, value: WorkerCloudItem["appliedValue"] | undefined, mode: AgentControlMode | undefined, proof: NativeProof | undefined): boolean =>
    mode !== undefined && typeof value === "object" && value !== null && equal(proofFor(current, value, mode), proof);
  const intendedMode = (current: Cache): AgentControlMode => current.desired?.value.agentControlMode ?? localMode;
  const projectMode = (current: Cache): AgentControlMode | undefined => current.desired?.value.agentControlMode == null ? localMode : current.nativeModes["native:"];
  const now = options.now ?? Date.now, persist = options.persist ?? ((file, contents) => replaceFileAtomically(file, contents, 0o600));
  let cache: Cache, migrated = false;
  try { ({ cache, migrated } = parseCache(await readFile(options.file, "utf8"), options.identity)); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    cache = { schemaVersion: 4, nativeModes: {}, identity: { ...options.identity }, desired: null, observationRevision: "0", nextFailureId: 1, items: [] };
  }
  cache = freeze(cache);
  await mkdir(path.dirname(options.file), { recursive: true, mode: 0o700 });
  options.signal.throwIfAborted();
  if (migrated) await persist(options.file, `${JSON.stringify(cache)}\n`);
  options.signal.throwIfAborted();
  let validatedNative = new Map<string, NativeProof>();
  let synchronized = false, published = snapshot(cache, false, validatedNative, localMode, localTools, proofFor), stopped = false, queued = false;
  let deferredDesired: WorkerCloudDesired | null = null;
  let tail = Promise.resolve(), fatal: { error: unknown } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let adapters: WorkerConfigurationProjectAdapters = {};
  const jobs = new Map<string, Job>(), sentFailures = new WeakMap<WorkerCloudReport, ReadonlyMap<string, number>>(), deferred = new Set<string>();
  const fail = (error: unknown): void => {
    if (fatal === undefined) {
      fatal = { error };
      try { options.onError?.(error); } catch (notificationError) { fatal = { error: new AggregateError([error, notificationError], "Worker configuration and error notification failed.") }; }
    }
  };
  const check = (): void => { if (fatal !== undefined) throw fatal.error; };
  const transition = (current: Cache, desired: WorkerCloudDesired): Cache => {
    const candidate = deferredDesired !== null && BigInt(deferredDesired.revision) > BigInt(desired.revision) ? deferredDesired : desired;
    try { parseDesired(candidate); }
    catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      if (deferredDesired?.revision !== candidate.revision) options.onInvalidDesired?.(candidate.revision);
      deferredDesired = candidate;
      return current;
    }
    if (current.desired !== null && (BigInt(candidate.revision) < BigInt(current.desired.revision) || equal(candidate, current.desired))) { deferredDesired = null; return current; }
    try { const next = desiredTransition(current, candidate, localMode); deferredDesired = null; return next; }
    catch (error) {
      if (!(error instanceof WorkerConfigurationCapacityError)) throw error;
      if (deferredDesired?.revision !== candidate.revision) options.onCapacity?.(candidate.revision);
      deferredDesired = candidate;
      return current;
    }
  };
  const kick = (): void => {
    if (queued || stopped || fatal !== undefined || !synchronized) return;
    queued = true;
    queueMicrotask(() => { queued = false; pump(); });
  };
  const commit = (update: (current: Cache) => Cache, confirm = false, proof?: NativeProof & { key: WorkerCloudItemKey; revision: string; accepted: () => boolean }): Promise<void> => {
    const operation = tail.then(async () => {
      check();
      let next = update(cache);
      if (next !== cache) next = { ...next, nativeModes: Object.fromEntries(Object.entries(next.nativeModes).filter(([key]) => next.items.some(item => keyOf(item.value.key) === key))) };
      const changedMode = cache.nativeModes["native:"] !== next.nativeModes["native:"] && supportsMode(next.desired) && next.desired?.value.agentControlMode != null;
      const nextValidatedNative = new Map(validatedNative);
      if (changedMode) for (const key of nextValidatedNative.keys()) if (key.startsWith("projectNative:")) nextValidatedNative.delete(key);
      if (proof !== undefined && proof.accepted()) {
        const item = findItem(next, proof.key);
        if (item?.value.targetRevision === proof.revision && equal(item.value.appliedValue, proof.native) && next.nativeModes[keyOf(proof.key)] === proof.mode && (proof.key.kind === "native" || projectMode(next) === proof.mode) && equal(proofFor(next, proof.native, proof.mode).tools, proof.tools)) nextValidatedNative.set(keyOf(proof.key), { mode: proof.mode, native: proof.native, tools: proof.tools });
      }
      // Application state and execution authority must describe the same process proof.
      for (const item of next.items) {
        const key = item.value.key;
        if ((key.kind === "native" || key.kind === "projectNative") && item.value.state === "applied" && target(next, key) !== null && !matchesProof(next, item.value.appliedValue, projectMode(next), nextValidatedNative.get(keyOf(key)))) next = replaceItem(next, { ...item, value: { ...item.value, state: "pending" } });
      }
      if (next !== cache) {
        // All transitions calculate from this queue's current state; rename alone cannot prevent stale snapshots.
        await persist(options.file, `${JSON.stringify(next)}\n`);
        cache = freeze(next);
      }
      if (changedMode) for (const [key, job] of jobs) if (key.startsWith("projectNative:")) job.controller.abort(new Error("Worker control mode changed."));
      for (const job of jobs.values()) if (job.proof !== null && !equal(job.proof.tools, proofFor(cache, job.proof.native, job.proof.mode).tools)) job.controller.abort(new Error("Worker tool selection changed."));
      validatedNative = nextValidatedNative;
      if (confirm) synchronized = true;
      published = snapshot(cache, synchronized && deferredDesired === null, validatedNative, localMode, localTools, proofFor);
      options.onChange?.(published);
      kick();
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const runnable = (item: StoredItem): boolean => {
    if (item.value.state === "applied" || item.value.state === "applying" || item.value.nextAttemptAt !== null && Date.parse(item.value.nextAttemptAt) > now()) return false;
    const key = item.value.key;
    if (key.kind === "agentControlMode") return false;
    if (key.kind === "projectNative") {
      const effectiveMode = projectMode(cache), global = findItem(cache, { kind: "native" });
      // Another Provider's changed tool cannot revoke a mode proven in this process.
      if (cache.desired?.value.agentControlMode != null && (effectiveMode === undefined || validatedNative.get("native:")?.mode !== effectiveMode)) return false;
      if (effectiveMode !== intendedMode(cache) && (global?.value.state !== "error" || item.value.appliedValue === null || (cache.nativeModes[keyOf(key)] ?? localMode) !== effectiveMode || matchesProof(cache, item.value.appliedValue, effectiveMode, validatedNative.get(keyOf(key))))) return false;
    }
    if (deferredDesired !== null && key.kind !== "projectRemoval") return false;
    if (deferred.has(`${keyOf(key)}:${item.value.targetRevision}`)) return false;
    if (key.kind === "projectRemoval") return adapters.remove !== undefined && (item.started || !cache.desired?.value.projects.some(project => project.projectId === key.projectId) && !deferredDesired?.value.projects.some(project => project.projectId === key.projectId));
    if (target(cache, key) === null) return false;
    if (key.kind === "projectPreparation") return adapters.prepare !== undefined && !hasUnfinishedRemoval(cache, key.projectId);
    return true;
  };
  const run = async (original: StoredItem, controller: AbortController): Promise<void> => {
    const key = original.value.key, revision = original.value.targetRevision;
    const prepare = adapters.prepare, remove = adapters.remove;
    let intended = target(cache, key), mode = intendedMode(cache), effectiveProjectMode = projectMode(cache), began = false;
    let modeFailure: WorkerCloudFailure | null = null;
    const resetCancelled = async (): Promise<void> => {
      if (stopped) return;
      await commit(current => {
        const item = findItem(current, key);
        return item === undefined || item.value.targetRevision !== revision || item.value.state !== "applying" ? current : replaceItem(current, { ...item, value: { ...item.value, state: "pending", error: null, nextAttemptAt: null } });
      });
    };
    await commit(current => {
      const item = findItem(current, key);
      if (stopped || controller.signal.aborted || item === undefined || item.value.targetRevision !== revision || !runnable(item)) return current;
      intended = target(current, key); mode = intendedMode(current); effectiveProjectMode = projectMode(current); began = true;
      if (key.kind === "projectNative" && effectiveProjectMode !== mode) modeFailure = findItem(current, { kind: "native" })!.value.error;
      let next = replaceItem(current, { ...item, started: key.kind === "projectRemoval" || item.started, value: { ...item.value, state: "applying", error: null, nextAttemptAt: null } });
      const modeItem = findItem(current, { kind: "agentControlMode" });
      if (key.kind === "native" && current.desired?.value.agentControlMode != null && modeItem !== undefined) next = replaceItem(next, { ...modeItem, value: { ...modeItem.value, state: "applying", error: null, nextAttemptAt: null } });
      return next;
    });
    if (!began) return;
    if (controller.signal.aborted) { await resetCancelled(); return; }
    const nativeKey = key.kind === "native" ? { kind: "native" as const } : key.kind === "projectNative" ? { kind: "projectNative" as const, projectId: key.projectId } : null;
    const notifyNative = (event: WorkerNativeApplicationOutcome): void => {
      if (nativeKey !== null) try { options.onNativeApplication?.({ ...event, key: nativeKey, revision, target: intended as WorkerCloudNative }); } catch { /* Monitoring cannot change application results. */ }
    };
    if (nativeKey !== null) notifyNative({ kind: "started" });
    let outcome: { succeeded: true } | { succeeded: false; error: unknown } = { succeeded: true }, preparationDeferred = false;
    let validated: NativeProof | undefined;
    try {
      if (key.kind === "native" || key.kind === "projectNative") {
        // A failed global mode transition permits only history in the proven effective mode.
        if (modeFailure !== null) throw new WorkerConfigurationApplicationError(modeFailure);
        const proof = proofFor(cache, intended as WorkerCloudNative, mode);
        if (!canValidateNative(proof)) throw new Error("Worker tool selection has not been verified.");
        await options.applyNative(intended as WorkerCloudNative, controller.signal, mode);
        validated = proof;
      }
      else if (key.kind === "projectPreparation") preparationDeferred = await prepare!(key.projectId, controller.signal) === false;
      else if (key.kind === "projectRemoval") await remove!(key.projectId, controller.signal);
    } catch (error) { outcome = { succeeded: false, error }; }
    if (stopped) { notifyNative({ kind: "cancelled" }); return; }
    if (controller.signal.aborted) { notifyNative({ kind: "cancelled" }); await resetCancelled(); return; }
    if (!outcome.succeeded && (key.kind === "native" || key.kind === "projectNative")) {
      const previous = findItem(cache, key)?.value.appliedValue;
      const previousMode = cache.nativeModes[keyOf(key)] ?? localMode;
      if (typeof previous === "object" && previous !== null && !matchesProof(cache, previous, previousMode, validatedNative.get(keyOf(key))) && (key.kind === "native" || previousMode === projectMode(cache))) {
        try {
          const proof = proofFor(cache, previous, previousMode);
          if (!canValidateNative(proof)) throw new Error("Worker tool selection has not been verified.");
          await options.applyNative(previous, controller.signal, previousMode); validated = proof;
        }
        catch {
          // Retain the current target's diagnostic; unusable history cannot establish an effective value.
        }
      }
    }
    if (stopped) { notifyNative({ kind: "cancelled" }); return; }
    if (controller.signal.aborted) { notifyNative({ kind: "cancelled" }); await resetCancelled(); return; }
    if (validated !== undefined && !equal(validated, proofFor(cache, validated.native, validated.mode))) { notifyNative({ kind: "cancelled" }); await resetCancelled(); return; }
    if (preparationDeferred) {
      await commit(current => {
        const item = findItem(current, key);
        return item === undefined || item.value.targetRevision !== revision || item.value.state !== "applying" ? current : replaceItem(current, { ...item, value: { ...item.value, state: "pending", error: null, nextAttemptAt: null } });
      });
      deferred.add(`${keyOf(key)}:${revision}`);
      return;
    }
    let accepted = false, retryAt: string | null = null;
    try { await commit(current => {
      const item = findItem(current, key);
      if (item === undefined || item.value.targetRevision !== revision || item.value.state !== "applying" || key.kind !== "projectRemoval" && !equal(target(current, key), intended) || nativeKey !== null && intendedMode(current) !== mode || key.kind === "projectNative" && projectMode(current) !== effectiveProjectMode) return current;
      accepted = true;
      const withModeResult = (next: Cache, result: StoredItem): Cache => {
        if (validated !== undefined) next = { ...next, nativeModes: { ...next.nativeModes, [keyOf(key)]: validated.mode } };
        const modeItem = findItem(next, { kind: "agentControlMode" });
        if (key.kind === "native" && modeItem !== undefined && next.desired?.value.agentControlMode != null) next = replaceItem(next, { ...result, value: { ...result.value, key: modeItem.value.key, appliedValue: outcome.succeeded ? mode : modeItem.value.appliedValue, lastFailure: result.value.lastFailure ?? modeItem.value.lastFailure }, failureId: result.failureId ?? modeItem.failureId });
        return next;
      };
      if (outcome.succeeded) {
        const result = { ...item, attempts: 0, started: false, value: { ...item.value, appliedValue: intended, state: "applied" as const, error: null, nextAttemptAt: null } };
        return withModeResult(replaceItem(current, result), result);
      }
      if (current.nextFailureId === Number.MAX_SAFE_INTEGER) throw new RangeError("Worker configuration failure sequence is exhausted.");
      const diagnostic = failure(outcome.error, key, now()), attempts = Math.min(item.attempts + 1, retryDelays.length), delay = retryDelays[attempts - 1]!;
      retryAt = new Date(now() + delay).toISOString();
      const result = { ...item, attempts, failureId: current.nextFailureId, value: { ...item.value, state: "error" as const, error: diagnostic, lastFailure: diagnostic, nextAttemptAt: retryAt } };
      return withModeResult({ ...replaceItem(current, result), nextFailureId: current.nextFailureId + 1 }, result);
    }, false, validated === undefined ? undefined : { key, revision, ...validated, accepted: () => accepted }); }
    catch (error) { notifyNative({ kind: "cancelled" }); throw error; }
    if (nativeKey !== null) {
      if (!accepted || stopped || controller.signal.aborted) notifyNative({ kind: "cancelled" });
      else if (outcome.succeeded) notifyNative({ kind: "succeeded" });
      else notifyNative({ kind: "failed", error: outcome.error, nextAttemptAt: retryAt! });
    }
  };
  const pump = (): void => {
    if (stopped || fatal !== undefined || !synchronized) return;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    for (const [key, job] of jobs) {
      const item = cache.items.find(item => keyOf(item.value.key) === key);
      if (item === undefined || item.value.targetRevision !== job.revision || deferredDesired !== null && item.value.key.kind !== "projectRemoval" || item.value.key.kind === "projectPreparation" && target(cache, item.value.key) === null) job.controller.abort(new Error("Worker configuration target changed."));
    }
    for (const item of cache.items) {
      const key = keyOf(item.value.key);
      if (jobs.has(key) || !runnable(item)) continue;
      const controller = new AbortController();
      const proof = item.value.key.kind === "native" || item.value.key.kind === "projectNative" ? proofFor(cache, target(cache, item.value.key) as WorkerCloudNative, intendedMode(cache)) : null;
      const promise = run(item, controller).catch(fail).finally(() => { jobs.delete(key); kick(); });
      jobs.set(key, { revision: item.value.targetRevision, controller, promise, proof });
    }
    const deadlines = cache.items.filter(item => item.value.state === "error" && item.value.nextAttemptAt !== null).map(item => Date.parse(item.value.nextAttemptAt!)).filter(deadline => deadline > now());
    if (deadlines.length !== 0) { timer = setTimeout(kick, Math.min(...deadlines) - now()); timer.unref(); }
  };
  const halt = (): void => {
    stopped = true;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    for (const job of jobs.values()) job.controller.abort(options.signal.reason);
    options.signal.removeEventListener("abort", halt);
  };
  options.signal.addEventListener("abort", halt, { once: true });
  if (options.signal.aborted) halt();
  return {
    current: (): WorkerConfigurationSnapshot => published,
    receive: async (desired: WorkerCloudDesired | null, observationRevision?: string): Promise<void> => {
      const parsed = desired === null ? null : parseDesired(desired, false), revision = observationRevision === undefined ? undefined : parseWorkerCloudRevision(observationRevision, true);
      await commit(current => {
        if (stopped) throw new Error("Worker configuration manager is stopped.");
        const obsolete = synchronized && parsed !== null && current.desired !== null && BigInt(parsed.revision) < BigInt(current.desired.revision);
        let next = obsolete ? current : parsed === null ? desiredTransition(current, null, localMode) : transition(current, parsed);
        if (!synchronized && parsed !== null) next = { ...next, items: next.items.map(item => item.value.key.kind === "native" || item.value.key.kind === "projectNative" || item.value.key.kind === "projectPreparation"
          ? { ...item, value: { ...item.value, state: "pending", error: null, nextAttemptAt: null } } : item) };
        if (revision !== undefined && (!synchronized || BigInt(revision) > BigInt(current.observationRevision))) next = { ...next, observationRevision: revision };
        return next;
      }, true);
    },
    report: (bootstrap: WorkerCloudValue | null = null): WorkerCloudReport => {
      check();
      if (stopped) throw new Error("Worker configuration manager is stopped.");
      const report = freeze({ controlModeBootstrap: localMode, toolPathsBootstrap: localTools, bootstrap: cache.desired === null && bootstrap !== null ? parseWorkerCloudValue(bootstrap, true, capabilities(bootstrap)) : null, observation: synchronized && cache.desired !== null ? { baseRevision: cache.observationRevision, desiredRevision: cache.desired.revision, items: cache.items.map(item => item.value) } : null });
      sentFailures.set(report, new Map(cache.items.filter(item => item.failureId !== null).map(item => [keyOf(item.value.key), item.failureId!])));
      return report;
    },
    acknowledge: async (sent: WorkerCloudReport, receipt: WorkerCloudReceipt): Promise<void> => {
      if (stopped) throw new Error("Worker configuration manager is stopped.");
      const parsed = parseWorkerCloudReceipt(receipt, capabilities(receipt.desired?.value)), acknowledged = sentFailures.get(sent);
      if (acknowledged === undefined) throw new Error("Worker configuration report was not captured by this manager.");
      if (parsed.observationAccepted && (sent.observation === null || BigInt(parsed.observationRevision) !== BigInt(sent.observation.baseRevision) + 1n || parsed.desired === null || BigInt(parsed.desired.revision) < BigInt(sent.observation.desiredRevision))) throw new Error("Worker configuration receipt does not acknowledge the submitted observation.");
      await commit(current => {
        let next = current;
        if (BigInt(parsed.observationRevision) > BigInt(next.observationRevision)) next = { ...next, observationRevision: parsed.observationRevision };
        if (parsed.observationAccepted) {
          next = { ...next, items: next.items.map(item => item.failureId !== null && acknowledged.get(keyOf(item.value.key)) === item.failureId ? { ...item, failureId: null, value: { ...item.value, lastFailure: null } } : item) };
          const selected = new Set([...(next.desired?.value.projects.map(project => project.projectId) ?? []), ...(parsed.desired?.value.projects.map(project => project.projectId) ?? [])]);
          const removals = new Set<string>();
          const completed = new Set(next.items.flatMap(item => {
            const key = item.value.key;
            if (key.kind !== "projectRemoval" || item.value.state !== "applied" || item.failureId !== null || !sent.observation?.items.some(sentItem => keyOf(sentItem.key) === keyOf(key) && sentItem.targetRevision === item.value.targetRevision && sentItem.state === "applied")) return [];
            if (selected.has(key.projectId)) { removals.add(keyOf(key)); return []; }
            return next.items.some(other => "projectId" in other.value.key && other.value.key.projectId === key.projectId && other.failureId !== null) ? [] : [key.projectId];
          }));
          if (completed.size !== 0 || removals.size !== 0) next = { ...next, items: next.items.filter(item => !removals.has(keyOf(item.value.key)) && (!("projectId" in item.value.key) || !completed.has(item.value.key.projectId))) };
        }
        if (parsed.desired !== null) next = transition(next, parsed.desired);
        return next;
      }, true);
      sentFailures.delete(sent);
    },
    ensureProjectRemoval: async (projectId: string): Promise<void> => {
      const id = canonicalId(projectId);
      if (id === null) throw new TypeError("Project ID must be a UUID.");
      await commit(current => {
        if (stopped) throw new Error("Worker configuration manager is stopped.");
        if (!synchronized || current.desired === null || current.desired.value.projects.some(project => project.projectId === id)) return current;
        const key: WorkerCloudItemKey = { kind: "projectRemoval", projectId: id };
        const previous = findItem(current, key);
        // A cached result does not prove that the new coordinator observed stopped resources.
        if (previous !== undefined) return previous.value.state === "applied" ? replaceItem(current, { ...previous, value: { ...previous.value, state: "pending", error: null, nextAttemptAt: null } }) : current;
        if (current.items.length >= (supportsMode(current.desired) ? 1026 : 1025)) throw new RangeError("Worker configuration observation has no capacity for additional items.");
        const value: WorkerCloudItem = { key, targetRevision: current.desired.revision, appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null };
        return { ...current, items: [...current.items, { value, attempts: 0, failureId: null, started: false }].sort((a, b) => keyOf(a.value.key).localeCompare(keyOf(b.value.key))) };
      });
    },
    confirmProjectPrepared: async (projectId: string, revision: string): Promise<void> => {
      if (stopped) throw new Error("Worker configuration manager is stopped.");
      parseWorkerCloudRevision(revision);
      await commit(current => {
        const item = findItem(current, { kind: "projectPreparation", projectId });
        if (item === undefined || current.desired?.revision !== revision || item.value.targetRevision !== revision || hasUnfinishedRemoval(current, projectId)) return current;
        return replaceItem(current, { ...item, attempts: 0, value: { ...item.value, appliedValue: true, state: "applied", error: null, nextAttemptAt: null } });
      });
    },
    refreshToolSelections: async (): Promise<void> => {
      check();
      if (stopped) throw new Error("Worker configuration manager is stopped.");
      await commit(current => current);
    },
    configureProjectAdapters: async (next: WorkerConfigurationProjectAdapters): Promise<void> => { check(); if (stopped) throw new Error("Worker configuration manager is stopped."); adapters = next; deferred.clear(); kick(); },
    settle: async (): Promise<void> => {
      for (;;) {
        await tail;
        await Promise.resolve();
        const pending = [...jobs.values()].map(job => job.promise);
        if (pending.length !== 0) { await Promise.all(pending); continue; }
        if (queued) continue;
        check();
        return;
      }
    },
    stop: async (): Promise<void> => { halt(); await Promise.all([...jobs.values()].map(job => job.promise)); await tail; check(); },
  };
};
export type WorkerConfigurationManager = Awaited<ReturnType<typeof createWorkerConfigurationManager>>;
