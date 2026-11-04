import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import archive from "../../session/fixtures/v2/valid-archive.json" with { type: "json" };
import { createHerdrRecordingRuntime } from "../../../src/commands/worker/herdr/recording-runtime.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { SESSION_V2_LIMITS } from "../../../src/session/v2/values.js";
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const setup = () => {
  mkdirSync("../../.tmp/recording-runtime", { recursive: true });
  const directory = mkdtempSync(path.resolve("../../.tmp/recording-runtime/run-")); roots.push(directory);
  const record = { owner: archive.owner, sessionId: archive.sessionId, claimId: archive.claimId, segments: archive.segments.map(s => ({ ...s, endedAt: null, durationMs: null, startedAt: new Date().toISOString(), gap: null })), runs: archive.runs.map(run => ({ run, phase: "active" })), cwd: directory } as unknown as HerdrLifecycleRecord;
  return { directory, record };
};
test("captures independently of offline publication and seals its own monotonic boundary", async () => {
  const f = setup(); const read = vi.fn(async () => ({ width: 1, height: 1, rows: [[]] }));
  const runtime = createHerdrRecordingRuntime({ directory: f.directory, read, publish: async () => { throw new Error("offline"); } });
  runtime.prepare({ ...f.record, segments: [] }); runtime.start(f.record);
  await vi.waitFor(() => expect(runtime.source(f.record).status().runs[0]!.registeredFrameCount).toBe("1"));
  const boundary = await runtime.stop(f.record);
  expect(Number(boundary!.durationMs)).toBeGreaterThanOrEqual(0);
  runtime.closeRun(f.record);
  const source = runtime.source(f.record).snapshot(); expect(source.files).toHaveLength(1); expect(source.runs[0]!.closed).toBe(true);
  expect(source.segments[0]!.durationMs).toBe(boundary!.durationMs);
  runtime.close();
});
test("recovery closes an uncheckpointed segment at its last durable observation", async () => {
  const f = setup(); const runtime = createHerdrRecordingRuntime({ directory: f.directory, read: async () => ({ width: 1, height: 1, rows: [[]] }), publish: async () => {} });
  runtime.prepare({ ...f.record, segments: [] }); const source = runtime.source(f.record); source.openSegment(f.record.segments[0]!);
  source.sample(f.record.segments[0]!.segmentId, { width: 1, height: 1, rows: [[]] }, { elapsedMs: "1", capturedAt: f.record.segments[0]!.startedAt });
  source.sample(f.record.segments[0]!.segmentId, { width: 1, height: 1, rows: [[]] }, { elapsedMs: "1000", capturedAt: f.record.segments[0]!.startedAt });
  runtime.close();
  const recovered = createHerdrRecordingRuntime({ directory: f.directory, read: async () => ({ width: 1, height: 1, rows: [[]] }), publish: async () => {} });
  expect(recovered.recover(f.record)[0]!.boundary.durationMs).toBe("1"); recovered.close();
});
test("segment-budget exhaustion retains its registered target and source while native execution can continue", async () => {
  const maximum = SESSION_V2_LIMITS.maxSegments;
  Object.assign(SESSION_V2_LIMITS, { maxSegments: 1 });
  const f = setup(); let reads = 0;
  const runtime = createHerdrRecordingRuntime({ directory: f.directory, read: async () => { reads++; return { width: 1, height: 1, rows: [[]] }; }, publish: async () => {} });
  try {
    runtime.prepare({ ...f.record, segments: [] }); expect(runtime.canAllocate(f.record)).toBe(true);
    runtime.start(f.record); await vi.waitFor(() => expect(runtime.source(f.record).status().runs[0]!.registeredFrameCount).toBe("1"));
    expect(runtime.canAllocate(f.record)).toBe(false); expect(runtime.canPrepareRun(f.record)).toBe(false);
    await runtime.exhaust(f.record);
    const before = reads; await new Promise(resolve => setTimeout(resolve, 400)); expect(reads).toBe(before);
    expect(runtime.source(f.record).status().failed).toBe(false);
    const boundary = await runtime.stop(f.record); runtime.closeRun(f.record);
    const snapshot = runtime.source(f.record).snapshot(); expect(snapshot.segments).toHaveLength(1); expect(snapshot.files).toHaveLength(1);
    expect(snapshot.runs[0]!.captureError).toBe("recording_limit"); expect(snapshot.gaps.at(-1)).toMatchObject({ reason: "recording_limit", endElapsedMs: null });
    expect(BigInt(boundary!.durationMs)).toBeGreaterThan(BigInt(snapshot.index[0]!.lastElapsedMs));
  } finally { runtime.close(); Object.assign(SESSION_V2_LIMITS, { maxSegments: maximum }); }
});

test("metadata exhaustion refuses another segment while preserving a sealable partial source", async () => {
  const maximum = SESSION_V2_LIMITS.metadataMaxBytes;
  const f = setup(), runtime = createHerdrRecordingRuntime({ directory: f.directory, read: async () => ({ width: 1, height: 1, rows: [[]] }), publish: async () => {} });
  try {
    runtime.prepare({ ...f.record, segments: [] }); runtime.start(f.record);
    await vi.waitFor(() => expect(runtime.source(f.record).status().runs[0]!.registeredFrameCount).toBe("1"));
    Object.assign(SESSION_V2_LIMITS, { metadataMaxBytes: 32 * 1024 });
    expect(runtime.canAllocate(f.record)).toBe(false); expect(runtime.canPrepareRun(f.record)).toBe(false);
    await runtime.exhaust(f.record); await runtime.stop(f.record); runtime.closeRun(f.record);
    expect(runtime.source(f.record).status().failed).toBe(false);
    expect(runtime.source(f.record).snapshot()).toMatchObject({ runs: [{ captureError: "recording_limit" }] });
  } finally { runtime.close(); Object.assign(SESSION_V2_LIMITS, { metadataMaxBytes: maximum }); }
});
