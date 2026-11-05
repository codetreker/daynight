import { describe, expect, it } from "vitest";
import archive from "../../session/fixtures/v2/valid-archive.json" with { type: "json" };
import { herdrRecordingMetadataBudget } from "../../../src/commands/worker/herdr/recording-budget.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { canonicalSessionJson, SESSION_V2_LIMITS } from "../../../src/session/v2/values.js";

const record = (): HerdrLifecycleRecord => ({ owner: archive.owner, sessionId: archive.sessionId, claimId: archive.claimId, segments: archive.segments.map(segment => ({ ...segment, gap: null })), runs: archive.runs.map(run => ({ run: structuredClone(run), processes: [], daemon: null })) } as unknown as HerdrLifecycleRecord);

describe("recording metadata admission", () => {
  it("includes complete stopped-run process proofs rather than only segment and gap bytes", () => {
    const value = record(), template = value.runs[0]!;
    value.runs = Array.from({ length: 50 }, (_, index) => {
      const run = structuredClone(template), generation = String(index + 1);
      run.run.executionGeneration = generation; run.run.segmentIds = index === 0 ? run.run.segmentIds : [];
      run.run.stopProof!.executionGeneration = generation;
      run.run.stopProof!.processes = Array.from({ length: 1000 }, (_, process) => ({ role: process === 0 ? "shell" : "agent", pid: process + 1, birthToken: String(process), bootId: "original-boot-identity" }));
      return run;
    });
    expect(Buffer.byteLength(canonicalSessionJson(value.segments))).toBeLessThan(1024);
    expect(herdrRecordingMetadataBudget(value, [], "run")).toBeGreaterThan(SESSION_V2_LIMITS.metadataMaxBytes);
  });
  it("reserves v2 process and escaping maxima before unknown native identities exist", () => {
    const value = record(); value.runs = []; value.segments = [];
    const budget = herdrRecordingMetadataBudget(value, [], "run");
    expect(budget).toBeGreaterThan(1000 * (256 * 4));
    expect(budget).toBeLessThan(SESSION_V2_LIMITS.metadataMaxBytes);
  });
  it("measures the JSON byte contribution of completed proofs exactly", () => {
    const value = record(), before = herdrRecordingMetadataBudget(value, [], "run");
    const proof = value.runs[0]!.run.stopProof!, original = canonicalSessionJson(proof);
    proof.processes[0]!.birthToken = '"'.repeat(256);
    expect(herdrRecordingMetadataBudget(value, [], "run") - before).toBe(Buffer.byteLength(canonicalSessionJson(proof)) - Buffer.byteLength(original));
  });
  it("retains room for all 1000 segment and gap slots when their actual serialized metadata fits", () => {
    const value = record(), segment = value.segments[0]!;
    value.segments = Array.from({ length: 999 }, (_, ordinal) => ({ ...structuredClone(segment), segmentOrdinal: String(ordinal + 1) }));
    value.runs[0]!.run.segmentIds = value.segments.map(s => s.segmentId);
    const gaps = Array.from({ length: 999 }, () => ({ segmentId: segment.segmentId, reason: "read_interrupted" as const, startElapsedMs: "1", endElapsedMs: "2" }));
    expect(herdrRecordingMetadataBudget(value, gaps, "segment")).toBeLessThan(SESSION_V2_LIMITS.metadataMaxBytes);
  });
});
