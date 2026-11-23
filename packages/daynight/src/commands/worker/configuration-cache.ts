import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { configurationJsonChunks, parseConfigurationJson } from "./configuration-json.js";
import { applicableConfigurationDesired, configurationDesired, freezeConfiguration } from "./configuration-model.js";
import type { WorkerConfigurationCache, WorkerConfigurationIdentity } from "./configuration-model.js";
import { decodeConfigurationCache } from "./configuration-storage-decoder.js";
import { transitionConfigurationDesired } from "./configuration-state.js";

type CacheRead = { readonly cache: WorkerConfigurationCache; readonly migrated: boolean };

export const createConfigurationCache = (identity: WorkerConfigurationIdentity): WorkerConfigurationCache => freezeConfiguration({
  schemaVersion: 13, identity: { ...identity }, authority: { generation: randomUUID(), desiredJson: null, applicationRevision: null, observationRevision: "0", pendingApplication: true }, remoteObservation: null,
  nextFailureId: 1, projectionCursor: null, currentItems: [], retainedItems: [],
});
export const parseConfigurationCache = (source: unknown, identity: WorkerConfigurationIdentity): CacheRead => {
  const decoded = decodeConfigurationCache(source, identity);
  const convertItems = (items: typeof decoded.cache.currentItems) => items.flatMap(item => {
    if (decoded.cache.schemaVersion !== 10 && decoded.cache.schemaVersion !== 13 && item.value.key.kind === "agentControlMode") return [];
    const { nativeMode, ...rest } = item as typeof item & { readonly nativeMode?: "herdr" | "web" | null };
    if (decoded.cache.schemaVersion !== 9 && decoded.cache.schemaVersion !== 10 && decoded.cache.schemaVersion !== 13 && (item.value.key.kind === "native" || item.value.key.kind === "projectNative") && nativeMode !== "web") {
      return [{ ...rest, value: { ...item.value, appliedValue: null, state: "pending" as const, error: null, lastFailure: null, nextAttemptAt: null }, backoffStep: 0, failureId: null, actualSource: null }];
    }
    return [rest];
  });
  let cache: WorkerConfigurationCache = {
    ...decoded.cache, schemaVersion: 13,
    authority: decoded.migrated ? { ...decoded.cache.authority, generation: randomUUID() } : decoded.cache.authority,
    projectionCursor: decoded.migrated ? null : decoded.cache.projectionCursor,
    currentItems: convertItems(decoded.cache.currentItems), retainedItems: convertItems(decoded.cache.retainedItems),
  };
  // Historical authorities may be structurally valid but unsupported by the
  // current network contract. Keep their ledger and raw source without marking
  // them as an applied current target in the new checkpoint.
  if (decoded.migrated && cache.authority.desiredJson !== null && applicableConfigurationDesired(configurationDesired(cache)) === null) {
    cache = { ...cache, authority: { ...cache.authority, pendingApplication: true } };
  }
  if (decoded.migration !== null && decoded.migration.received.known.value.agentControlMode === "web") {
    const { received, previousDesired } = decoded.migration;
    cache = transitionConfigurationDesired(cache, received, new Set(), randomUUID, previousDesired, true);
  }
  // Schema 12 reports itself for both the version it decodes and the one before
  // it, so these obligations stay with the genuinely older envelopes that never
  // understood the member in question.
  if (decoded.migrated && decoded.cache.schemaVersion !== 10 && decoded.cache.schemaVersion !== 13 && !cache.authority.pendingApplication && applicableConfigurationDesired(configurationDesired(cache)) !== null
    && !cache.currentItems.some(item => item.value.key.kind === "agentControlMode")) {
    // Historical mode confirmations do not prove adoption by this Web-only process.
    // Preserve the old ledger and its target revision while adding a fresh obligation.
    const targetRevision = cache.authority.applicationRevision!;
    cache = { ...cache, currentItems: [...cache.currentItems, {
      recordId: randomUUID(), origin: { generation: cache.authority.generation, targetRevision, source: "application" },
      value: { key: { kind: "agentControlMode" }, targetRevision, appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null },
      backoffStep: 0, failureId: null, started: false, actualSource: null, blockedByRemovalId: null,
    }] };
  }
  const desired = applicableConfigurationDesired(configurationDesired(cache));
  if (decoded.migrated && decoded.cache.schemaVersion !== 13 && !cache.authority.pendingApplication && desired?.value.taskTagFilter !== undefined) {
    // Older checkpoints retained this member as opaque authority. A fresh
    // obligation records that no application of its newly understood value occurred.
    const targetRevision = cache.authority.applicationRevision!;
    cache = { ...cache, currentItems: [...cache.currentItems, {
      recordId: randomUUID(), origin: { generation: cache.authority.generation, targetRevision, source: "application" },
      value: { key: { kind: "taskTagFilter" }, targetRevision, appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null },
      backoffStep: 0, failureId: null, started: false, actualSource: null, blockedByRemovalId: null,
    }] };
  }
  if (decoded.migrated && !cache.authority.pendingApplication && desired?.value.enableWindowsProcessCleanup !== undefined
    && !cache.currentItems.some(item => item.value.key.kind === "enableWindowsProcessCleanup")) {
    // The previous checkpoint carried this member as opaque authority, so no
    // application of its now understood value is recorded. Only the envelopes
    // that kept it opaque reach here: an older one never adopts the member at
    // all, which leaves the target undefined and this obligation unneeded.
    const targetRevision = cache.authority.applicationRevision!;
    cache = { ...cache, currentItems: [...cache.currentItems, {
      recordId: randomUUID(), origin: { generation: cache.authority.generation, targetRevision, source: "application" },
      value: { key: { kind: "enableWindowsProcessCleanup" }, targetRevision, appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null },
      backoffStep: 0, failureId: null, started: false, actualSource: null, blockedByRemovalId: null,
    }] };
  }
  return { cache: freezeConfiguration(cache), migrated: decoded.migrated };
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
