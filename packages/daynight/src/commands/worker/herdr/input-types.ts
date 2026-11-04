import type { SessionV2Key, SessionV2Message, SessionV2Payloads, TerminalBinding } from "../../../session/v2/types.js";
export type HerdrInputTarget = { sessionId: string; claimId: string; executionGeneration: string; connectionEpoch: string; segmentId: string; binding: TerminalBinding };
export type HerdrInputSource = "initial" | "continuation" | "cleanup" | "web";
export type HerdrInputBatch = { operationId: string; source: HerdrInputSource; target: HerdrInputTarget; payload: { kind: "prompt" | "paste"; text: string } | { kind: "keys"; key: SessionV2Key } };
export type HerdrInputWriteContext = {
  signal: AbortSignal;
  /** Check before every native input write, after any attach or readiness wait. */
  beforeWrite(): Promise<void>;
  /** Call synchronously before attempting the first native input write, including a possibly partial write. */
  markWritten(): void;
};
export type HerdrInitialOutcome = SessionV2Payloads["control_state"]["initialAssignment"];
export type HerdrInputOperation = {
  operationId: string; source: HerdrInputSource | "control"; digest: string; target: HerdrInputTarget;
  controlEpoch: string; leaseId: string | null; leaseSeq: string | null;
  result: SessionV2Payloads["operation_result"]; controlAck: SessionV2Payloads["control_ack"] | null;
};
export type HerdrInputRecovery = {
  prepare: Extract<SessionV2Message, { type: "automation_recovery_prepare" }>;
  request: Extract<SessionV2Message, { type: "automation_recovery" }> | null;
};
export type HerdrInputRecord = {
  target: HerdrInputTarget; version: number; controlEpoch: string;
  state: SessionV2Payloads["control_state"]["state"]; lease: SessionV2Payloads["control_state"]["lease"]; leaseSeq: string;
  initialOperationId: string; initialAttemptOperationId: string; initialDigest: string | null; cleanupOperationId: string; initialOutcome: HerdrInitialOutcome;
  initialDisposition: { operationId: string; actorUserId: string; decidedAt: string; disposition: "delivered_continue" } | null;
  draftRisk: boolean; unknownInput: boolean; cleanupEligible: boolean; automationBeforeClosing: boolean;
  operations: HerdrInputOperation[]; recoveries: HerdrInputRecovery[];
};
