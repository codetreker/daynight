import { canonicalId } from "../../api/parse.js";
import type { ProcessProof } from "./process-proof.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";

export class WindowsJobEvidenceConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "WindowsJobEvidenceConflictError"; }
}

type WindowsJobSourceFields = {
  version: 1;
  launchId: string;
  executionId: string;
  executionGeneration: string;
  controllerInstanceId: string;
  ticketHash: string;
  guardian: ProcessProof;
  jobHandle: string;
  controller: ProcessProof;
};
export type WindowsJobPreparedSource = WindowsJobSourceFields & { phase: "prepared" };
export type WindowsJobAssignedSource = WindowsJobSourceFields & { phase: "assigned" };
export type WindowsJobSource = WindowsJobPreparedSource | WindowsJobAssignedSource;
export type WindowsJobStopReceipt = {
  version: 1;
  source: WindowsJobAssignedSource;
  sealed: true;
  empty: true;
  controllerStopped: true;
  nativeProcessesStopped: true;
  observedSnapshot: ControllerSnapshot;
  snapshot: ControllerSnapshot;
};

const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new WindowsJobEvidenceConflictError("Invalid Windows Job evidence fields.");
  return value as Record<string, unknown>;
};
const processProof = (value: unknown): ProcessProof => {
  const keys = ["pid", "parentPid", "processGroupId", "startedAt", "commandHash"];
  const p = record(value, keys);
  if (!Number.isSafeInteger(p.pid) || (p.pid as number) <= 0 || (p.pid as number) > 2_147_483_647 ||
      !Number.isSafeInteger(p.parentPid) || (p.parentPid as number) < 0 || (p.parentPid as number) > 0xffff_ffff ||
      p.processGroupId !== null || typeof p.startedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(p.startedAt) || !Number.isFinite(Date.parse(p.startedAt)) ||
      typeof p.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(p.commandHash)) throw new WindowsJobEvidenceConflictError("Invalid Windows Job process identity.");
  return value as ProcessProof;
};
export const parseWindowsJobSource = (value: unknown, ticket: ControllerLaunchTicket): WindowsJobSource => {
  const p = record(value, ["version", "phase", "launchId", "executionId", "executionGeneration", "controllerInstanceId", "ticketHash", "guardian", "jobHandle", "controller"]);
  if (p.version !== 1 || (p.phase !== "prepared" && p.phase !== "assigned") || p.launchId !== ticket.launchId || p.executionId !== ticket.executionId || p.executionGeneration !== ticket.executionGeneration || p.controllerInstanceId !== ticket.controllerInstanceId || p.ticketHash !== controllerPayloadHash(ticket) ||
      typeof p.launchId !== "string" || canonicalId(p.launchId) !== p.launchId || typeof p.jobHandle !== "string" || !/^[1-9][0-9]{0,19}$/.test(p.jobHandle) || BigInt(p.jobHandle) > 0xffff_ffff_ffff_ffffn) throw new WindowsJobEvidenceConflictError("Windows Job source does not match the original ticket.");
  const guardian = processProof(p.guardian), controller = processProof(p.controller);
  if (guardian.pid === controller.pid || guardian.parentPid !== controller.pid) throw new WindowsJobEvidenceConflictError("Windows Job guardian must be an independent child of the Controller.");
  return value as WindowsJobSource;
};
/** The optional display name is not an object identity and must match this launch. */
export const matchesWindowsJobController = (value: unknown, source: WindowsJobSource): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  const hasName = Object.hasOwn(proof, "jobObjectName");
  if (hasName && proof.jobObjectName !== `Local\\Daynight-${source.launchId}`) return false;
  const { jobObjectName: ignored, ...original } = proof;
  void ignored;
  try { processProof(original); } catch { return false; }
  return controllerPayloadHash(original) === controllerPayloadHash(source.controller);
};
/** Assignment precedes publication of the Controller proof and native startup. */
export const windowsJobStoppedController = (observed: ControllerSnapshot, source: WindowsJobAssignedSource): ProcessProof => {
  if (observed.controllerProcess !== null) {
    if (!matchesWindowsJobController(observed.controllerProcess, source)) throw new WindowsJobEvidenceConflictError("Windows Job Controller identity conflicts with the original snapshot.");
    return observed.controllerProcess;
  }
  if (!["starting", "paused", "stopping", "failed"].includes(observed.lifecycle) || observed.nativeStopped !== false || observed.stoppedAt !== null || !Array.isArray(observed.nativeProcesses) || observed.nativeProcesses.length !== 0 || !["not_submitted", "not_required"].includes(observed.initialInputState)) throw new WindowsJobEvidenceConflictError("Windows Job cannot recover an incomplete Controller proof after native execution may have started.");
  return { ...source.controller, jobObjectName: `Local\\Daynight-${source.launchId}` };
};
export const parseWindowsJobReceipt = (value: unknown, ticket: ControllerLaunchTicket): WindowsJobStopReceipt => {
  const p = record(value, ["version", "source", "sealed", "empty", "controllerStopped", "nativeProcessesStopped", "observedSnapshot", "snapshot"]);
  const source = parseWindowsJobSource(p.source, ticket);
  if (p.version !== 1 || source.phase !== "assigned" || p.sealed !== true || p.empty !== true || p.controllerStopped !== true || p.nativeProcessesStopped !== true || typeof p.snapshot !== "object" || p.snapshot === null || Array.isArray(p.snapshot) || typeof p.observedSnapshot !== "object" || p.observedSnapshot === null || Array.isArray(p.observedSnapshot)) throw new WindowsJobEvidenceConflictError("Invalid Windows Job stop receipt.");
  const snapshot = p.snapshot as ControllerSnapshot;
  if (snapshot.executionId !== ticket.executionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== ticket.testExecutionId || snapshot.sessionId !== ticket.sessionId || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId || snapshot.lifecycle !== "stopped" || snapshot.nativeStopped !== true || typeof snapshot.stoppedAt !== "string" || !Number.isFinite(Date.parse(snapshot.stoppedAt)) || !Array.isArray(snapshot.nativeProcesses) || !matchesWindowsJobController(snapshot.controllerProcess, source)) throw new WindowsJobEvidenceConflictError("Windows Job stop receipt does not match the original generation.");
  for (const native of snapshot.nativeProcesses) processProof(native);
  const observed = p.observedSnapshot as ControllerSnapshot;
  const expected = { ...observed, controllerProcess: windowsJobStoppedController(observed, source), lifecycle: "stopped", nativeStopped: true, stoppedAt: snapshot.stoppedAt, activity: "stopped", capabilities: { send: false, steer: false, cancel: false, respond: false } };
  if (controllerPayloadHash(expected) !== controllerPayloadHash(snapshot)) throw new WindowsJobEvidenceConflictError("Windows Job stop receipt differs from the original observed generation.");
  return value as WindowsJobStopReceipt;
};
