import { canonicalId } from "../../../api/parse.js";
import { normalizeServerUrl } from "../../../config/server.js";
import { parseSessionControls } from "../../../session/controls.js";
import { parseStartupObservation } from "../../../session/startup.js";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import { validateWindowsStoredStopProof, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import type { WebExecutionState } from "./web-types.js";

export type WebTerminationRun = { executionId: string; launchId: string; controllerId: string; controllerInstanceId: string; generation: string; ticketHash: string; stoppedSnapshotHash: string; snapshot: ControllerSnapshot };
export type WebTerminationLaunch = { executionId: string; launchId: string; controllerId: string; controllerInstanceId: string; generation: string; submission: WebExecutionState["launchSubmission"] };
export type WebTerminationClosure = { schemaVersion: 1; closureId: string; backend: "web"; owner: { projectId: string; taskId: string; workerId: string; worktreeId: string; ownerUserId: string; serverOrigin: string; provider: string }; claimId: string; sessionId: string; highestExecutionGeneration: string; launchesSettled: true; launches: WebTerminationLaunch[]; runs: WebTerminationRun[]; domainId: string; sequence: string; closureDigest: string };
const invalid = (): never => { throw new Error("Web termination closure has invalid or inconsistent evidence."); };
const object = (value: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return data;
};
const uuid = (value: unknown): string => typeof value === "string" && canonicalId(value) === value ? value : invalid();
const sequence = (value: unknown): string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n ? value : invalid();
const hash = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid();
const nullableText = (value: unknown): boolean => value === null || typeof value === "string" && value.isWellFormed() && !value.includes("\0");
const processProof = (value: unknown): void => {
  const data = object(value, ["pid", "parentPid", "processGroupId", "startedAt", "commandHash"], ["jobObjectName"]);
  if (!Number.isSafeInteger(data.pid) || (data.pid as number) < 1 || (data.pid as number) > 2_147_483_647 || !Number.isSafeInteger(data.parentPid) || (data.parentPid as number) < 0 || !(data.processGroupId === null || Number.isSafeInteger(data.processGroupId) && (data.processGroupId as number) > 0) || typeof data.startedAt !== "string" || data.startedAt.trim() === "") invalid();
  hash(data.commandHash);
  if (data.jobObjectName !== undefined && (typeof data.jobObjectName !== "string" || !/^Local\\Daynight-[0-9a-f-]{36}$/.test(data.jobObjectName))) invalid();
};
const snapshot = (value: unknown, run: WebTerminationRun, claimId: string, sessionId: string): void => {
  const data = object(value, ["executionId", "claimId", "sessionId", "executionGeneration", "controllerInstanceId", "lifecycle", "nativeSessionId", "initialInputState", "activity", "currentTurnId", "capabilities", "controllerProcess", "nativeProcesses", "nativeStopped", "stoppedAt", "error"], ["controls", "controlsRevisionFloor", "turnStartedAt", "startup", "windowsJobStopProof"]);
  if (data.executionId !== run.executionId || data.claimId !== claimId || data.sessionId !== sessionId || data.executionGeneration !== run.generation || data.controllerInstanceId !== run.controllerInstanceId || data.lifecycle !== "stopped" || data.nativeStopped !== true || data.activity !== "stopped" || typeof data.stoppedAt !== "string" || !Number.isFinite(Date.parse(data.stoppedAt)) || !nullableText(data.nativeSessionId) || !nullableText(data.currentTurnId) || !nullableText(data.error) || !["not_required", "not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"].includes(String(data.initialInputState))) invalid();
  const capabilities = object(data.capabilities, ["send", "steer", "cancel", "respond"]);
  if (Object.values(capabilities).some(value => value !== false)) invalid();
  processProof(data.controllerProcess);
  if (!Array.isArray(data.nativeProcesses)) invalid();
  (data.nativeProcesses as unknown[]).forEach(processProof);
  if (data.controls !== undefined) parseSessionControls(data.controls);
  if (data.controlsRevisionFloor !== undefined && data.controlsRevisionFloor !== "0") sequence(data.controlsRevisionFloor);
  if (data.startup !== undefined) parseStartupObservation(data.startup);
  if (data.turnStartedAt !== undefined && data.turnStartedAt !== null && (typeof data.turnStartedAt !== "string" || !Number.isFinite(Date.parse(data.turnStartedAt)))) invalid();
  const controller = data.controllerProcess as { jobObjectName?: string };
  if (controller.jobObjectName !== undefined && (controller.jobObjectName !== `Local\\Daynight-${run.launchId}` || data.windowsJobStopProof === undefined)) invalid();
  if (data.windowsJobStopProof !== undefined) validateWindowsStoredStopProof(value as ControllerSnapshot, run.ticketHash);
  if (controllerPayloadHash(value) !== run.stoppedSnapshotHash) invalid();
};

export const parseWebTerminationRun = (value: unknown, launch: WebTerminationLaunch, claimId: string, sessionId: string): WebTerminationRun => {
  const evidence = object(value, ["executionId", "launchId", "controllerId", "controllerInstanceId", "generation", "ticketHash", "stoppedSnapshotHash", "snapshot"]);
  if (["executionId", "launchId", "controllerId", "controllerInstanceId", "generation"].some(key => evidence[key] !== launch[key as keyof WebTerminationLaunch])) invalid();
  hash(evidence.ticketHash); hash(evidence.stoppedSnapshotHash);
  snapshot(evidence.snapshot, value as WebTerminationRun, claimId, sessionId);
  return value as WebTerminationRun;
};

export const parseWebTerminationClosure = (value: unknown): WebTerminationClosure => {
  const data = object(value, ["schemaVersion", "closureId", "backend", "owner", "claimId", "sessionId", "highestExecutionGeneration", "launchesSettled", "launches", "runs", "domainId", "sequence", "closureDigest"]);
  if (data.schemaVersion !== 1 || data.backend !== "web" || data.launchesSettled !== true) invalid();
  uuid(data.closureId); uuid(data.claimId); uuid(data.sessionId); uuid(data.domainId); sequence(data.sequence); sequence(data.highestExecutionGeneration); hash(data.closureDigest);
  const owner = object(data.owner, ["projectId", "taskId", "workerId", "worktreeId", "ownerUserId", "serverOrigin", "provider"]);
  for (const key of ["projectId", "taskId", "workerId", "worktreeId", "ownerUserId"]) uuid(owner[key]);
  if (typeof owner.serverOrigin !== "string" || normalizeServerUrl(owner.serverOrigin) !== owner.serverOrigin || !["codex", "claude", "copilot"].includes(String(owner.provider))) invalid();
  if (!Array.isArray(data.launches) || !Array.isArray(data.runs) || data.launches.length === 0 || String(data.launches.length) !== data.highestExecutionGeneration) invalid();
  const launches = data.launches as WebTerminationLaunch[], runs = data.runs as WebTerminationRun[];
  let runIndex = 0;
  launches.forEach((launch, index) => {
    const item = object(launch, ["executionId", "launchId", "controllerId", "controllerInstanceId", "generation", "submission"]);
    for (const key of ["executionId", "launchId", "controllerId", "controllerInstanceId"]) uuid(item[key]);
    if (item.generation !== String(index + 1) || !["not-submitted", "unknown", "acknowledged"].includes(String(item.submission)) || index > 0 && (launch.executionId !== launches[0]!.executionId || launch.controllerId !== launches[0]!.controllerId)) invalid();
    if (item.submission === "not-submitted") { if (index !== launches.length - 1) invalid(); return; }
    const run = runs[runIndex++];
    parseWebTerminationRun(run, launch, data.claimId as string, data.sessionId as string);
  });
  if (runIndex !== runs.length || new Set(launches.map(item => item.launchId)).size !== launches.length || new Set(launches.map(item => item.controllerInstanceId)).size !== launches.length) invalid();
  const { closureDigest, ...body } = data;
  if (controllerPayloadHash(body) !== closureDigest) invalid();
  return value as WebTerminationClosure;
};
