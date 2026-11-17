import { randomUUID } from "node:crypto";
import { stringifyApiJson } from "../../api/json.js";
import { type ReceivedWorkerDesired, parseWorkerCloudItem, parseWorkerCloudValue } from "../../api/worker-configuration.js";
import { configurationJsonSourcesEqual } from "../../api/worker-configuration-source.js";
import { ProtocolError } from "../../api/validation.js";
import { prepareWorkerReport, WORKER_CONFIGURATION_REPORT_BYTES } from "../../api/worker-report.js";
import { parseToolPathsBootstrap } from "../../api/worker-tool-paths.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudItemKey, WorkerCloudNative, WorkerCloudProject, WorkerCloudReport } from "../../api/worker-configuration.js";
import type { ToolPaths } from "../../platform/tool-path-choice.js";
import { configurationDesired, configurationActiveDesired, configurationKey, freezeConfiguration, sameConfigurationValue } from "./configuration-model.js";
import type { ConfigurationProjection, ConfigurationProjectionOptions, TrackedConfigurationItem, WorkerConfigurationCache, WorkerConfigurationSnapshot, WorkerConfigurationToolTargets, WorkerNativeProof } from "./configuration-model.js";

export const allConfigurationItems = (cache: WorkerConfigurationCache): readonly TrackedConfigurationItem[] => [...cache.currentItems, ...cache.retainedItems];
export const configurationInheritanceSources = (cache: WorkerConfigurationCache): ReadonlyMap<string, TrackedConfigurationItem> => {
  const sources = new Map<string, TrackedConfigurationItem>();
  for (const item of cache.retainedItems) if (item.value.appliedValue !== null) sources.set(configurationKey(item.value.key), item);
  for (const item of cache.currentItems) sources.set(configurationKey(item.value.key), item);
  return sources;
};
export const findCurrentConfigurationItem = (cache: WorkerConfigurationCache, key: WorkerCloudItemKey): TrackedConfigurationItem | undefined => cache.currentItems.find(item => configurationKey(item.value.key) === configurationKey(key));
export const findConfigurationRecord = (cache: WorkerConfigurationCache, recordId: string): TrackedConfigurationItem | undefined => cache.currentItems.find(item => item.recordId === recordId) ?? cache.retainedItems.find(item => item.recordId === recordId);
export const replaceConfigurationRecord = (cache: WorkerConfigurationCache, item: TrackedConfigurationItem): WorkerConfigurationCache => {
  const current = cache.currentItems.findIndex(record => record.recordId === item.recordId);
  if (current !== -1) return cache.currentItems[current] === item ? cache : { ...cache, currentItems: cache.currentItems.with(current, item) };
  const retained = cache.retainedItems.findIndex(record => record.recordId === item.recordId);
  return retained === -1 || cache.retainedItems[retained] === item ? cache : { ...cache, retainedItems: cache.retainedItems.with(retained, item) };
};
export const configurationHasUnfinishedRemoval = (cache: WorkerConfigurationCache, projectId: string): boolean => cache.currentItems.some(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === projectId && item.value.state !== "applied") || cache.retainedItems.some(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === projectId && item.started && item.value.state !== "applied");

// A failed target validation is not an empty project selection.
export const configurationProjects = (cache: WorkerConfigurationCache): { readonly selected: ReadonlySet<string> | null; readonly history: ReadonlySet<string> } => {
  const active = configurationActiveDesired(cache);
  const selected = active === null && configurationDesired(cache) !== null ? null : new Set(active?.value.projects.map(project => project.projectId) ?? []);
  const facts = cache.currentItems.length === 0 && configurationDesired(cache) === null ? cache.retainedItems : cache.currentItems;
  const history = new Set(facts.flatMap(item => item.value.key.kind === "projectPreparation" || item.value.key.kind === "projectNative" ? [item.value.key.projectId] : []));
  return { selected, history };
};

export const configurationToolTargets = (cache: WorkerConfigurationCache, local: ToolPaths): WorkerConfigurationToolTargets | null => {
  const raw = configurationDesired(cache), desired = configurationActiveDesired(cache), choices = desired?.value.toolPaths;
  if (raw !== null && desired === null) return null;
  if (choices === undefined) return { source: "local", revision: null, choices: local };
  if (choices.codex === null || choices.copilot === null) return null;
  return { source: "cloud", revision: cache.authority.applicationRevision, choices: { codex: choices.codex, copilot: choices.copilot } };
};
export const resolveWorkerCloudProjectNative = (native: WorkerCloudNative, project: WorkerCloudProject): WorkerCloudNative => {
  const overrides = project.nativeOverrides, agent = overrides.agent === undefined ? native.agent : overrides.agent;
  return { agent, model: Object.hasOwn(overrides, "model") ? overrides.model! : agent === native.agent ? native.model : null,
    args: Object.hasOwn(overrides, "args") ? [...overrides.args!] : agent === native.agent ? [...native.args] : [] };
};
export const configurationTarget = (cache: WorkerConfigurationCache, key: WorkerCloudItemKey): WorkerCloudItem["appliedValue"] => {
  if (key.kind === "projectRemoval") return true;
  const desired = configurationActiveDesired(cache);
  if (desired === null) return null;
  if (key.kind === "maxConcurrent" || key.kind === "pollIntervalMs" || key.kind === "recoveryLimit" || key.kind === "preferPlatformSpecificTasks" || key.kind === "native") return desired.value[key.kind];
  if (!("projectId" in key)) throw new TypeError("Worker configuration project key is invalid.");
  const projectId = key.projectId;
  const project = desired.value.projects.find(project => project.projectId === projectId);
  if (project === undefined) return null;
  return key.kind === "projectPreparation" ? true : resolveWorkerCloudProjectNative(desired.value.native, project);
};

const isRemoval = (item: TrackedConfigurationItem): boolean => item.value.key.kind === "projectRemoval";
const pendingRemoval = (item: TrackedConfigurationItem): boolean => isRemoval(item) && item.value.state !== "applied";
const projectOf = (item: TrackedConfigurationItem): string | null => "projectId" in item.value.key ? item.value.key.projectId : null;
const compareRecordIds = (first: TrackedConfigurationItem, second: TrackedConfigurationItem): number => first.recordId < second.recordId ? -1 : first.recordId > second.recordId ? 1 : 0;
const unfinishedRemovalProjects = (cache: WorkerConfigurationCache): ReadonlySet<string> => new Set([
  ...cache.currentItems.filter(pendingRemoval), ...cache.retainedItems.filter(item => item.started && pendingRemoval(item)),
].map(item => projectOf(item)!));

export const pruneConfigurationRetained = (cache: WorkerConfigurationCache, runningRecordIds: ReadonlySet<string>): WorkerConfigurationCache => {
  if (configurationDesired(cache) !== null && configurationActiveDesired(cache) === null) return cache;
  const records = new Map(allConfigurationItems(cache).map(item => [item.recordId, item]));
  const cleared = (item: TrackedConfigurationItem): TrackedConfigurationItem => {
    const blocker = item.blockedByRemovalId === null ? undefined : records.get(item.blockedByRemovalId);
    return blocker?.value.state === "applied" && !runningRecordIds.has(blocker.recordId) && (!isRemoval(item) || item.value.state === "applied") ? { ...item, blockedByRemovalId: null } : item;
  };
  const currentItems = cache.currentItems.map(cleared), existingRetained = cache.retainedItems.map(cleared);
  if (currentItems.some((item, index) => item !== cache.currentItems[index]) || existingRetained.some((item, index) => item !== cache.retainedItems[index])) cache = { ...cache, currentItems, retainedItems: existingRetained };
  const referenced = new Set([...currentItems, ...existingRetained].flatMap(item => item.blockedByRemovalId === null ? [] : [item.blockedByRemovalId]));
  const removalProjects = new Set(currentItems.filter(isRemoval).map(projectOf));
  const retainedItems = cache.retainedItems.filter(item => {
    if (runningRecordIds.has(item.recordId) || item.started && item.value.state !== "applied" || item.value.state === "applying" || item.failureId !== null || referenced.has(item.recordId)) return true;
    const projectId = projectOf(item);
    if (isRemoval(item)) return item.value.appliedValue !== null && removalProjects.has(projectId);
    if (item.value.appliedValue === null) return false;
    if (configurationDesired(cache) === null) return true;
    return projectId !== null && removalProjects.has(projectId);
  });
  return retainedItems.length === cache.retainedItems.length ? cache : { ...cache, retainedItems };
};

export const transitionConfigurationDesired = (
  cache: WorkerConfigurationCache, received: ReceivedWorkerDesired | null,
  runningRecordIds: ReadonlySet<string>, newId: () => string,
): WorkerConfigurationCache => {
  const previousDesired = configurationDesired(cache), desired = received?.known ?? null;
  if (previousDesired !== null && desired !== null && desired.revision === previousDesired.revision) {
    if (!configurationJsonSourcesEqual(cache.authority.desiredJson!, received!.json)) throw new ProtocolError();
    return cache.authority.desiredJson === received!.json ? cache : { ...cache, authority: { ...cache.authority, desiredJson: received!.json } };
  }
  if (cache.authority.desiredJson === (received?.json ?? null)) return cache;
  const generation = newId();
  const active = desired === null ? null : (() => { try { return parseWorkerCloudValue(desired.value); } catch (error) { if (!(error instanceof ProtocolError)) throw error; return null; } })();
  const priorProjects = configurationProjects(cache);
  const previousSelected = priorProjects.selected ?? new Set<string>();
  const { hiddenCapabilitySources: _hidden, ...rest } = cache;
  const next = { ...rest, authority: { ...cache.authority, generation, desiredJson: received?.json ?? null, applicationRevision: active === null ? cache.authority.applicationRevision : desired!.revision }, projectionCursor: null };
  // Unsupported raw targets must be saved and invalidate projections without
  // inventing a selection or discarding outstanding application facts.
  if (desired !== null && active === null) return next;
  const transitioned = { ...next, authority: { ...next.authority, applicationRevision: desired?.revision ?? null }, currentItems: [], retainedItems: [...cache.retainedItems, ...cache.currentItems] };
  if (desired === null) return pruneConfigurationRetained(transitioned, runningRecordIds);
  const selected = new Set(active!.projects.map(project => project.projectId));
  const removals = new Set([...previousSelected, ...priorProjects.history].filter(projectId => !selected.has(projectId)));
  const previousItems = allConfigurationItems(cache);
  const inherited = configurationInheritanceSources(cache);
  const blockers = new Map<string, TrackedConfigurationItem>();
  for (const item of previousItems) if (item.value.key.kind === "projectRemoval") {
    const projectId = item.value.key.projectId;
    if (!selected.has(projectId) || item.started || runningRecordIds.has(item.recordId)) removals.add(projectId);
    if ((item.started || runningRecordIds.has(item.recordId)) && !blockers.has(projectId)) blockers.set(projectId, item);
  }
  const currentItems: TrackedConfigurationItem[] = [];
  const add = (key: WorkerCloudItemKey, reset = false): void => {
    const previous = inherited.get(configurationKey(key));
    const appliedValue = reset ? null : previous?.value.appliedValue ?? null;
    const unchanged = key.kind !== "projectRemoval" && previous?.value.state === "applied" && appliedValue !== null && sameConfigurationValue(appliedValue, configurationTarget(transitioned, key)) && (key.kind !== "projectNative" || previousDesired === null || previousSelected.has(key.projectId));
    const blocker = "projectId" in key ? blockers.get(key.projectId) : undefined;
    currentItems.push({ recordId: newId(), origin: { generation, targetRevision: desired.revision, source: "application" },
      value: { key, targetRevision: desired.revision, appliedValue, state: unchanged ? "applied" : "pending", error: null, lastFailure: null, nextAttemptAt: null },
      backoffStep: 0, failureId: null, started: false,
      actualSource: reset ? null : previous?.actualSource ?? null, blockedByRemovalId: blocker?.recordId ?? null });
  };
  for (const kind of ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native"] as const) add({ kind });
  for (const project of active!.projects) {
    add({ kind: "projectPreparation", projectId: project.projectId }, !previousSelected.has(project.projectId));
    add({ kind: "projectNative", projectId: project.projectId });
  }
  for (const projectId of removals) add({ kind: "projectRemoval", projectId });
  return pruneConfigurationRetained({ ...transitioned, currentItems }, runningRecordIds);
};

const latestFailures = (cache: WorkerConfigurationCache): ReadonlyMap<string, TrackedConfigurationItem> => {
  const result = new Map<string, TrackedConfigurationItem>();
  for (const item of allConfigurationItems(cache)) {
    if (item.failureId === null || item.value.lastFailure === null) continue;
    const key = configurationKey(item.value.key), previous = result.get(key);
    const time = Date.parse(item.value.lastFailure.occurredAt), previousTime = previous === undefined ? undefined : Date.parse(previous.value.lastFailure!.occurredAt);
    const newer = previous === undefined || time > previousTime! || time === previousTime && (item.failureId > previous.failureId! || item.failureId === previous.failureId && item.recordId < previous.recordId);
    if (newer) result.set(key, item);
  }
  return result;
};
const publicItem = (item: TrackedConfigurationItem, failures: ReadonlyMap<string, TrackedConfigurationItem>): WorkerCloudItem => ({ ...item.value, lastFailure: failures.get(configurationKey(item.value.key))?.value.lastFailure ?? null });

export const configurationSnapshot = (
  cache: WorkerConfigurationCache, synchronized: boolean, validatedNative: ReadonlyMap<string, WorkerNativeProof>,
  localTools: ToolPaths, proofFor: (cache: WorkerConfigurationCache, native: WorkerCloudNative) => WorkerNativeProof,
): WorkerConfigurationSnapshot => {
  const desired = configurationDesired(cache);
  const failures = latestFailures(cache);
  const retainedRecoveryLimit = configurationInheritanceSources(cache).get(configurationKey({ kind: "recoveryLimit" }))?.value.appliedValue;
  const current = new Map(cache.currentItems.map(item => [configurationKey(item.value.key), item]));
  const unfinishedRemovals = unfinishedRemovalProjects(cache);
  const applied = (key: WorkerCloudItemKey) => current.get(configurationKey(key))?.value.appliedValue ?? null;
  const scalar = (kind: "maxConcurrent" | "pollIntervalMs" | "recoveryLimit"): number | null => {
    const value = applied({ kind });
    return synchronized && desired !== null && typeof value === "number" ? value : null;
  };
  const native = (key: WorkerCloudItemKey): WorkerCloudNative | null => {
    const item = current.get(configurationKey(key)), value = item?.value.appliedValue;
    return synchronized && desired !== null && typeof value === "object" && value !== null && item !== undefined && sameConfigurationValue(proofFor(cache, value), validatedNative.get(item.recordId)) ? value : null;
  };
  const preference = applied({ kind: "preferPlatformSpecificTasks" });
  const active = configurationActiveDesired(cache);
  const projects = synchronized && active !== null ? active.value.projects.map(project => ({ projectId: project.projectId, native: native({ kind: "projectNative", projectId: project.projectId }),
    ready: current.get(configurationKey({ kind: "projectPreparation", projectId: project.projectId }))?.value.state === "applied" && applied({ kind: "projectPreparation", projectId: project.projectId }) === true && !unfinishedRemovals.has(project.projectId) })) : [];
  const globalNative = native({ kind: "native" });
  return freezeConfiguration({ generation: cache.authority.generation, synchronized, desired, validatedDesired: active, applicationRevision: cache.authority.applicationRevision, observationRevision: cache.authority.observationRevision, retainedRecoveryLimit: typeof retainedRecoveryLimit === "number" ? retainedRecoveryLimit : null,
    projects: { selected: configurationProjects(cache).selected === null ? null : [...configurationProjects(cache).selected!], tracked: [...configurationProjects(cache).history] },
    items: cache.currentItems.map(item => publicItem(item, failures)), toolTargets: configurationToolTargets(cache, localTools), effective: {
      maxConcurrent: scalar("maxConcurrent"), pollIntervalMs: scalar("pollIntervalMs"), recoveryLimit: scalar("recoveryLimit"), preferPlatformSpecificTasks: synchronized && desired !== null && typeof preference === "boolean" ? preference : null,
      native: globalNative, projects,
    } });
};

// Stored observation strings use Go's default HTML and line-separator escaping.
const storageBytes = (text: string): number => {
  let bytes = Buffer.byteLength(text, "utf8");
  for (const character of text) {
    if (character === "<" || character === ">" || character === "&") bytes += 5;
    else if (character === "\u2028" || character === "\u2029") bytes += 3;
  }
  return bytes;
};
const removalSeverity = (item: TrackedConfigurationItem): number => item.value.state === "error" ? 3 : item.value.state === "applying" ? 2 : 1;

export const projectConfigurationReport = (cache: WorkerConfigurationCache, options: ConfigurationProjectionOptions): ConfigurationProjection => {
  const desired = configurationDesired(cache);
  const bootstrap = desired === null && options.bootstrap !== null ? parseWorkerCloudValue(options.bootstrap) : null;
  const base: WorkerCloudReport = {
    toolPathsBootstrap: desired !== null && !options.synchronized ? null : bootstrap !== null ? parseToolPathsBootstrap(bootstrap.toolPaths) : options.localTools,
    bootstrap,
    observation: options.synchronized && desired !== null ? { baseRevision: cache.authority.observationRevision, desiredRevision: desired.revision, items: [] } : null,
  };
  const envelope = options.telemetry === undefined ? { configuration: base } : prepareWorkerReport({ ...options.telemetry, configuration: base }, WORKER_CONFIGURATION_REPORT_BYTES).value;
  let requestBytes = Buffer.byteLength(stringifyApiJson(envelope), "utf8");
  if (requestBytes > WORKER_CONFIGURATION_REPORT_BYTES) throw new RangeError("Worker configuration report required content exceeds its request budget.");
  if (base.observation === null) return freezeConfiguration({ reportId: randomUUID(), report: base, generation: cache.authority.generation, baseRevision: cache.authority.observationRevision, recordIds: [], failures: [], nextCursor: cache.projectionCursor });
  const pendingFailures = latestFailures(cache);
  const candidates = cache.currentItems.flatMap(item => {
    const value = publicItem(item, pendingFailures);
    parseWorkerCloudItem(value, false);
    try { parseWorkerCloudItem(value); }
    catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      // Structural history remains local until its carrier has a wire-representable actual value.
      return [];
    }
    return [{ item, value, encoded: stringifyApiJson(value) }];
  }).sort((first, second) => compareRecordIds(first.item, second.item));
  const currentIds = new Set(cache.currentItems.map(item => item.recordId));
  const removalPriorities = new Map<string, number>();
  for (const item of allConfigurationItems(cache)) {
    if (!pendingRemoval(item) || !item.started && !currentIds.has(item.recordId)) continue;
    const projectId = projectOf(item)!;
    removalPriorities.set(projectId, Math.max(removalPriorities.get(projectId) ?? 0, removalSeverity(item)));
  }
  const priority = (item: TrackedConfigurationItem): number => removalPriorities.get(projectOf(item)!)!;
  const fixed = candidates.filter(candidate => pendingRemoval(candidate.item)).sort((first, second) => priority(second.item) - priority(first.item) || compareRecordIds(first.item, second.item))[0];
  const rotating = candidates.filter(candidate => candidate !== fixed);
  const after = cache.projectionCursor === null ? 0 : rotating.findIndex(candidate => candidate.item.recordId > cache.projectionCursor!);
  const start = after < 0 ? 0 : after;
  const ordered = [...rotating.slice(start), ...rotating.slice(0, start)];
  const selected: typeof candidates = [];
  // Reserve space for the server timestamp in the stored observation.
  // https://github.com/codetreker/daynight/blob/edafb9f21291438ac348b3140b63b087bfa20f6a/packages/daynight-server/internal/protocol/worker/configuration_observation.go#L26
  let observationBytes = storageBytes(stringifyApiJson(base.observation)) + 512, nonModeCount = 0;
  let nextCursor = cache.projectionCursor;
  const add = (candidate: typeof candidates[number]): boolean => {
    const comma = selected.length === 0 ? 0 : 1;
    const nextNonMode = nonModeCount + 1;
    const nextObservationBytes = observationBytes + storageBytes(candidate.encoded) + comma;
    let nextRequestBytes = requestBytes + Buffer.byteLength(candidate.encoded, "utf8") + comma;
    if (selected.length >= 1025 || nextNonMode > 1025 || nextObservationBytes > 4 * 1_048_576) return false;
    if (nextRequestBytes > WORKER_CONFIGURATION_REPORT_BYTES && options.telemetry !== undefined) {
      const trial = { ...base, observation: { ...base.observation!, items: [...selected.map(current => current.value), candidate.value] } };
      nextRequestBytes = Buffer.byteLength(stringifyApiJson(prepareWorkerReport({ ...options.telemetry, configuration: trial }, WORKER_CONFIGURATION_REPORT_BYTES).value), "utf8");
    }
    if (nextRequestBytes > WORKER_CONFIGURATION_REPORT_BYTES) return false;
    selected.push(candidate); nonModeCount = nextNonMode; observationBytes = nextObservationBytes; requestBytes = nextRequestBytes;
    return true;
  };
  if (fixed !== undefined && !add(fixed)) throw new RangeError("Worker configuration removal cannot fit in its observation budget.");
  for (const candidate of ordered) {
    if (!add(candidate)) break;
    nextCursor = candidate.item.recordId;
  }
  const report: WorkerCloudReport = { ...base, observation: { ...base.observation, items: selected.map(candidate => candidate.value) } };
  if (options.telemetry !== undefined && Buffer.byteLength(stringifyApiJson(prepareWorkerReport({ ...options.telemetry, configuration: report }, WORKER_CONFIGURATION_REPORT_BYTES).value), "utf8") > WORKER_CONFIGURATION_REPORT_BYTES) throw new RangeError("Worker configuration report exceeds its request budget.");
  const failures = selected.flatMap(candidate => {
    const source = pendingFailures.get(configurationKey(candidate.item.value.key));
    return source === undefined ? [] : [{ sourceRecordId: source.recordId, failureId: source.failureId! }];
  });
  return freezeConfiguration({ reportId: randomUUID(), report, generation: cache.authority.generation, baseRevision: base.observation.baseRevision, recordIds: selected.map(candidate => candidate.item.recordId), failures, nextCursor });
};

export const acceptConfigurationProjection = (cache: WorkerConfigurationCache, projection: ConfigurationProjection, runningRecordIds: ReadonlySet<string>, options: { readonly prune?: boolean } = {}): WorkerConfigurationCache => {
  if (projection.generation !== cache.authority.generation || configurationProjects(cache).selected === null) return cache;
  if (projection.report.observation === null) throw new TypeError("Worker configuration projection has no observation to accept.");
  const acknowledged = new Map(projection.failures.map(token => [token.sourceRecordId, token.failureId]));
  const clear = (item: TrackedConfigurationItem): TrackedConfigurationItem => item.failureId !== null && acknowledged.get(item.recordId) === item.failureId ? { ...item, failureId: null, value: { ...item.value, lastFailure: null } } : item;
  let next: WorkerConfigurationCache = { ...cache, projectionCursor: projection.generation === cache.authority.generation ? projection.nextCursor : cache.projectionCursor,
    currentItems: cache.currentItems.map(clear), retainedItems: cache.retainedItems.map(clear) };
  const sent = new Map(projection.recordIds.map((recordId, index) => [recordId, projection.report.observation?.items[index]]));
  const selected = configurationProjects(next).selected;
  const unfinishedRemovals = unfinishedRemovalProjects(next);
  const failedProjects = new Set(allConfigurationItems(next).filter(item => item.failureId !== null).map(projectOf));
  const completed = new Set(next.currentItems.filter(item => {
    const captured = sent.get(item.recordId), projectId = projectOf(item);
    if (!isRemoval(item) || captured?.state !== "applied" || captured.targetRevision !== item.value.targetRevision || item.value.state !== "applied" || item.failureId !== null || runningRecordIds.has(item.recordId) || projectId === null || unfinishedRemovals.has(projectId)) return false;
    return selected?.has(projectId) === true || !failedProjects.has(projectId);
  }).map(item => item.recordId));
  if (completed.size !== 0) next = { ...next, currentItems: next.currentItems.filter(item => !completed.has(item.recordId)) };
  return options.prune === false ? next : pruneConfigurationRetained(next, runningRecordIds);
};
