import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { configurationJsonChunks, parseConfigurationJson } from "./configuration-json.js";
import { freezeConfiguration } from "./configuration-model.js";
import type { WorkerConfigurationCache, WorkerConfigurationIdentity } from "./configuration-model.js";
import { decodeConfigurationCache } from "./configuration-storage-decoder.js";
import { transitionConfigurationDesired } from "./configuration-state.js";

type CacheRead = { readonly cache: WorkerConfigurationCache; readonly migrated: boolean };

export const createConfigurationCache = (identity: WorkerConfigurationIdentity): WorkerConfigurationCache => freezeConfiguration({
  schemaVersion: 8, identity: { ...identity }, authority: { generation: randomUUID(), desiredJson: null, applicationRevision: null, observationRevision: "0" }, remoteObservation: null,
  nextFailureId: 1, projectionCursor: null, currentItems: [], retainedItems: [],
});
export const parseConfigurationCache = (source: unknown, identity: WorkerConfigurationIdentity): CacheRead => {
  const decoded = decodeConfigurationCache(source, identity);
  let cache: WorkerConfigurationCache = decoded.cache;
  if (decoded.migration !== null) {
    const { received, previousDesired } = decoded.migration;
    const native = cache.currentItems.find(item => item.value.key.kind === "native");
    const localMode = received.known.value.agentControlMode ?? native?.nativeMode ?? "herdr";
    cache = transitionConfigurationDesired(cache, received, localMode, new Set(), randomUUID, previousDesired, true);
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
