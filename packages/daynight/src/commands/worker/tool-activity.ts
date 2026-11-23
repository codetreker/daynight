import path from "node:path";
import { controllerExecutionDirectory } from "../controller/launch-ticket.js";
import { readControllerSnapshot, type ControllerSnapshot } from "../controller/lifecycle-store.js";
import type { LocalTask } from "./backends/web-types.js";
import type { BotExecution } from "./bots/execution-store.js";
import type { BotRecord } from "./bots/types.js";

export type ToolActivity = "inactive" | "active" | "unconfirmed";
type Fence = Pick<ControllerSnapshot, "executionId" | "sessionId" | "executionGeneration" | "controllerInstanceId">;
const sameFence = (snapshot: ControllerSnapshot, fence: Fence): boolean => snapshot.executionId === fence.executionId
  && snapshot.sessionId === fence.sessionId && snapshot.executionGeneration === fence.executionGeneration
  && snapshot.controllerInstanceId === fence.controllerInstanceId;
const confirmedStop = (snapshot: ControllerSnapshot): boolean => snapshot.lifecycle === "stopped" && snapshot.nativeStopped
  && snapshot.stoppedAt !== null && snapshot.controllerProcess !== null;

/** Read durable stop proof; an activity label never proves that the original writer exited. */
export const readWebToolActivity = (homeDirectory: string, task: LocalTask): ToolActivity => {
  const execution = task.webExecution;
  if (execution === null) return "inactive";
  try {
    const snapshot = readControllerSnapshot(path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite"));
    if (execution.launchSubmission === "not-submitted" && execution.controllerProcess === null && execution.nativeProcesses.length === 0
      && (snapshot === null || snapshot.executionId === execution.executionId && snapshot.claimId === task.claimId && snapshot.testExecutionId === undefined
        && snapshot.sessionId === execution.sessionId && BigInt(snapshot.executionGeneration) + 1n === BigInt(execution.executionGeneration) && confirmedStop(snapshot))) return "inactive";
    if (execution.sessionId === null || snapshot === null || !sameFence(snapshot, { ...execution, sessionId: execution.sessionId })
      || snapshot.claimId !== task.claimId || snapshot.testExecutionId !== undefined) return "unconfirmed";
    if (confirmedStop(snapshot)) return "inactive";
    return execution.launchSubmission === "unknown" || task.cleanup !== null || snapshot.activity === "stopped"
      || ["stopping", "stopped", "failed", "paused"].includes(snapshot.lifecycle) ? "unconfirmed" : "active";
  } catch { return "unconfirmed"; }
};

/** Bot execution rows already retain the same fenced journal observation across reopen. */
export const botToolActivity = (record: BotRecord, execution: BotExecution | null): ToolActivity => {
  const intent = record.intent;
  if (intent === null || execution === null) return "inactive";
  if (execution.launchSubmission === "not-submitted" && execution.controllerProcess === null && execution.snapshot === null) return "inactive";
  const snapshot = execution.snapshot;
  if (intent.sessionId === null || snapshot === null || !sameFence(snapshot, { ...intent, sessionId: intent.sessionId })
    || snapshot.testExecutionId !== intent.executionId || snapshot.claimId !== undefined) return "unconfirmed";
  if (confirmedStop(snapshot)) return "inactive";
  return execution.launchSubmission === "unknown" || record.cleanup !== undefined || snapshot.activity === "stopped"
    || ["stopping", "stopped", "failed", "paused"].includes(snapshot.lifecycle) ? "unconfirmed" : "active";
};
