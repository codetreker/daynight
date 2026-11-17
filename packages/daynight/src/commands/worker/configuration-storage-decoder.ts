import { randomUUID } from "node:crypto";
import { canonicalId, ProtocolError } from "../../api/validation.js";
import { configurationJsonChunks } from "./configuration-json.js";
import { parseWorkerCloudItem, parseWorkerCloudRevision, parseConfigurationDesired } from "./configuration-storage-wire.js";
import { receiveStoredDesired9, receiveWorkerDesired, validateHiddenCapabilitySource, validateWorkerRemoteObservation, workerCapabilityKeys } from "./configuration-storage-source.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudItemKey, AgentControlMode, TrackedConfigurationItem, WorkerConfigurationCache, WorkerConfigurationIdentity } from "./configuration-storage-types.js";

type DecodedTracked = Omit<TrackedConfigurationItem, "nativeMode"> & { readonly nativeMode?: AgentControlMode | null };
type DecodedStorageCache = Omit<WorkerConfigurationCache, "schemaVersion" | "authority" | "currentItems" | "retainedItems"> & {
  readonly schemaVersion: 8 | 9;
  readonly authority: WorkerConfigurationCache["authority"] & { readonly pendingApplication: boolean };
  readonly currentItems: readonly DecodedTracked[];
  readonly retainedItems: readonly DecodedTracked[];
};
type DecodedCache = { readonly cache: DecodedStorageCache; readonly migration: { readonly received: { readonly json: string; readonly revision: string; readonly updatedAt: string; readonly known: WorkerCloudDesired }; readonly previousDesired: WorkerCloudDesired } | null };
const configurationRetryDelays = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
const configurationKey = (key: WorkerCloudItemKey): string => `${key.kind}:${"projectId" in key ? key.projectId : ""}`;
const configurationSupportsMode = (desired: WorkerCloudDesired | null): boolean => desired !== null && Object.hasOwn(desired.value, "agentControlMode");
const isApplicableWeb = (desired: WorkerCloudDesired | null): boolean => {
  if (desired?.value.agentControlMode !== "web") return false;
  try { parseConfigurationDesired(desired, true); return true; }
  catch (error) { if (!(error instanceof ProtocolError)) throw error; return false; }
};

type Cache5 = Omit<DecodedStorageCache, "schemaVersion" | "authority" | "remoteObservation" | "hiddenCapabilitySources"> & {
  readonly schemaVersion: 5;
  readonly authority: { readonly generation: string; readonly desired: WorkerCloudDesired | null; readonly observationRevision: string };
};
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
const requiredKeys = (desired: WorkerCloudDesired, webOnly = false): WorkerCloudItemKey[] => {
  const keys: WorkerCloudItemKey[] = ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native"].map(kind => ({ kind }) as WorkerCloudItemKey);
  if (!webOnly && configurationSupportsMode(desired)) keys.push({ kind: "agentControlMode" });
  if (desired.value.archiveSessions !== undefined) keys.push({ kind: "archiveSessions" });
  if (desired.value.enableSudoCleanup !== undefined) keys.push({ kind: "enableSudoCleanup" });
  for (const project of desired.value.projects) keys.push({ kind: "projectPreparation", projectId: project.projectId }, { kind: "projectNative", projectId: project.projectId });
  return keys;
};
const requireTargetItems = (items: readonly WorkerCloudItem[], desired: WorkerCloudDesired | null, revision = desired?.revision, webOnly = false): void => {
  if (desired === null) {
    if (items.length !== 0) throw new TypeError("Worker configuration cache has application results without a target.");
    return;
  }
  const records = new Map(items.map(item => [configurationKey(item.key), item]));
  if (requiredKeys(desired, webOnly).some(key => records.get(configurationKey(key))?.targetRevision !== revision)) throw new TypeError("Worker configuration cache is missing target application results.");
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

const upgradeLegacy = (legacy: LegacyCache, identity: WorkerConfigurationIdentity): Cache5 => {
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
const parseTracked = (source: unknown, controlMode: boolean, archiveSessions = false, webOnly = false): DecodedTracked => {
  const data = exact(source, ["recordId", "origin", "value", "backoffStep", "failureId", "started", ...(webOnly ? [] : ["nativeMode"]), "actualSource", "blockedByRemovalId"]);
  const origin = exact(data.origin, ["generation", "targetRevision", "source"]), value = parseWorkerCloudItem(data.value, false, { controlMode, toolPaths: false, archiveSessions });
  const revision = parseWorkerCloudRevision(origin.targetRevision), backoffStep = counter(data.backoffStep, 0), failureId = data.failureId === null ? null : counter(data.failureId, 1);
  if ((origin.source !== "application" && origin.source !== "schema4") || revision !== value.targetRevision || backoffStep > configurationRetryDelays.length || typeof data.started !== "boolean" || data.started && value.key.kind !== "projectRemoval" || (value.lastFailure === null) !== (failureId === null)) throw new TypeError("Worker configuration cache has inconsistent application facts.");
  const provenance = actualSource(data.actualSource);
  if ((value.appliedValue === null) !== (provenance === null)) throw new TypeError("Worker configuration cache has inconsistent actual-value provenance.");
  if (!webOnly && data.nativeMode !== null && ((data.nativeMode !== "herdr" && data.nativeMode !== "web") || (value.key.kind !== "native" && value.key.kind !== "projectNative") || value.appliedValue === null)) throw new TypeError("Worker configuration native mode has no matching applied value.");
  return {
    recordId: uuid(data.recordId), origin: { generation: uuid(origin.generation), targetRevision: revision, source: origin.source },
    value: value.state === "applying" ? { ...value, state: "pending" } : value,
    backoffStep, failureId, started: data.started, ...(webOnly ? {} : { nativeMode: data.nativeMode as AgentControlMode | null }),
    actualSource: provenance, blockedByRemovalId: data.blockedByRemovalId === null ? null : uuid(data.blockedByRemovalId),
  };
};
const requireReferences = (items: readonly DecodedTracked[]): void => {
  const byId = new Map<string, DecodedTracked>();
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
    let current: DecodedTracked | undefined = item;
    while (current !== undefined && !complete.has(current.recordId)) {
      if (path.has(current.recordId)) throw new TypeError("Worker configuration cache removal dependencies contain a cycle.");
      path.add(current.recordId);
      current = current.blockedByRemovalId === null ? undefined : byId.get(current.blockedByRemovalId);
    }
    for (const id of path) complete.add(id);
  }
};
const parseSchema5 = (source: Record<string, unknown>, identity: WorkerConfigurationIdentity, applicationRevision?: string, preSudo = false, webOnly = false, targetMatches = true): Cache5 => {
  const data = exact(source, ["schemaVersion", "identity", "authority", "nextFailureId", "projectionCursor", "currentItems", "retainedItems"]);
  identityMatches(data.identity, identity);
  const authority = exact(data.authority, ["generation", "desired", "observationRevision"]);
  const desired = authority.desired === null ? null : parseConfigurationDesired(authority.desired as WorkerCloudDesired, false);
  if (preSudo && (desired?.value.enableSudoCleanup !== undefined || desired?.value.archiveSessions !== undefined)) throw new TypeError("Worker configuration cache has a future known field.");
  const observationRevision = parseWorkerCloudRevision(authority.observationRevision, true), nextFailureId = counter(data.nextFailureId, 1);
  if (!webOnly && desired === null && observationRevision !== "0") throw new TypeError("Worker configuration cache has an observation without a target.");
  if (!Array.isArray(data.currentItems) || !Array.isArray(data.retainedItems)) throw new TypeError("Worker configuration cache items must be arrays.");
  const currentItems = data.currentItems.map(item => parseTracked(item, !webOnly && configurationSupportsMode(desired), webOnly && !targetMatches || desired?.value.archiveSessions !== undefined, webOnly)), retainedItems = data.retainedItems.map(item => parseTracked(item, !webOnly, true, webOnly));
  if (preSudo && [...currentItems, ...retainedItems].some(item => item.value.key.kind === "enableSudoCleanup" || item.value.key.kind === "archiveSessions")) throw new TypeError("Worker configuration cache has a future application result.");
  const keys = new Set<string>(), selected = new Set(desired?.value.projects.map(project => project.projectId));
  for (const item of currentItems) {
    const key = configurationKey(item.value.key);
    if (targetMatches && item.value.key.kind === "enableSudoCleanup" && desired?.value.enableSudoCleanup === undefined) throw new TypeError("Worker configuration cache has a sudo result without a target.");
    if (keys.has(key) || targetMatches && (desired === null || BigInt(item.value.targetRevision) > BigInt(desired.revision) || (item.value.key.kind === "projectPreparation" || item.value.key.kind === "projectNative") && !selected.has(item.value.key.projectId))) throw new TypeError("Worker configuration cache has inconsistent current application results.");
    keys.add(key);
  }
  if (targetMatches) requireTargetItems(currentItems.map(item => item.value), desired, applicationRevision, webOnly);
  const all = [...currentItems, ...retainedItems];
  requireReferences(all);
  requireFailureSequence(all, nextFailureId);
  return { schemaVersion: 5, identity: { ...identity }, authority: { generation: uuid(authority.generation), desired, observationRevision }, nextFailureId,
    projectionCursor: data.projectionCursor === null ? null : uuid(data.projectionCursor), currentItems, retainedItems };
};

const upgradeSchema5 = (cache: Cache5): DecodedStorageCache => ({
  ...cache,
  schemaVersion: 8,
  authority: {
    generation: cache.authority.generation,
    desiredJson: cache.authority.desired === null ? null : [...configurationJsonChunks(cache.authority.desired)].join(""),
    applicationRevision: cache.authority.desired?.revision ?? null,
    observationRevision: cache.authority.observationRevision,
    pendingApplication: !isApplicableWeb(cache.authority.desired),
  },
  remoteObservation: null,
});

const parseCurrent = (source: Record<string, unknown>, identity: WorkerConfigurationIdentity, legacy = false, webOnly = false): DecodedCache => {
  const data = exact(source, ["schemaVersion", "identity", "authority", "remoteObservation", "nextFailureId", "projectionCursor", "currentItems", "retainedItems", ...(Object.hasOwn(source, "hiddenCapabilitySources") ? ["hiddenCapabilitySources"] : [])]);
  identityMatches(data.identity, identity);
  const authority = exact(data.authority, ["generation", "desiredJson", "applicationRevision", "observationRevision", ...(webOnly ? ["pendingApplication"] : [])]);
  if (authority.desiredJson !== null && typeof authority.desiredJson !== "string") throw new TypeError("Worker configuration cache has an invalid desired source.");
  const legacyReceived = authority.desiredJson === null || webOnly ? null : receiveWorkerDesired(authority.desiredJson);
  const currentReceived = authority.desiredJson === null || !webOnly ? null : receiveStoredDesired9(authority.desiredJson);
  const desired = legacyReceived?.known ?? currentReceived?.known ?? null;
  const rawRevision = legacyReceived?.known.revision ?? currentReceived?.revision ?? null;
  const applicationRevision = authority.applicationRevision === null ? null : parseWorkerCloudRevision(authority.applicationRevision);
  if (!webOnly && ((desired === null) !== (applicationRevision === null) || applicationRevision !== null && desired !== null && BigInt(applicationRevision) > BigInt(desired.revision))) throw new TypeError("Worker configuration cache has an invalid application revision.");
  // The execution ledger belongs to the last known target change, even when a
  // newer received document changed only fields this binary cannot execute.
  if (!Array.isArray(data.currentItems)) throw new TypeError("Worker configuration cache items must be arrays.");
  const currentKinds = new Set(data.currentItems.flatMap(item => {
    if (typeof item !== "object" || item === null || !("value" in item) || typeof item.value !== "object" || item.value === null || !("key" in item.value) || typeof item.value.key !== "object" || item.value.key === null || !("kind" in item.value.key)) return [];
    return [item.value.key.kind];
  }));
  if (data.schemaVersion === 6 && (currentKinds.has("enableSudoCleanup") || currentKinds.has("archiveSessions"))) throw new TypeError("Worker configuration cache has a future application result.");
  const missingSudo = legacy && desired?.value.enableSudoCleanup !== undefined && !currentKinds.has("enableSudoCleanup");
  const missingArchive = legacy && desired?.value.archiveSessions !== undefined && !currentKinds.has("archiveSessions");
  const previousDesired = desired === null ? null : { ...desired, value: { ...desired.value } };
  if (missingSudo) delete (previousDesired!.value as { enableSudoCleanup?: boolean }).enableSudoCleanup;
  if (missingArchive) delete (previousDesired!.value as { archiveSessions?: boolean }).archiveSessions;
  const applicableWeb = isApplicableWeb(desired);
  if (webOnly && typeof authority.pendingApplication !== "boolean") throw new TypeError("Worker configuration cache has an invalid pending application flag.");
  const pendingApplication = webOnly ? authority.pendingApplication as boolean : !applicableWeb || applicationRevision === null;
  if (webOnly && !pendingApplication && (!applicableWeb || applicationRevision === null)) throw new TypeError("Worker configuration cache has an invalid applied target.");
  const checked = parseSchema5({
    schemaVersion: 5, identity: data.identity,
    authority: { generation: authority.generation, desired: previousDesired, observationRevision: authority.observationRevision },
    nextFailureId: data.nextFailureId, projectionCursor: data.projectionCursor, currentItems: data.currentItems, retainedItems: data.retainedItems,
  }, identity, applicationRevision ?? undefined, data.schemaVersion === 6, webOnly,
  !webOnly || !pendingApplication);
  let remoteObservation: WorkerConfigurationCache["remoteObservation"] = null;
  if (data.remoteObservation !== null) {
    const remote = exact(data.remoteObservation, ["observationRevision", "json"]);
    const observationRevision = parseWorkerCloudRevision(remote.observationRevision);
    if (typeof remote.json !== "string") throw new TypeError("Worker configuration cache has an invalid remote observation.");
    if (data.schemaVersion === 6) validateWorkerRemoteObservation(remote.json, observationRevision, false);
    validateWorkerRemoteObservation(remote.json, observationRevision);
    remoteObservation = { observationRevision, json: remote.json };
  }
  let hiddenCapabilitySources: WorkerConfigurationCache["hiddenCapabilitySources"];
  if (Object.hasOwn(data, "hiddenCapabilitySources")) {
    if (rawRevision === null || typeof data.hiddenCapabilitySources !== "object" || data.hiddenCapabilitySources === null || Array.isArray(data.hiddenCapabilitySources)) throw new TypeError("Worker configuration cache has invalid hidden capability sources.");
    const sources = data.hiddenCapabilitySources as Record<string, unknown>;
    if (Object.keys(sources).length === 0 || Object.keys(sources).some(key => !workerCapabilityKeys.includes(key as typeof workerCapabilityKeys[number]))) throw new TypeError("Worker configuration cache has invalid hidden capability sources.");
    const parsed: NonNullable<WorkerConfigurationCache["hiddenCapabilitySources"]> = {};
    for (const key of workerCapabilityKeys) {
      if (!Object.hasOwn(sources, key)) continue;
      const source = exact(sources[key], ["revision", "json"]), revision = parseWorkerCloudRevision(source.revision);
      if (typeof source.json !== "string" || BigInt(revision) > BigInt(rawRevision)) throw new TypeError("Worker configuration cache has an invalid hidden capability source.");
      validateHiddenCapabilitySource(authority.desiredJson as string, key, source.json, webOnly);
      Object.assign(parsed, { [key]: { revision, json: source.json } });
    }
    hiddenCapabilitySources = parsed;
  }
  const parsed: DecodedStorageCache = {
    ...checked, schemaVersion: webOnly ? 9 : 8,
    authority: { generation: checked.authority.generation, desiredJson: authority.desiredJson, applicationRevision, observationRevision: checked.authority.observationRevision, pendingApplication },
    remoteObservation,
    ...(hiddenCapabilitySources === undefined ? {} : { hiddenCapabilitySources }),
  };
  return { cache: parsed, migration: missingSudo || missingArchive ? { received: { ...legacyReceived!, revision: legacyReceived!.known.revision, updatedAt: legacyReceived!.known.updatedAt }, previousDesired: previousDesired! } : null };
};

export const decodeConfigurationCache = (source: unknown, identity: WorkerConfigurationIdentity): DecodedCache & { readonly migrated: boolean } => {
  if (typeof source !== "object" || source === null || Array.isArray(source)) throw new TypeError("Worker configuration cache has an invalid structure.");
  const data = source as Record<string, unknown>, version = data.schemaVersion, migrated = version !== 9;
  if (version === 6 || version === 7 || version === 8 || version === 9) return { ...parseCurrent(data, identity, version === 6 || version === 7, version === 9), migrated };
  return { cache: upgradeSchema5(parseSchema5(version === 5 ? data : upgradeLegacy(parseLegacy(data, identity), identity) as unknown as Record<string, unknown>, identity, undefined, true)), migration: null, migrated };
};
