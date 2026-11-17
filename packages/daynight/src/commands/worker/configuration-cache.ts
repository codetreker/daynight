import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { configurationJsonChunks, parseConfigurationJson } from "./configuration-json.js";
import { freezeConfiguration } from "./configuration-model.js";
import type { WorkerConfigurationCache, WorkerConfigurationIdentity } from "./configuration-model.js";
import { decodeConfigurationCache } from "./configuration-storage-decoder.js";
import { transitionConfigurationDesired } from "./configuration-state.js";

type CacheRead = { readonly cache: WorkerConfigurationCache; readonly migrated: boolean };

export const createConfigurationCache = (identity: WorkerConfigurationIdentity): WorkerConfigurationCache => freezeConfiguration({
  schemaVersion: 9, identity: { ...identity }, authority: { generation: randomUUID(), desiredJson: null, applicationRevision: null, observationRevision: "0" }, remoteObservation: null,
  nextFailureId: 1, projectionCursor: null, currentItems: [], retainedItems: [],
});
export const parseConfigurationCache = (source: unknown, identity: WorkerConfigurationIdentity): CacheRead => {
  const decoded = decodeConfigurationCache(source, identity);
  const convertItems = (items: typeof decoded.cache.currentItems) => items.flatMap(item => {
    if (item.value.key.kind === "agentControlMode") return [];
    const { nativeMode, ...rest } = item;
    if (decoded.migrated && (item.value.key.kind === "native" || item.value.key.kind === "projectNative") && nativeMode !== "web") {
      return [{ ...rest, value: { ...item.value, appliedValue: null, state: "pending" as const, error: null, lastFailure: null, nextAttemptAt: null }, backoffStep: 0, failureId: null, actualSource: null }];
    }
    return [rest];
  });
  let cache: WorkerConfigurationCache = {
    ...decoded.cache, schemaVersion: 9,
    authority: decoded.migrated ? { ...decoded.cache.authority, generation: randomUUID() } : decoded.cache.authority,
    projectionCursor: decoded.migrated ? null : decoded.cache.projectionCursor,
    currentItems: convertItems(decoded.cache.currentItems), retainedItems: convertItems(decoded.cache.retainedItems),
  };
  if (decoded.migration !== null && decoded.migration.received.known.value.agentControlMode === "web") {
    const { received, previousDesired } = decoded.migration;
    cache = transitionConfigurationDesired(cache, received, new Set(), randomUUID, previousDesired, true);
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
