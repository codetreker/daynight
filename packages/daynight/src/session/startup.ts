import { fields, id, malformed, timestamp } from "../api/validation.js";

export const STARTUP_REPORT_HEADER = "X-Daynight-Startup-Version";
export type StartupObservation =
  | { state: "unknown"; reasonCode: "evidence_missing" | "native_timeout" | "native_transport_unknown" | "controller_start_unknown" }
  | { state: "starting"; reasonCode: "initializing" }
  | { state: "ready"; reasonCode: "ready" }
  | { state: "failed"; reasonCode: "native_rejected" | "controller_launch_failed" };
export type RecoveryObservation =
  | { state: "none"; reasonCode: null }
  | { state: "blocked"; reasonCode: "native_identity_missing" | "recovery_limit" | "recovery_blocked" };
export type SessionStartupReport = {
  schemaVersion: 1; source: "worker"; sessionId: string; claimId: string;
  executionGeneration: string; controllerInstanceId: string; revision: string;
  observedAt: string; startup: StartupObservation; recovery: RecoveryObservation;
};

const sequence = (value: unknown): string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= 9_223_372_036_854_775_807n ? value : malformed();
export const parseStartupObservation = (value: unknown): StartupObservation => {
  const o = fields(value, ["state", "reasonCode"]);
  if (o.state === "starting" && o.reasonCode === "initializing") return { state: o.state, reasonCode: o.reasonCode };
  if (o.state === "ready" && o.reasonCode === "ready") return { state: o.state, reasonCode: o.reasonCode };
  if (o.state === "failed" && (o.reasonCode === "native_rejected" || o.reasonCode === "controller_launch_failed")) return { state: o.state, reasonCode: o.reasonCode };
  if (o.state === "unknown" && (o.reasonCode === "evidence_missing" || o.reasonCode === "native_timeout" || o.reasonCode === "native_transport_unknown" || o.reasonCode === "controller_start_unknown")) return { state: o.state, reasonCode: o.reasonCode };
  return malformed();
};
export const parseRecoveryObservation = (value: unknown): RecoveryObservation => {
  const o = fields(value, ["state", "reasonCode"]);
  if (o.state === "none" && o.reasonCode === null) return { state: o.state, reasonCode: o.reasonCode };
  if (o.state === "blocked" && (o.reasonCode === "native_identity_missing" || o.reasonCode === "recovery_limit" || o.reasonCode === "recovery_blocked")) return { state: o.state, reasonCode: o.reasonCode };
  return malformed();
};
export const parseSessionStartupReport = (value: unknown): SessionStartupReport => {
  const o = fields(value, ["schemaVersion", "source", "sessionId", "claimId", "executionGeneration", "controllerInstanceId", "revision", "observedAt", "startup", "recovery"]);
  if (o.schemaVersion !== 1 || o.source !== "worker") return malformed();
  return { schemaVersion: 1, source: "worker", sessionId: id(o.sessionId), claimId: id(o.claimId),
    executionGeneration: sequence(o.executionGeneration), controllerInstanceId: id(o.controllerInstanceId),
    revision: sequence(o.revision), observedAt: timestamp(o.observedAt),
    startup: parseStartupObservation(o.startup), recovery: parseRecoveryObservation(o.recovery) };
};

/** Observations are generation facts, never proof that the Controller is currently connected. */
export const sameStartupReport = (left: SessionStartupReport | null | undefined, right: SessionStartupReport | null | undefined): boolean =>
  left == null || right == null ? left == null && right == null : JSON.stringify(parseSessionStartupReport(left)) === JSON.stringify(parseSessionStartupReport(right));

const summaries: Record<StartupObservation["reasonCode"], string> = {
  evidence_missing: "Current startup evidence is unavailable.",
  initializing: "The original native session is initializing.",
  ready: "The original native session completed initialization.",
  native_rejected: "The native provider rejected initialization.",
  native_timeout: "Native initialization timed out; its result is unknown.",
  native_transport_unknown: "The native startup result could not be confirmed.",
  controller_start_unknown: "The original controller startup result could not be confirmed.",
  controller_launch_failed: "The operating system rejected the controller launch.",
};
export const startupSummary = (observation: StartupObservation): string => summaries[observation.reasonCode];

export const recoverySummary = (observation: RecoveryObservation): string | null => observation.state === "none" ? null : ({
  native_identity_missing: "Recovery is blocked because the original native session identity is unconfirmed.",
  recovery_limit: "Recovery is blocked after the recovery budget was exhausted; explicit retry is required.",
  recovery_blocked: "Recovery is blocked by the original execution safety checks.",
})[observation.reasonCode];
