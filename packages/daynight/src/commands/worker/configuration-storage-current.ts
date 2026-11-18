import { canonicalId } from "../../api/validation.js";
import { parseWorkerCloudItem, parseWorkerCloudRevision, receiveWorkerDesired, desiredCapabilitySources } from "../../api/worker-configuration.js";
import { workerCapabilityKeys, validateHiddenCapabilitySource, validateWorkerRemoteObservation } from "./configuration-storage-source.js";
import { applicableConfigurationDesired } from "./configuration-model.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache, WorkerConfigurationIdentity } from "./configuration-model.js";
import type { WorkerCloudDesired, WorkerCloudItemKey } from "../../api/worker-configuration.js";

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError("Worker configuration cache has an invalid structure.");
  return value as Record<string, unknown>;
};
const counter = (value: unknown, minimum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError("Worker configuration cache has an invalid counter.");
  return value;
};
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || canonicalId(value) !== value) throw new TypeError("Worker configuration cache has an invalid record identity.");
  return value;
};
const keyOf = (key: WorkerCloudItemKey): string => `${key.kind}:${"projectId" in key ? key.projectId : ""}`;
const requiredKeys = (desired: WorkerCloudDesired): WorkerCloudItemKey[] => [
  ...["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native"].map(kind => ({ kind }) as WorkerCloudItemKey),
  ...(desired.value.taskTagFilter === undefined ? [] : [{ kind: "taskTagFilter" } as const]),
  ...(desired.value.archiveSessions === undefined ? [] : [{ kind: "archiveSessions" } as const]),
  ...(desired.value.enableSudoCleanup === undefined ? [] : [{ kind: "enableSudoCleanup" } as const]),
  ...desired.value.projects.flatMap(project => [{ kind: "projectPreparation", projectId: project.projectId } as const, { kind: "projectNative", projectId: project.projectId } as const]),
];
const provenance = (value: unknown): TrackedConfigurationItem["actualSource"] => {
  if (value === null) return null;
  if (typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "schema4") {
    const data = exact(value, ["kind", "successRevision"]);
    if (data.successRevision !== null) throw new TypeError("Worker configuration cache cannot infer a legacy success revision.");
    return { kind: "schema4", successRevision: null };
  }
  const data = exact(value, ["kind", "recordId", "generation", "targetRevision"]);
  if (data.kind !== "observed") throw new TypeError("Worker configuration cache has invalid actual-value provenance.");
  return { kind: "observed", recordId: uuid(data.recordId), generation: uuid(data.generation), targetRevision: parseWorkerCloudRevision(data.targetRevision) };
};
const tracked = (source: unknown): TrackedConfigurationItem => {
  const data = exact(source, ["recordId", "origin", "value", "backoffStep", "failureId", "started", "actualSource", "blockedByRemovalId"]);
  const origin = exact(data.origin, ["generation", "targetRevision", "source"]);
  const value = parseWorkerCloudItem(data.value, false, { controlMode: true, toolPaths: false, archiveSessions: true });
  const targetRevision = parseWorkerCloudRevision(origin.targetRevision), backoffStep = counter(data.backoffStep, 0), failureId = data.failureId === null ? null : counter(data.failureId, 1);
  if ((origin.source !== "application" && origin.source !== "schema4") || targetRevision !== value.targetRevision || backoffStep > 5 || typeof data.started !== "boolean" || data.started && value.key.kind !== "projectRemoval" || (value.lastFailure === null) !== (failureId === null)) throw new TypeError("Worker configuration cache has inconsistent application facts.");
  const actualSource = provenance(data.actualSource);
  if ((value.appliedValue === null) !== (actualSource === null)) throw new TypeError("Worker configuration cache has inconsistent actual-value provenance.");
  return { recordId: uuid(data.recordId), origin: { generation: uuid(origin.generation), targetRevision, source: origin.source },
    value: value.state === "applying" ? { ...value, state: "pending" } : value, backoffStep, failureId, started: data.started, actualSource,
    blockedByRemovalId: data.blockedByRemovalId === null ? null : uuid(data.blockedByRemovalId) };
};
const references = (items: readonly TrackedConfigurationItem[], nextFailureId: number): void => {
  const byId = new Map<string, TrackedConfigurationItem>();
  for (const item of items) {
    if (byId.has(item.recordId)) throw new TypeError("Worker configuration cache repeats a record identity.");
    if (item.failureId !== null && item.failureId >= nextFailureId) throw new TypeError("Worker configuration cache failure sequence is invalid.");
    byId.set(item.recordId, item);
  }
  for (const item of items) {
    const visited = new Set<string>();
    let current = item;
    while (current.blockedByRemovalId !== null) {
      if (visited.has(current.recordId)) throw new TypeError("Worker configuration cache removal dependencies contain a cycle.");
      visited.add(current.recordId);
      const blocker = byId.get(current.blockedByRemovalId);
      if (blocker === undefined || blocker.value.key.kind !== "projectRemoval" || !("projectId" in current.value.key) || current.value.key.projectId !== blocker.value.key.projectId) throw new TypeError("Worker configuration cache has an invalid removal dependency.");
      current = blocker;
    }
  }
};

export const decodeCurrentConfigurationCache = (source: Record<string, unknown>, identity: WorkerConfigurationIdentity): WorkerConfigurationCache => {
  const data = exact(source, ["schemaVersion", "identity", "authority", "remoteObservation", "nextFailureId", "projectionCursor", "currentItems", "retainedItems", ...(Object.hasOwn(source, "hiddenCapabilitySources") ? ["hiddenCapabilitySources"] : [])]);
  const scope = exact(data.identity, ["serverOrigin", "userId", "workerId"]);
  if (data.schemaVersion !== 11 || scope.serverOrigin !== identity.serverOrigin || scope.userId !== identity.userId || scope.workerId !== identity.workerId) throw new Error("Worker configuration cache identity or schema does not match this Worker.");
  const authority = exact(data.authority, ["generation", "desiredJson", "applicationRevision", "observationRevision", "pendingApplication"]);
  if (authority.desiredJson !== null && typeof authority.desiredJson !== "string" || typeof authority.pendingApplication !== "boolean") throw new TypeError("Worker configuration cache has an invalid authority.");
  const desiredJson = authority.desiredJson as string | null;
  const received = desiredJson === null ? null : receiveWorkerDesired(desiredJson, { controlMode: false, toolPaths: true, archiveSessions: desiredCapabilitySources(desiredJson).has("archiveSessions") });
  const desired = received?.known ?? null, applicationRevision = authority.applicationRevision === null ? null : parseWorkerCloudRevision(authority.applicationRevision);
  const observationRevision = parseWorkerCloudRevision(authority.observationRevision, true), nextFailureId = counter(data.nextFailureId, 1);
  if (!authority.pendingApplication && (applicableConfigurationDesired(desired) === null || applicationRevision === null)) throw new TypeError("Worker configuration cache has an invalid applied target.");
  if (!Array.isArray(data.currentItems) || !Array.isArray(data.retainedItems)) throw new TypeError("Worker configuration cache items must be arrays.");
  const currentItems = data.currentItems.map(tracked), retainedItems = data.retainedItems.map(tracked), keys = new Map<string, TrackedConfigurationItem>();
  const selected = new Set(desired?.value.projects.map(project => project.projectId));
  for (const item of currentItems) {
    const key = keyOf(item.value.key);
    if (keys.has(key)) throw new TypeError("Worker configuration cache has inconsistent current application results.");
    if (!authority.pendingApplication && (desired === null || BigInt(item.value.targetRevision) > BigInt(desired.revision) || (item.value.key.kind === "projectPreparation" || item.value.key.kind === "projectNative") && !selected.has(item.value.key.projectId)
      || item.value.key.kind === "enableSudoCleanup" && desired.value.enableSudoCleanup === undefined || item.value.key.kind === "taskTagFilter" && desired.value.taskTagFilter === undefined)) throw new TypeError("Worker configuration cache has inconsistent current application results.");
    keys.set(key, item);
  }
  if (!authority.pendingApplication && desired !== null && requiredKeys(desired).some(key => keys.get(keyOf(key))?.value.targetRevision !== applicationRevision)) throw new TypeError("Worker configuration cache is missing target application results.");
  references([...currentItems, ...retainedItems], nextFailureId);
  let remoteObservation: WorkerConfigurationCache["remoteObservation"] = null;
  if (data.remoteObservation !== null) {
    const remote = exact(data.remoteObservation, ["observationRevision", "json"]), revision = parseWorkerCloudRevision(remote.observationRevision);
    if (typeof remote.json !== "string") throw new TypeError("Worker configuration cache has an invalid remote observation.");
    // A saved remote snapshot can predate our understanding of its opaque
    // members. It never supplies the local ledger's application proof.
    validateWorkerRemoteObservation(remote.json, revision);
    remoteObservation = { observationRevision: revision, json: remote.json };
  }
  let hiddenCapabilitySources: WorkerConfigurationCache["hiddenCapabilitySources"];
  if (Object.hasOwn(data, "hiddenCapabilitySources")) {
    if (received === null || typeof data.hiddenCapabilitySources !== "object" || data.hiddenCapabilitySources === null || Array.isArray(data.hiddenCapabilitySources)) throw new TypeError("Worker configuration cache has invalid hidden capability sources.");
    const sources = data.hiddenCapabilitySources as Record<string, unknown>;
    if (Object.keys(sources).length === 0 || Object.keys(sources).some(key => !workerCapabilityKeys.includes(key as typeof workerCapabilityKeys[number]))) throw new TypeError("Worker configuration cache has invalid hidden capability sources.");
    const parsed: NonNullable<WorkerConfigurationCache["hiddenCapabilitySources"]> = {};
    for (const key of workerCapabilityKeys) {
      if (!Object.hasOwn(sources, key)) continue;
      const source = exact(sources[key], ["revision", "json"]), revision = parseWorkerCloudRevision(source.revision);
      if (typeof source.json !== "string" || BigInt(revision) > BigInt(received.revision)) throw new TypeError("Worker configuration cache has an invalid hidden capability source.");
      validateHiddenCapabilitySource(desiredJson!, key, source.json, true);
      Object.assign(parsed, { [key]: { revision, json: source.json } });
    }
    hiddenCapabilitySources = parsed;
  }
  return { schemaVersion: 11, identity: { ...identity }, authority: { generation: uuid(authority.generation), desiredJson, applicationRevision, observationRevision, pendingApplication: authority.pendingApplication },
    remoteObservation, nextFailureId, projectionCursor: data.projectionCursor === null ? null : uuid(data.projectionCursor), currentItems, retainedItems,
    ...(hiddenCapabilitySources === undefined ? {} : { hiddenCapabilitySources }) };
};
