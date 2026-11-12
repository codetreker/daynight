import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { canonicalId } from "../../api/parse.js";
import { parseWorkerCloudItem, parseWorkerCloudRevision } from "../../api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudItemKey } from "../../api/worker-configuration.js";
import type { AgentControlMode } from "../../api/types.js";
import { configurationJsonChunks, parseConfigurationJson } from "./configuration-json.js";
import { configurationKey, configurationRetryDelays, configurationSupportsMode, freezeConfiguration, parseConfigurationDesired } from "./configuration-model.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache, WorkerConfigurationIdentity } from "./configuration-model.js";

type CacheRead = { readonly cache: WorkerConfigurationCache; readonly migrated: boolean };
type LegacyItem = { readonly value: WorkerCloudItem; readonly attempts: number; readonly failureId: number | null; readonly started: boolean };
type LegacyCache = {
  readonly desired: WorkerCloudDesired | null;
  readonly observationRevision: string;
  readonly nextFailureId: number;
  readonly items: readonly LegacyItem[];
  readonly nativeModes: Readonly<Record<string, AgentControlMode>>;
};

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError("Worker configuration cache has an invalid structure.");
  return value as Record<string, unknown>;
};
const counter = (value: unknown, minimum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError("Worker configuration cache has an invalid counter.");
  return value;
};
const uuid = (value: unknown): string => {
  if (typeof value !== "string") throw new TypeError("Worker configuration cache has an invalid record identity.");
  const parsed = canonicalId(value);
  if (parsed === null || parsed !== value) throw new TypeError("Worker configuration cache has an invalid record identity.");
  return parsed;
};
const identityMatches = (value: unknown, identity: WorkerConfigurationIdentity): void => {
  const scope = exact(value, ["serverOrigin", "userId", "workerId"]);
  if (scope.serverOrigin !== identity.serverOrigin || scope.userId !== identity.userId || scope.workerId !== identity.workerId) throw new Error("Worker configuration cache identity or schema does not match this Worker.");
};
const requiredKeys = (desired: WorkerCloudDesired): WorkerCloudItemKey[] => {
  const keys: WorkerCloudItemKey[] = ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native"].map(kind => ({ kind }) as WorkerCloudItemKey);
  if (configurationSupportsMode(desired)) keys.push({ kind: "agentControlMode" });
  for (const project of desired.value.projects) keys.push({ kind: "projectPreparation", projectId: project.projectId }, { kind: "projectNative", projectId: project.projectId });
  return keys;
};
const requireTargetItems = (items: readonly WorkerCloudItem[], desired: WorkerCloudDesired | null): void => {
  if (desired === null) {
    if (items.length !== 0) throw new TypeError("Worker configuration cache has application results without a target.");
    return;
  }
  const records = new Map(items.map(item => [configurationKey(item.key), item]));
  if (requiredKeys(desired).some(key => records.get(configurationKey(key))?.targetRevision !== desired.revision)) throw new TypeError("Worker configuration cache is missing target application results.");
};
const requireFailureSequence = (items: readonly { readonly failureId: number | null }[], nextFailureId: number): void => {
  if (items.some(item => item.failureId !== null && item.failureId >= nextFailureId)) throw new TypeError("Worker configuration cache failure sequence is invalid.");
};

const parseLegacy = (source: Record<string, unknown>, identity: WorkerConfigurationIdentity): LegacyCache => {
  const version = source.schemaVersion;
  const data = exact(source, ["schemaVersion", "identity", "desired", "observationRevision", "nextFailureId", "items", ...(version === 3 || version === 4 ? ["nativeModes"] : [])]);
  identityMatches(data.identity, identity);
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) throw new Error("Worker configuration cache identity or schema does not match this Worker.");
  const preferenceMigration = version === 1;
  let desiredSource = data.desired;
  if (preferenceMigration && desiredSource !== null) {
    const previous = exact(desiredSource, ["revision", "updatedAt", "value"]);
    const value = exact(previous.value, ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "native", "projects"]);
    desiredSource = { ...previous, value: { ...value, preferPlatformSpecificTasks: false } };
  }
  // Historical facts remain structurally readable after API admission limits change.
  const desired = desiredSource === null ? null : parseConfigurationDesired(desiredSource as WorkerCloudDesired, false);
  if (!Array.isArray(data.items)) throw new TypeError("Worker configuration cache items must be an array.");
  const keys = new Set<string>();
  const items: LegacyItem[] = data.items.map(entry => {
    const stored = exact(entry, ["value", "attempts", "failureId", "started"]);
    const value = parseWorkerCloudItem(stored.value, false, configurationSupportsMode(desired)), key = configurationKey(value.key);
    const failureId = stored.failureId === null ? null : counter(stored.failureId, 1), attempts = counter(stored.attempts, 0);
    if (keys.has(key) || desired === null || BigInt(value.targetRevision) > BigInt(desired.revision) || typeof stored.started !== "boolean" || stored.started && value.key.kind !== "projectRemoval" || (value.lastFailure === null) !== (failureId === null)) throw new TypeError("Worker configuration cache has inconsistent application results.");
    if (preferenceMigration && value.key.kind === "preferPlatformSpecificTasks") throw new TypeError("Worker configuration cache version does not match its application results.");
    if (attempts > configurationRetryDelays.length) throw new TypeError("Worker configuration cache retry count is invalid.");
    keys.add(key);
    return { value: value.state === "applying" ? { ...value, state: "pending" } : value, attempts, failureId, started: stored.started };
  });
  if (preferenceMigration && desired !== null) items.push({ value: {
    key: { kind: "preferPlatformSpecificTasks" }, targetRevision: desired.revision, appliedValue: null,
    state: "pending", error: null, lastFailure: null, nextAttemptAt: null,
  }, attempts: 0, failureId: null, started: false });
  const nextFailureId = counter(data.nextFailureId, 1), observationRevision = parseWorkerCloudRevision(data.observationRevision, true);
  requireFailureSequence(items, nextFailureId);
  if (desired === null && observationRevision !== "0") throw new TypeError("Worker configuration cache has an observation without a target.");
  requireTargetItems(items.map(item => item.value), desired);
  const nativeModes: Record<string, AgentControlMode> = {};
  if (version === 3 || version === 4) {
    if (typeof data.nativeModes !== "object" || data.nativeModes === null || Array.isArray(data.nativeModes)) throw new TypeError("Worker configuration native modes are invalid.");
    const byKey = new Map(items.map(item => [configurationKey(item.value.key), item.value]));
    for (const [key, mode] of Object.entries(data.nativeModes)) {
      const item = byKey.get(key);
      if ((mode !== "herdr" && mode !== "web") || item === undefined || (item.key.kind !== "native" && item.key.kind !== "projectNative") || item.appliedValue === null) throw new TypeError("Worker configuration native mode has no matching applied value.");
      nativeModes[key] = mode;
    }
  }
  return { desired, observationRevision, nextFailureId, items, nativeModes };
};

const upgradeLegacy = (legacy: LegacyCache, identity: WorkerConfigurationIdentity): WorkerConfigurationCache => {
  const generation = randomUUID(), current = new Set(legacy.desired === null ? [] : requiredKeys(legacy.desired).map(configurationKey));
  const currentItems: TrackedConfigurationItem[] = [], retainedItems: TrackedConfigurationItem[] = [];
  for (const item of legacy.items) {
    const key = configurationKey(item.value.key), tracked: TrackedConfigurationItem = {
      recordId: randomUUID(), origin: { generation, targetRevision: item.value.targetRevision, source: "schema4" }, value: item.value,
      backoffStep: item.attempts, failureId: item.failureId, started: item.started,
      nativeMode: legacy.nativeModes[key] ?? null,
      actualSource: item.value.appliedValue === null ? null : { kind: "schema4", successRevision: null }, blockedByRemovalId: null,
    };
    (current.has(key) || item.value.key.kind === "projectRemoval" ? currentItems : retainedItems).push(tracked);
  }
  return { schemaVersion: 5, identity: { ...identity }, authority: { generation, desired: legacy.desired, observationRevision: legacy.observationRevision }, nextFailureId: legacy.nextFailureId, projectionCursor: null, currentItems, retainedItems };
};

const actualSource = (value: unknown): TrackedConfigurationItem["actualSource"] => {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Worker configuration cache has invalid actual-value provenance.");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "schema4") {
    const source = exact(value, ["kind", "successRevision"]);
    if (source.successRevision !== null) throw new TypeError("Worker configuration cache cannot infer a legacy success revision.");
    return { kind, successRevision: null };
  }
  const source = exact(value, ["kind", "recordId", "generation", "targetRevision"]);
  if (kind !== "observed") throw new TypeError("Worker configuration cache has invalid actual-value provenance.");
  return { kind, recordId: uuid(source.recordId), generation: uuid(source.generation), targetRevision: parseWorkerCloudRevision(source.targetRevision) };
};
const parseTracked = (source: unknown, controlMode: boolean): TrackedConfigurationItem => {
  const data = exact(source, ["recordId", "origin", "value", "backoffStep", "failureId", "started", "nativeMode", "actualSource", "blockedByRemovalId"]);
  const origin = exact(data.origin, ["generation", "targetRevision", "source"]), value = parseWorkerCloudItem(data.value, false, controlMode);
  const revision = parseWorkerCloudRevision(origin.targetRevision), backoffStep = counter(data.backoffStep, 0), failureId = data.failureId === null ? null : counter(data.failureId, 1);
  if ((origin.source !== "application" && origin.source !== "schema4") || revision !== value.targetRevision || backoffStep > configurationRetryDelays.length || typeof data.started !== "boolean" || data.started && value.key.kind !== "projectRemoval" || (value.lastFailure === null) !== (failureId === null)) throw new TypeError("Worker configuration cache has inconsistent application facts.");
  const provenance = actualSource(data.actualSource);
  if ((value.appliedValue === null) !== (provenance === null)) throw new TypeError("Worker configuration cache has inconsistent actual-value provenance.");
  if (data.nativeMode !== null && ((data.nativeMode !== "herdr" && data.nativeMode !== "web") || (value.key.kind !== "native" && value.key.kind !== "projectNative") || value.appliedValue === null)) throw new TypeError("Worker configuration native mode has no matching applied value.");
  return {
    recordId: uuid(data.recordId), origin: { generation: uuid(origin.generation), targetRevision: revision, source: origin.source },
    value: value.state === "applying" ? { ...value, state: "pending" } : value,
    backoffStep, failureId, started: data.started, nativeMode: data.nativeMode as AgentControlMode | null,
    actualSource: provenance, blockedByRemovalId: data.blockedByRemovalId === null ? null : uuid(data.blockedByRemovalId),
  };
};
const requireReferences = (items: readonly TrackedConfigurationItem[]): void => {
  const byId = new Map<string, TrackedConfigurationItem>();
  for (const item of items) {
    if (byId.has(item.recordId)) throw new TypeError("Worker configuration cache repeats a record identity.");
    byId.set(item.recordId, item);
  }
  for (const item of items) {
    if (item.blockedByRemovalId === null) continue;
    const blocker = byId.get(item.blockedByRemovalId);
    if (blocker === undefined || blocker.value.key.kind !== "projectRemoval" || !("projectId" in item.value.key) || item.value.key.projectId !== blocker.value.key.projectId) throw new TypeError("Worker configuration cache has an invalid removal dependency.");
  }
  const complete = new Set<string>();
  for (const item of items) {
    const path = new Set<string>();
    let current: TrackedConfigurationItem | undefined = item;
    while (current !== undefined && !complete.has(current.recordId)) {
      if (path.has(current.recordId)) throw new TypeError("Worker configuration cache removal dependencies contain a cycle.");
      path.add(current.recordId);
      current = current.blockedByRemovalId === null ? undefined : byId.get(current.blockedByRemovalId);
    }
    for (const id of path) complete.add(id);
  }
};
const parseCurrent = (source: Record<string, unknown>, identity: WorkerConfigurationIdentity): WorkerConfigurationCache => {
  const data = exact(source, ["schemaVersion", "identity", "authority", "nextFailureId", "projectionCursor", "currentItems", "retainedItems"]);
  identityMatches(data.identity, identity);
  const authority = exact(data.authority, ["generation", "desired", "observationRevision"]);
  const desired = authority.desired === null ? null : parseConfigurationDesired(authority.desired as WorkerCloudDesired, false);
  const observationRevision = parseWorkerCloudRevision(authority.observationRevision, true), nextFailureId = counter(data.nextFailureId, 1);
  if (desired === null && observationRevision !== "0") throw new TypeError("Worker configuration cache has an observation without a target.");
  if (!Array.isArray(data.currentItems) || !Array.isArray(data.retainedItems)) throw new TypeError("Worker configuration cache items must be arrays.");
  const currentItems = data.currentItems.map(item => parseTracked(item, configurationSupportsMode(desired))), retainedItems = data.retainedItems.map(item => parseTracked(item, true));
  const keys = new Set<string>(), selected = new Set(desired?.value.projects.map(project => project.projectId));
  for (const item of currentItems) {
    const key = configurationKey(item.value.key);
    if (keys.has(key) || desired === null || BigInt(item.value.targetRevision) > BigInt(desired.revision) || (item.value.key.kind === "projectPreparation" || item.value.key.kind === "projectNative") && !selected.has(item.value.key.projectId)) throw new TypeError("Worker configuration cache has inconsistent current application results.");
    keys.add(key);
  }
  requireTargetItems(currentItems.map(item => item.value), desired);
  const all = [...currentItems, ...retainedItems];
  requireReferences(all);
  requireFailureSequence(all, nextFailureId);
  return { schemaVersion: 5, identity: { ...identity }, authority: { generation: uuid(authority.generation), desired, observationRevision }, nextFailureId,
    projectionCursor: data.projectionCursor === null ? null : uuid(data.projectionCursor), currentItems, retainedItems };
};

export const createConfigurationCache = (identity: WorkerConfigurationIdentity): WorkerConfigurationCache => freezeConfiguration({
  schemaVersion: 5, identity: { ...identity }, authority: { generation: randomUUID(), desired: null, observationRevision: "0" },
  nextFailureId: 1, projectionCursor: null, currentItems: [], retainedItems: [],
});
export const parseConfigurationCache = (source: unknown, identity: WorkerConfigurationIdentity): CacheRead => {
  if (typeof source !== "object" || source === null || Array.isArray(source)) throw new TypeError("Worker configuration cache has an invalid structure.");
  const data = source as Record<string, unknown>, migrated = data.schemaVersion !== 5;
  const current = migrated ? upgradeLegacy(parseLegacy(data, identity), identity) : data;
  const cache = parseCurrent(current as unknown as Record<string, unknown>, identity);
  return { cache: freezeConfiguration(cache), migrated };
};
export const readConfigurationCache = async (file: string, identity: WorkerConfigurationIdentity, signal: AbortSignal): Promise<CacheRead> => {
  signal.throwIfAborted();
  const handle = await open(file, "r");
  let failed = false, primary: unknown;
  try {
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 16_384, signal });
    const source = await parseConfigurationJson(stream);
    signal.throwIfAborted();
    return parseConfigurationCache(source, identity);
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { await handle.close(); }
    catch (error) { if (failed) throw new AggregateError([primary, error], "Worker configuration cache read and close failed.", { cause: primary }); throw error; }
  }
};
export const configurationCacheChunks = (snapshot: WorkerConfigurationCache): Iterable<string> => configurationJsonChunks(snapshot);
