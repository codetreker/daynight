import type { SessionV2FrameFile, SessionV2FrameIndex, SessionV2Gap, SessionV2Owner, SessionV2Segment, TerminalStyledRun } from "../../../session/v2/types.js";
import type { SessionV2ErrorCode } from "../../../session/v2/values.js";

export type HerdrRecordingIdentity = { owner: SessionV2Owner; sessionId: string; claimId: string };
export type HerdrRecordingRun = {
  executionGeneration: string; responsibilityId: string; recordingEnabled: boolean;
  selectedFrameCount: string; registeredFrameCount: string; captureError: SessionV2ErrorCode | null; closed: boolean;
};
export type HerdrRecordingSnapshot = HerdrRecordingIdentity & {
  schemaVersion: 1; runs: HerdrRecordingRun[]; segments: SessionV2Segment[];
  files: SessionV2FrameFile[]; index: SessionV2FrameIndex[]; gaps: SessionV2Gap[]; journalSha256: string;
};
export type HerdrRecordingScreen = { width: number; height: number; rows: TerminalStyledRun[][] };
export type HerdrRecordingObservation = { elapsedMs: string; capturedAt: string };
export type HerdrRecordingBoundary = { endedAt: string; durationMs: string };
