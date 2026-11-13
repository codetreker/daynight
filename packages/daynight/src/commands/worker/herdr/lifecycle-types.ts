import type { SessionV2BoundaryGap, SessionV2Message, SessionV2Owner, SessionV2Run, TerminalBinding } from "../../../session/v2/types.js";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import type { FrozenToolObservation } from "../types.js";

export type HerdrExecutionTools = {
  agent: ResolvedToolLaunch | null;
  agentObservation: FrozenToolObservation | null;
  herdr: ResolvedToolLaunch;
  herdrObservation: FrozenToolObservation;
};
export type HerdrInstanceObservation = FrozenToolObservation & { protocol: 22 };

/** Birth identity survives exec; audit identity additionally fences the execution image. */
export type MacProcessIdentity = {
  role: "daemon" | "shell" | "agent";
  pid: number;
  birthToken: string;
  bootId: string;
  auditToken: number[];
  ppid: number;
  pgid: number;
  sid: number;
};
export type HerdrRunPhase = "prepared" | "launch_requested" | "active" | "stop_intent" | "close_requested" | "stopped_confirmed" | "stop_unknown";
export type HerdrLocalRun = {
  run: SessionV2Run;
  phase: HerdrRunPhase;
  nativeLaunch: "not_submitted" | "requested" | "observed" | "unknown";
  instanceDirectory: string;
  launches?: HerdrExecutionTools;
  instanceObservation?: HerdrInstanceObservation;
  daemon: MacProcessIdentity | null;
  processes: MacProcessIdentity[];
  stopOperationId: string | null;
  stopReason: "shutdown" | "terminal" | null;
  error: string | null;
  admission: string | null;
};
export type HerdrLocalSegment = {
  segmentId: string;
  segmentOrdinal: string;
  executionGeneration: string;
  binding: TerminalBinding;
  startedAt: string;
  endedAt: string | null;
  durationMs: string | null;
  gap: SessionV2BoundaryGap | null;
};
export type HerdrPreparation = { instanceId: string; instanceDirectory: string; phase: "prepared" | "launch_requested"; daemon: MacProcessIdentity | null; launches?: HerdrExecutionTools; instanceObservation?: HerdrInstanceObservation };
export type HerdrLedgerRequest = { message: Extract<SessionV2Message, { type: "generation_ledger" }>; connectionEpoch: string };
export type HerdrNativeLaunchRejection = { method: "agent.start"; code: "agent_pane_busy"; executionGeneration: string; binding: TerminalBinding };
export type HerdrLifecycleRecord = {
  owner: SessionV2Owner;
  claimId: string;
  cwd: string;
  sessionId: string;
  registrationId: string;
  connectionEpoch: string | null;
  registrationRequest: Extract<SessionV2Message, { type: "registration" }> | null;
  ledgerRequest: HerdrLedgerRequest | null;
  publishedLedgerHash: string | null;
  controlEpoch: string;
  initialAssignment: "pending" | "dispatching" | "transport_completed" | "unknown" | "unconfirmed";
  initialPrompt: string | null;
  automationBlocked: boolean;
  preparation: HerdrPreparation | null;
  runs: HerdrLocalRun[];
  segments: HerdrLocalSegment[];
  version: number;
};
