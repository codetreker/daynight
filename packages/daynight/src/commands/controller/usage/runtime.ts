import type { UsageStore, UsageState } from "./types.js";
import { createUsageUploader, type UsageUploaderOptions } from "./uploader.js";
import { mapCopilotUsageEvent } from "../providers/copilot-usage.js";

/** Metering failures stay outside the native command and timeline failure paths. */
export const createUsageRuntime = (options: UsageUploaderOptions & { generation: string }) => {
  const uploader = createUsageUploader(options), store: UsageStore = options.store;
  let current: UsageState | null = null, warned = false, closed = false;
  const pendingReasons = new Set<string>(["native_recovery_gap", "input_cache_semantics_unknown"]);
  const reported = new Map<string, string>();
  const diagnose = () => options.onDiagnostic?.("Usage collection is incomplete; the native task continues.");
  const safe = (action: () => void) => { try { action(); } catch (error) { diagnose(); const reason = error instanceof Error && ["native_integer_unrepresentable", "collector_failed"].includes(error.message) ? error.message : "local_storage_failed"; pendingReasons.add(reason); try { if (current) store.gap(current.stateId, reason); } catch { /* A failed disk cannot acknowledge an event. */ } };
  const ready = (input: { nativeSessionId: string; providerVersion: string }) => safe(() => {
    if (current?.nativeSessionId !== input.nativeSessionId || current.providerVersion !== input.providerVersion) current = store.ensureState(options.generation, input.nativeSessionId, input.providerVersion);
    for (const reason of pendingReasons) store.gap(current.stateId, reason);
  });
  const gap = (reason: string) => safe(() => { pendingReasons.add(reason); if (current) store.gap(current.stateId, reason); });
  const state = (seal: boolean) => safe(() => {
    if (!current) return;
    current = store.getState(current.stateId);
    const capability = uploader.capability(current);
    if (!capability) return;
    const verified = uploader.qualified(current), reasons = [...new Set([...current.reasons, ...pendingReasons, ...(verified ? [] : ["profile_unverified"])])].sort();
    const key = JSON.stringify([capability, reasons, seal]);
    if (reported.get(current.stateId) === key) return;
    store.enqueueState(current.stateId, { collectionState: seal ? verified ? "partial" : "unavailable" : verified ? "collecting" : "unavailable", capability, reasonCodes: reasons, nativeStartedAt: null, nativeEndedAt: seal ? new Date().toISOString() : null, observedAt: new Date().toISOString(), seal });
    reported.set(current.stateId, key);
  });
  const tick = async () => { if (closed) return; try { await uploader.tick(); if (!closed) state(false); } catch { diagnose(); } };
  const timer = setInterval(() => { void tick(); }, 1000); timer.unref();
  return {
    ready, gap,
    observe(input: { nativeSessionId: string; providerVersion: string; event: unknown }) {
      if (closed) return;
      safe(() => {
        ready(input);
        if (!current || current.nativeSessionId !== input.nativeSessionId || current.providerVersion !== input.providerVersion) return;
        const body = mapCopilotUsageEvent(input.event);
        if (body) store.enqueueMeasurement(current.stateId, body);
        if (!warned && store.nearCapacity()) { warned = true; options.onDiagnostic?.("Usage journal is approaching its capacity."); }
      });
    },
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer); state(true);
      try { await uploader.close(); } catch { diagnose(); }
    },
  };
};
