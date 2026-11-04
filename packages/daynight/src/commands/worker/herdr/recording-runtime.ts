import path from "node:path";
import { existsSync } from "node:fs";
import type { TerminalFrame } from "../../../session/v2/types.js";
import { SESSION_V2_LIMITS, SessionV2Error } from "../../../session/v2/values.js";
import type { HerdrLifecycleRecord } from "./lifecycle-types.js";
import { herdrRecordingMetadataBudget } from "./recording-budget.js";
import { openHerdrRecordingStore, type HerdrRecordingStore } from "./recording-store.js";
import { startHerdrRecordingSampler, type HerdrRecordingSampler } from "./recording-sampler.js";
import type { HerdrRecordingBoundary, HerdrRecordingScreen } from "./recording-types.js";

/** Owns capture lifetime; neither network connectivity nor viewers own recording. */
export const createHerdrRecordingRuntime = (options: {
  directory: string;
  read(record: HerdrLifecycleRecord, signal: AbortSignal): Promise<HerdrRecordingScreen>;
  publish(record: HerdrLifecycleRecord, frame: TerminalFrame, recorded: boolean, signal: AbortSignal): Promise<void>;
}) => {
  const stores = new Map<string, HerdrRecordingStore>();
  const samplers = new Map<string, { segmentId: string; sampler: HerdrRecordingSampler }>();
  const latest = new Map<string, { record: HerdrLifecycleRecord; frame: TerminalFrame; recorded: boolean }>();
  const exhausted = new Map<string, { segmentId: string; base: HerdrRecordingBoundary; monotonicStart: number }>();
  const directory = (record: HerdrLifecycleRecord) => path.join(options.directory, record.sessionId);
  const source = (record: HerdrLifecycleRecord): HerdrRecordingStore => {
    let store = stores.get(record.sessionId);
    if (!store) {
      if (!existsSync(directory(record))) throw new SessionV2Error("source_corrupt");
      store = openHerdrRecordingStore({ directory: directory(record), owner: record.owner, sessionId: record.sessionId, claimId: record.claimId });
      stores.set(record.sessionId, store);
    }
    return store;
  };
  const canAllocate = (record: HerdrLifecycleRecord): boolean => {
    const store = source(record), status = store.status();
    return store.canOpenSegment(!samplers.has(record.sessionId)) && !status.runs.some(run => run.captureError === "recording_limit") && herdrRecordingMetadataBudget(record, store.metadata().gaps, "segment") <= SESSION_V2_LIMITS.metadataMaxBytes;
  };
  return {
    directory, source,
    canAllocate,
    canPrepareRun: (record: HerdrLifecycleRecord): boolean => record.runs.length < SESSION_V2_LIMITS.maxRuns && (record.runs.length === 0 || canAllocate(record)) && herdrRecordingMetadataBudget(record, record.runs.length === 0 ? [] : source(record).metadata().gaps, "run") <= SESSION_V2_LIMITS.metadataMaxBytes,
    prepare(record: HerdrLifecycleRecord): void {
      const run = record.runs.at(-1); if (!run) throw new SessionV2Error("stale_fence");
      if (!stores.has(record.sessionId) && !existsSync(directory(record))) {
        if (record.runs.length !== 1 || record.segments.length !== 0) throw new SessionV2Error("source_corrupt");
        stores.set(record.sessionId, openHerdrRecordingStore({ directory: directory(record), owner: record.owner, sessionId: record.sessionId, claimId: record.claimId }));
      }
      source(record).registerRun(run.run.executionGeneration);
    },
    start(record: HerdrLifecycleRecord): void {
      const segment = record.segments.at(-1);
      if (!segment || segment.endedAt !== null || record.runs.at(-1)?.phase !== "active") throw new SessionV2Error("stale_fence");
      const previous = samplers.get(record.sessionId);
      if (previous) { if (previous.segmentId !== segment.segmentId) throw new SessionV2Error("stale_fence"); return; }
      const store = source(record); store.openSegment(segment);
      const sampler = startHerdrRecordingSampler({ store, segment, read: signal => options.read(record, signal), publish: async (frame, recorded, signal) => {
        latest.set(record.sessionId, { record, frame, recorded });
        await options.publish(record, frame, recorded, signal);
      } });
      samplers.set(record.sessionId, { segmentId: segment.segmentId, sampler });
    },
    /** Preserve the original registered control target after capture allocation ends. */
    async exhaust(record: HerdrLifecycleRecord): Promise<void> {
      if (exhausted.has(record.sessionId)) return;
      const segment = record.segments.at(-1), store = source(record);
      if (!segment || segment.endedAt !== null || record.runs.at(-1)?.phase !== "active") throw new SessionV2Error("stale_fence");
      const active = samplers.get(record.sessionId);
      const boundary = active ? await active.sampler.stop() : store.recoveryBoundary(segment.segmentId);
      samplers.delete(record.sessionId); latest.delete(record.sessionId);
      // The marker follows the last checkpoint. It carries no synthetic screen
      // observation; subsequent elapsed time extends only the open missing range.
      const marker = String(BigInt(boundary.durationMs) + 1n), capturedAt = new Date(Math.max(Date.now(), Date.parse(boundary.endedAt))).toISOString();
      store.limit(segment.segmentId, marker, capturedAt);
      const persisted = store.recoveryBoundary(segment.segmentId);
      const base = { durationMs: String(BigInt(boundary.durationMs) > BigInt(persisted.durationMs) ? BigInt(boundary.durationMs) : BigInt(persisted.durationMs)), endedAt: new Date(Math.max(Date.parse(boundary.endedAt), Date.parse(persisted.endedAt))).toISOString() };
      exhausted.set(record.sessionId, { segmentId: segment.segmentId, base, monotonicStart: performance.now() });
    },
    async republish(record: HerdrLifecycleRecord, signal: AbortSignal): Promise<void> {
      const value = latest.get(record.sessionId);
      if (value && value.record.segments.at(-1)?.segmentId === record.segments.at(-1)?.segmentId) await options.publish(record, value.frame, value.recorded, signal);
    },
    recover(record: HerdrLifecycleRecord): { segmentId: string; boundary: HerdrRecordingBoundary }[] {
      if (samplers.has(record.sessionId)) throw new Error("An active sampler cannot be recovered as a crashed segment.");
      const store = source(record);
      return record.segments.filter(segment => segment.endedAt === null).map(segment => {
        const boundary = store.recoverSegment(segment.segmentId);
        return { segmentId: segment.segmentId, boundary };
      });
    },
    async stop(record: HerdrLifecycleRecord): Promise<HerdrRecordingBoundary | null> {
      const limited = exhausted.get(record.sessionId);
      if (limited) {
        exhausted.delete(record.sessionId); latest.delete(record.sessionId);
        const boundary = { durationMs: String(BigInt(limited.base.durationMs) + BigInt(Math.max(0, Math.floor(performance.now() - limited.monotonicStart)))), endedAt: new Date(Math.max(Date.now(), Date.parse(limited.base.endedAt))).toISOString() };
        source(record).endSegment(limited.segmentId, boundary); return boundary;
      }
      const active = samplers.get(record.sessionId);
      if (!active) return null;
      samplers.delete(record.sessionId); latest.delete(record.sessionId);
      const boundary = await active.sampler.stop(); source(record).endSegment(active.segmentId, boundary); return boundary;
    },
    closeRun(record: HerdrLifecycleRecord): void { source(record).closeRun(record.runs.at(-1)!.run.executionGeneration); },
    close(): void {
      for (const { sampler } of samplers.values()) sampler.cancel();
      samplers.clear(); latest.clear(); stores.clear(); exhausted.clear();
    },
  };
};
export type HerdrRecordingRuntime = ReturnType<typeof createHerdrRecordingRuntime>;
