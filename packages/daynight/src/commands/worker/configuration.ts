import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseWorkerCloudReceipt, parseWorkerCloudRevision } from "../../api/worker-configuration.js";
import { canonicalId } from "../../api/parse.js";
import { ProtocolError } from "../../api/validation.js";
import type { WorkerCloudDesired, WorkerCloudFailure, WorkerCloudItem, WorkerCloudItemKey, WorkerCloudNative, WorkerCloudReceipt, WorkerCloudReport, WorkerCloudValue } from "../../api/worker-configuration.js";
import type { AgentControlMode, WorkerReport } from "../../api/types.js";
import { parseToolPathsBootstrap } from "../../api/worker-tool-paths.js";
import { replaceFileAtomicallyFromChunks } from "../../platform/files.js";
import { parseLocalToolPaths, type Tool, type ToolPaths } from "../../platform/tool-path-choice.js";
import { configurationCacheChunks, createConfigurationCache, readConfigurationCache } from "./configuration-cache.js";
import { configurationCapabilities as capabilities, configurationKey as keyOf, configurationRetryDelays as retryDelays, configurationSupportsMode as supportsMode, freezeConfiguration as freeze, parseConfigurationDesired as parseDesired, sameConfigurationValue as equal } from "./configuration-model.js";
import type { ConfigurationProjection, TrackedConfigurationItem, WorkerConfigurationCache, WorkerConfigurationIdentity, WorkerConfigurationSnapshot, WorkerConfigurationToolTargets, WorkerNativeProof } from "./configuration-model.js";
import { acceptConfigurationProjection, allConfigurationItems, configurationHasUnfinishedRemoval as hasUnfinishedRemoval, configurationInheritanceSources, configurationSnapshot as snapshot, configurationTarget as target, configurationToolTargets as toolTargets, findConfigurationRecord as findRecord, findCurrentConfigurationItem as findItem, projectConfigurationReport, pruneConfigurationRetained, replaceConfigurationRecord as replaceItem, transitionConfigurationDesired as desiredTransition } from "./configuration-state.js";

export type { WorkerConfigurationIdentity, WorkerConfigurationSnapshot, WorkerConfigurationToolTargets } from "./configuration-model.js";
export { resolveWorkerCloudProjectNative } from "./configuration-state.js";
export type WorkerNativeToolSelectionKeys = Readonly<Partial<Record<Tool, string>>>;
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
  /** Prepare current targets before constructing the native validation proof. */
  readonly prepareToolSelection?: (native: WorkerCloudNative, mode: AgentControlMode, targets: WorkerConfigurationToolTargets, signal: AbortSignal) => Promise<void>;
  /** Herdr selection belongs to its separate runtime integration. */
  readonly allowLegacyHerdrAuto?: boolean;
  readonly applyNative: (native: WorkerCloudNative, signal: AbortSignal, mode: AgentControlMode) => Promise<void>;
  readonly onChange?: (snapshot: WorkerConfigurationSnapshot) => void;
  readonly onNativeApplication?: (event: WorkerNativeApplicationEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly onInvalidDesired?: (revision: string) => void;
  readonly now?: () => number;
  readonly persist?: (file: string, chunks: () => Iterable<string>) => Promise<void>;
};
type Job = { readonly recordId: string; readonly key: WorkerCloudItemKey; readonly controller: AbortController; readonly promise: Promise<void>; proof: WorkerNativeProof | null; preparing: boolean };
const nativeTools = (native: WorkerCloudNative, mode: AgentControlMode): readonly Tool[] => [
  ...(native.agent === "codex" || native.agent === "copilot" ? [native.agent] : []), ...(mode === "herdr" ? ["herdr" as const] : []),
];
const nativeMode = (cache: WorkerConfigurationCache, key: WorkerCloudItemKey): AgentControlMode | null => findItem(cache, key)?.nativeMode ?? null;
const isScalar = (key: WorkerCloudItemKey): boolean => key.kind === "maxConcurrent" || key.kind === "pollIntervalMs" || key.kind === "recoveryLimit" || key.kind === "preferPlatformSpecificTasks";
const observedSource = (item: TrackedConfigurationItem): TrackedConfigurationItem["actualSource"] => ({ kind: "observed", recordId: item.recordId, generation: item.origin.generation, targetRevision: item.origin.targetRevision });
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
export const createWorkerConfigurationManager = async (options: WorkerConfigurationManagerOptions) => {
  options.signal.throwIfAborted();
  const localMode = options.localControlMode ?? "herdr";
  const localTools = freeze(parseToolPathsBootstrap(options.localToolPaths ?? parseLocalToolPaths(undefined)));
  const proofFor = (current: WorkerConfigurationCache, native: WorkerCloudNative, mode: AgentControlMode): WorkerNativeProof => {
    const choices = toolTargets(current, localTools)?.choices, keys = options.readToolSelectionKeys?.(native, mode);
    return { mode, native, tools: nativeTools(native, mode).map(tool => ({ tool, choice: choices?.[tool] ?? null, selectionKey: keys?.[tool] ?? null })) };
  };
  // Legacy native validation establishes no tool-selection authority.
  const canValidateNative = (proof: WorkerNativeProof): boolean => options.readToolSelectionKeys === undefined || options.allowLegacyHerdrAuto === true && proof.mode === "herdr" && proof.tools.every(tool => tool.choice?.kind === "auto") || proof.tools.every(tool => tool.choice !== null && tool.selectionKey !== null && /^[a-f0-9]{64}$/.test(tool.selectionKey));
  const matchesProof = (current: WorkerConfigurationCache, value: WorkerCloudItem["appliedValue"] | undefined, mode: AgentControlMode | null | undefined, proof: WorkerNativeProof | undefined): boolean =>
    mode != null && typeof value === "object" && value !== null && equal(proofFor(current, value, mode), proof);
  const intendedMode = (current: WorkerConfigurationCache): AgentControlMode => current.authority.desired?.value.agentControlMode ?? localMode;
  const projectMode = (current: WorkerConfigurationCache): AgentControlMode | null => current.authority.desired?.value.agentControlMode == null ? localMode : nativeMode(current, { kind: "native" });
  const now = options.now ?? Date.now, persist = options.persist ?? ((file, chunks) => replaceFileAtomicallyFromChunks(file, chunks(), 0o600));
  let cache: WorkerConfigurationCache, migrated = false;
  try { ({ cache, migrated } = await readConfigurationCache(options.file, options.identity, options.signal)); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    cache = createConfigurationCache(options.identity);
  }
  cache = freeze(cache);
  await mkdir(path.dirname(options.file), { recursive: true, mode: 0o700 });
  options.signal.throwIfAborted();
  if (migrated) await persist(options.file, () => configurationCacheChunks(cache));
  options.signal.throwIfAborted();
  let validatedNative = new Map<string, WorkerNativeProof>();
  let synchronized = false, stopped = false, queued = false, applyingScalars = false;
  let deferredDesired: WorkerCloudDesired | null = null;
  let tail = Promise.resolve(), fatal: { error: unknown } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, jobCursor: string | null = null;
  let adapters: WorkerConfigurationProjectAdapters = {};
  const jobs = new Map<string, Job>(), sentProjections = new WeakMap<WorkerCloudReport, ConfigurationProjection>(), deferred = new Set<string>();
  let applicationIndex: { cache: WorkerConfigurationCache; current: ReadonlyMap<string, TrackedConfigurationItem>; records: ReadonlyMap<string, TrackedConfigurationItem>; unfinishedProjects: ReadonlySet<string> } | undefined;
  const indexedApplications = () => {
    if (applicationIndex?.cache !== cache) {
      const current = new Map(cache.currentItems.map(item => [keyOf(item.value.key), item])), records = new Map(allConfigurationItems(cache).map(item => [item.recordId, item]));
      const currentIds = new Set(cache.currentItems.map(item => item.recordId));
      applicationIndex = { cache, current, records, unfinishedProjects: new Set([...records.values()].flatMap(item => item.value.key.kind === "projectRemoval" && item.value.state !== "applied" && (item.started || currentIds.has(item.recordId)) ? [item.value.key.projectId] : [])) };
    }
    return applicationIndex;
  };
  const runningIds = (): ReadonlySet<string> => new Set(jobs.keys());
  const fail = (error: unknown): void => {
    if (fatal === undefined) {
      fatal = { error };
      try { options.onError?.(error); } catch (notificationError) { fatal = { error: new AggregateError([error, notificationError], "Worker configuration and error notification failed.") }; }
    }
  };
  const check = (): void => { if (fatal !== undefined) throw fatal.error; };
  const transition = (current: WorkerConfigurationCache, desired: WorkerCloudDesired): WorkerConfigurationCache => {
    const candidate = deferredDesired !== null && BigInt(deferredDesired.revision) > BigInt(desired.revision) ? deferredDesired : desired;
    try { parseDesired(candidate); }
    catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      if (deferredDesired?.revision !== candidate.revision) options.onInvalidDesired?.(candidate.revision);
      deferredDesired = candidate;
      return current;
    }
    if (current.authority.desired !== null && (BigInt(candidate.revision) < BigInt(current.authority.desired.revision) || equal(candidate, current.authority.desired))) { deferredDesired = null; return current; }
    const next = desiredTransition(current, candidate, localMode, runningIds(), randomUUID);
    deferredDesired = null;
    return next;
  };
  const kick = (): void => {
    if (queued || stopped || fatal !== undefined || !synchronized) return;
    queued = true;
    queueMicrotask(() => { queued = false; pump(); });
  };
  const commit = (update: (current: WorkerConfigurationCache) => WorkerConfigurationCache, confirm = false, proof?: WorkerNativeProof & { recordId: string; accepted: () => boolean }): Promise<void> => {
    const operation = tail.then(async () => {
      check();
      let next = update(cache);
      const changedMode = nativeMode(cache, { kind: "native" }) !== nativeMode(next, { kind: "native" }) && supportsMode(next.authority.desired) && next.authority.desired?.value.agentControlMode != null;
      const nextValidatedNative = new Map(validatedNative);
      if (changedMode) for (const item of allConfigurationItems(cache)) if (item.value.key.kind === "projectNative") nextValidatedNative.delete(item.recordId);
      const inherited = configurationInheritanceSources(cache);
      for (const item of next.currentItems) {
        if (item.value.key.kind !== "native" && item.value.key.kind !== "projectNative") continue;
        if (nextValidatedNative.has(item.recordId)) continue;
        // Validation belongs to the record checked in this process, independently of the actual value's historical source.
        const previousId = inherited.get(keyOf(item.value.key))?.recordId;
        const prior = previousId === undefined ? undefined : nextValidatedNative.get(previousId);
        if (prior !== undefined && item.nativeMode === prior.mode && equal(item.value.appliedValue, prior.native) && (item.value.key.kind === "native" || equal(proofFor(next, prior.native, prior.mode), prior) && projectMode(next) === prior.mode)) nextValidatedNative.set(item.recordId, prior);
      }
      if (proof !== undefined && proof.accepted()) {
        const item = findRecord(next, proof.recordId);
        if (item !== undefined && equal(item.value.appliedValue, proof.native) && item.nativeMode === proof.mode && (item.value.key.kind === "native" || projectMode(next) === proof.mode) && equal(proofFor(next, proof.native, proof.mode).tools, proof.tools)) nextValidatedNative.set(item.recordId, { mode: proof.mode, native: proof.native, tools: proof.tools });
      }
      // A persisted applied label cannot replace a proof from this running process.
      for (const item of next.currentItems) {
        const key = item.value.key;
        if ((key.kind === "native" || key.kind === "projectNative") && item.value.state === "applied" && target(next, key) !== null && !matchesProof(next, item.value.appliedValue, item.nativeMode, nextValidatedNative.get(item.recordId))) next = replaceItem(next, { ...item, value: { ...item.value, state: "pending" } });
      }
      next = pruneConfigurationRetained(next, runningIds());
      const proofOwners = new Set(allConfigurationItems(next).map(item => item.recordId));
      for (const id of nextValidatedNative.keys()) if (!proofOwners.has(id)) nextValidatedNative.delete(id);
      if (next !== cache) {
        const frozen = freeze(next);
        await persist(options.file, () => configurationCacheChunks(frozen));
        cache = frozen;
      }
      if (changedMode) for (const job of jobs.values()) if (job.key.kind === "projectNative") job.controller.abort(new Error("Worker control mode changed."));
      for (const job of jobs.values()) if (job.proof !== null && !equal(job.preparing ? job.proof.tools.map(({ tool, choice }) => ({ tool, choice })) : job.proof.tools, job.preparing ? proofFor(cache, job.proof.native, job.proof.mode).tools.map(({ tool, choice }) => ({ tool, choice })) : proofFor(cache, job.proof.native, job.proof.mode).tools)) job.controller.abort(new Error("Worker tool selection changed."));
      validatedNative = nextValidatedNative;
      if (confirm) synchronized = true;
      options.onChange?.(snapshot(cache, synchronized && deferredDesired === null, validatedNative, localMode, localTools, proofFor));
      kick();
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const runnable = (item: TrackedConfigurationItem): boolean => {
    if (item.value.state === "applied" || item.value.state === "applying" || item.value.nextAttemptAt !== null && Date.parse(item.value.nextAttemptAt) > now()) return false;
    const key = item.value.key, index = indexedApplications(), current = index.current.get(keyOf(key))?.recordId === item.recordId;
    if (!current && !(key.kind === "projectRemoval" && item.started)) return false;
    if (item.blockedByRemovalId !== null && index.records.get(item.blockedByRemovalId)?.value.state !== "applied") return false;
    if (key.kind === "agentControlMode") return false;
    if (key.kind === "projectNative") {
      const effectiveMode = projectMode(cache), global = index.current.get("native:");
      if (cache.authority.desired?.value.agentControlMode != null && (effectiveMode === null || global === undefined || validatedNative.get(global.recordId)?.mode !== effectiveMode)) return false;
      if (effectiveMode !== intendedMode(cache) && (global?.value.state !== "error" || item.value.appliedValue === null || (item.nativeMode ?? localMode) !== effectiveMode || matchesProof(cache, item.value.appliedValue, effectiveMode, validatedNative.get(item.recordId)))) return false;
    }
    if (deferredDesired !== null && key.kind !== "projectRemoval") return false;
    if (deferred.has(item.recordId)) return false;
    if (key.kind === "projectRemoval") return adapters.remove !== undefined && (item.started || item.blockedByRemovalId !== null || !cache.authority.desired?.value.projects.some(project => project.projectId === key.projectId) && !deferredDesired?.value.projects.some(project => project.projectId === key.projectId));
    if (target(cache, key) === null) return false;
    if (key.kind === "projectPreparation" || key.kind === "projectNative") {
      if (index.unfinishedProjects.has(key.projectId) || [...jobs.values()].some(job => job.key.kind === "projectRemoval" && job.key.projectId === key.projectId)) return false;
      if (key.kind === "projectPreparation") return adapters.prepare !== undefined;
    }
    return true;
  };
  const run = async (original: TrackedConfigurationItem, controller: AbortController): Promise<void> => {
    const key = original.value.key, revision = original.value.targetRevision, recordId = original.recordId;
    const prepare = adapters.prepare, remove = adapters.remove;
    let intended = target(cache, key), mode = intendedMode(cache), effectiveProjectMode = projectMode(cache), began = false;
    let modeFailure: WorkerCloudFailure | null = null;
    const resetCancelled = async (): Promise<void> => {
      if (stopped) return;
      await commit(current => {
        const item = findRecord(current, recordId);
        return item === undefined || item.value.targetRevision !== revision || item.value.state !== "applying" ? current : replaceItem(current, { ...item, value: { ...item.value, state: "pending", error: null, nextAttemptAt: null } });
      });
    };
    await commit(current => {
      const item = findRecord(current, recordId);
      if (stopped || controller.signal.aborted || item === undefined || item.value.targetRevision !== revision || !runnable(item)) return current;
      intended = target(current, key); mode = intendedMode(current); effectiveProjectMode = projectMode(current); began = true;
      if (key.kind === "projectNative" && effectiveProjectMode !== mode) modeFailure = findItem(current, { kind: "native" })!.value.error;
      let next = replaceItem(current, { ...item, started: key.kind === "projectRemoval" || item.started, value: { ...item.value, state: "applying", error: null, nextAttemptAt: null } });
      const modeItem = findItem(current, { kind: "agentControlMode" });
      if (key.kind === "native" && current.authority.desired?.value.agentControlMode != null && modeItem !== undefined) next = replaceItem(next, { ...modeItem, value: { ...modeItem.value, state: "applying", error: null, nextAttemptAt: null } });
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
    let validated: WorkerNativeProof | undefined;
    try {
      if (key.kind === "native" || key.kind === "projectNative") {
        // A failed global mode transition permits only history in the proven effective mode.
        if (modeFailure !== null) throw new WorkerConfigurationApplicationError(modeFailure);
        const targets = toolTargets(cache, localTools);
        if (options.prepareToolSelection !== undefined) {
          if (targets === null) throw new Error("Worker tool targets are unavailable.");
          await options.prepareToolSelection(intended as WorkerCloudNative, mode, targets, controller.signal);
          controller.signal.throwIfAborted();
          if (findRecord(cache, recordId)?.value.targetRevision !== revision || !equal(targets, toolTargets(cache, localTools))) throw new Error("Worker tool targets changed during preparation.");
        }
        const proof = proofFor(cache, intended as WorkerCloudNative, mode);
        const job = jobs.get(recordId);
        if (job !== undefined) { job.proof = proof; job.preparing = false; }
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
      const previous = findRecord(cache, recordId)?.value.appliedValue;
      const previousMode = findRecord(cache, recordId)?.nativeMode ?? localMode;
      if (typeof previous === "object" && previous !== null && !matchesProof(cache, previous, previousMode, validatedNative.get(recordId)) && (key.kind === "native" || previousMode === projectMode(cache))) {
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
        const item = findRecord(current, recordId);
        return item === undefined || item.value.targetRevision !== revision || item.value.state !== "applying" ? current : replaceItem(current, { ...item, value: { ...item.value, state: "pending", error: null, nextAttemptAt: null } });
      });
      deferred.add(recordId);
      return;
    }
    let accepted = false, retryAt: string | null = null;
    try { await commit(current => {
      const item = findRecord(current, recordId);
      if (item === undefined || item.value.targetRevision !== revision || item.value.state !== "applying" || key.kind !== "projectRemoval" && (findItem(current, key)?.recordId !== recordId || !equal(target(current, key), intended)) || nativeKey !== null && intendedMode(current) !== mode || key.kind === "projectNative" && projectMode(current) !== effectiveProjectMode) return current;
      accepted = true;
      let next = current;
      const diagnostic = outcome.succeeded ? null : failure(outcome.error, key, now());
      const complete = (source: TrackedConfigurationItem, appliedValue: WorkerCloudItem["appliedValue"], modeResult = false): TrackedConfigurationItem => {
        if (outcome.succeeded) return { ...source, backoffStep: 0, started: false, nativeMode: !modeResult && validated !== undefined ? validated.mode : source.nativeMode, actualSource: observedSource(source), value: { ...source.value, appliedValue, state: "applied", error: null, nextAttemptAt: null } };
        if (next.nextFailureId === Number.MAX_SAFE_INTEGER) throw new RangeError("Worker configuration failure sequence is exhausted.");
        const backoffStep = Math.min(source.backoffStep + 1, retryDelays.length);
        retryAt = new Date(now() + retryDelays[backoffStep - 1]!).toISOString();
        const failureId = next.nextFailureId;
        next = { ...next, nextFailureId: failureId + 1 };
        return { ...source, backoffStep, failureId, nativeMode: !modeResult && validated !== undefined ? validated.mode : source.nativeMode, value: { ...source.value, state: "error", error: diagnostic, lastFailure: diagnostic, nextAttemptAt: retryAt } };
      };
      const result = complete(item, outcome.succeeded ? intended : item.value.appliedValue);
      next = replaceItem(next, result);
      const modeItem = findItem(next, { kind: "agentControlMode" });
      if (key.kind === "native" && modeItem !== undefined && next.authority.desired?.value.agentControlMode != null) {
        const modeResult = complete(modeItem, outcome.succeeded ? mode : modeItem.value.appliedValue, true);
        next = replaceItem(next, modeResult);
      }
      return next;
    }, false, validated === undefined ? undefined : { recordId, ...validated, accepted: () => accepted }); }
    catch (error) { notifyNative({ kind: "cancelled" }); throw error; }
    if (!accepted) await resetCancelled();
    if (nativeKey !== null) {
      if (!accepted || stopped || controller.signal.aborted) notifyNative({ kind: "cancelled" });
      else if (outcome.succeeded) notifyNative({ kind: "succeeded" });
      else notifyNative({ kind: "failed", error: outcome.error, nextAttemptAt: retryAt! });
    }
  };
  const pump = (): void => {
    if (stopped || fatal !== undefined || !synchronized) return;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    for (const job of jobs.values()) {
      const item = findRecord(cache, job.recordId);
      if (item === undefined || job.key.kind !== "projectRemoval" && (findItem(cache, job.key)?.recordId !== job.recordId || deferredDesired !== null || target(cache, job.key) === null)) job.controller.abort(new Error("Worker configuration target changed."));
    }
    if (!applyingScalars && cache.currentItems.some(item => isScalar(item.value.key) && runnable(item))) {
      applyingScalars = true;
      void commit(current => ({ ...current, currentItems: current.currentItems.map(item => isScalar(item.value.key) && runnable(item)
        ? { ...item, backoffStep: 0, actualSource: observedSource(item), value: { ...item.value, appliedValue: target(current, item.value.key), state: "applied", error: null, nextAttemptAt: null } }
        : item) })).catch(fail).finally(() => { applyingScalars = false; kick(); });
    }
    const ordered = [...allConfigurationItems(cache)].sort((first, second) => first.recordId < second.recordId ? -1 : first.recordId > second.recordId ? 1 : 0);
    const split = jobCursor === null ? 0 : ordered.findIndex(item => item.recordId > jobCursor!);
    const candidates = split <= 0 ? ordered : [...ordered.slice(split), ...ordered.slice(0, split)];
    for (const item of candidates) {
      if (jobs.size >= 16) break;
      if (isScalar(item.value.key) || jobs.has(item.recordId) || !runnable(item)) continue;
      const key = item.value.key;
      if ([...jobs.values()].some(job => keyOf(job.key) === keyOf(key) || "projectId" in key && "projectId" in job.key && key.projectId === job.key.projectId && (key.kind === "projectRemoval" || job.key.kind === "projectRemoval"))) continue;
      const controller = new AbortController();
      const proof = key.kind === "native" || key.kind === "projectNative" ? proofFor(cache, target(cache, key) as WorkerCloudNative, intendedMode(cache)) : null;
      const promise = run(item, controller).catch(fail).finally(() => { jobs.delete(item.recordId); kick(); });
      jobCursor = item.recordId;
      jobs.set(item.recordId, { recordId: item.recordId, key, controller, promise, proof, preparing: options.prepareToolSelection !== undefined });
    }
    const deadlines = allConfigurationItems(cache).filter(item => item.value.state === "error" && item.value.nextAttemptAt !== null).map(item => Date.parse(item.value.nextAttemptAt!)).filter(deadline => deadline > now());
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
    current: (): WorkerConfigurationSnapshot => snapshot(cache, synchronized && deferredDesired === null, validatedNative, localMode, localTools, proofFor),
    receive: async (desired: WorkerCloudDesired | null, observationRevision?: string): Promise<void> => {
      const parsed = desired === null ? null : parseDesired(desired, false), revision = observationRevision === undefined ? undefined : parseWorkerCloudRevision(observationRevision, true);
      await commit(current => {
        if (stopped) throw new Error("Worker configuration manager is stopped.");
        const obsolete = synchronized && parsed !== null && current.authority.desired !== null && BigInt(parsed.revision) < BigInt(current.authority.desired.revision);
        let next = obsolete ? current : parsed === null ? desiredTransition(current, null, localMode, runningIds(), randomUUID) : transition(current, parsed);
        if (!synchronized && parsed !== null) next = { ...next, currentItems: next.currentItems.map(item => item.value.key.kind === "native" || item.value.key.kind === "projectNative" || item.value.key.kind === "projectPreparation"
          ? { ...item, value: { ...item.value, state: "pending", error: null, nextAttemptAt: null } } : item) };
        if (parsed !== null && revision !== undefined && (!synchronized || BigInt(revision) > BigInt(current.authority.observationRevision))) next = { ...next, authority: { ...next.authority, observationRevision: revision } };
        return next;
      }, true);
    },
    report: (bootstrap: WorkerCloudValue | null = null, telemetry?: WorkerReport): WorkerCloudReport => {
      check();
      if (stopped) throw new Error("Worker configuration manager is stopped.");
      const projection = projectConfigurationReport(cache, { synchronized, localMode, localTools, bootstrap, ...(telemetry === undefined ? {} : { telemetry }) });
      sentProjections.set(projection.report, projection);
      return projection.report;
    },
    acknowledge: async (sent: WorkerCloudReport, receipt: WorkerCloudReceipt): Promise<void> => {
      if (stopped) throw new Error("Worker configuration manager is stopped.");
      const parsed = parseWorkerCloudReceipt(receipt, capabilities(receipt.desired?.value)), captured = sentProjections.get(sent);
      if (captured === undefined) throw new Error("Worker configuration report was not captured by this manager.");
      if (parsed.observationAccepted && (sent.observation === null || BigInt(parsed.observationRevision) !== BigInt(sent.observation.baseRevision) + 1n || parsed.desired === null || BigInt(parsed.desired.revision) < BigInt(sent.observation.desiredRevision))) throw new Error("Worker configuration receipt does not acknowledge the submitted observation.");
      await commit(current => {
        let next = current;
        if (BigInt(parsed.observationRevision) > BigInt(next.authority.observationRevision)) next = { ...next, authority: { ...next.authority, observationRevision: parsed.observationRevision } };
        if (parsed.desired !== null) next = transition(next, parsed.desired);
        if (parsed.observationAccepted) next = acceptConfigurationProjection(next, captured, runningIds());
        return next;
      }, true);
      sentProjections.delete(sent);
    },
    ensureProjectRemoval: async (projectId: string): Promise<void> => {
      const id = canonicalId(projectId);
      if (id === null) throw new TypeError("Project ID must be a UUID.");
      await commit(current => {
        if (stopped) throw new Error("Worker configuration manager is stopped.");
        if (!synchronized || current.authority.desired === null || current.authority.desired.value.projects.some(project => project.projectId === id)) return current;
        const key: WorkerCloudItemKey = { kind: "projectRemoval", projectId: id }, previous = findItem(current, key);
        // A cached result does not prove that the new coordinator observed stopped resources.
        if (previous !== undefined) return previous.value.state === "applied" ? replaceItem(current, { ...previous, value: { ...previous.value, state: "pending", error: null, nextAttemptAt: null } }) : current;
        const blocker = allConfigurationItems(current).find(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === id && item.started && item.value.state !== "applied");
        const value: WorkerCloudItem = { key, targetRevision: current.authority.desired.revision, appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null };
        const item: TrackedConfigurationItem = { recordId: randomUUID(), origin: { generation: current.authority.generation, targetRevision: value.targetRevision, source: "application" }, value, backoffStep: 0, failureId: null, started: false, nativeMode: null, actualSource: null, blockedByRemovalId: blocker?.recordId ?? null };
        return { ...current, currentItems: [...current.currentItems, item] };
      });
    },
    confirmProjectPrepared: async (projectId: string, revision: string): Promise<void> => {
      if (stopped) throw new Error("Worker configuration manager is stopped.");
      parseWorkerCloudRevision(revision);
      await commit(current => {
        const item = findItem(current, { kind: "projectPreparation", projectId });
        if (item === undefined || current.authority.desired?.revision !== revision || item.value.targetRevision !== revision || hasUnfinishedRemoval(current, projectId)) return current;
        return replaceItem(current, { ...item, backoffStep: 0, actualSource: observedSource(item), value: { ...item.value, appliedValue: true, state: "applied", error: null, nextAttemptAt: null } });
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
        if (queued || applyingScalars) continue;
        check();
        return;
      }
    },
    stop: async (): Promise<void> => { halt(); await Promise.all([...jobs.values()].map(job => job.promise)); await tail; check(); },
  };
};
export type WorkerConfigurationManager = Awaited<ReturnType<typeof createWorkerConfigurationManager>>;
