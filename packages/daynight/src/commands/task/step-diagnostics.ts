import { ApiError } from "../../api/client.js";
import { OperationError } from "../../api/operation.js";
import { UsageError } from "../../cli/context.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { ProjectDiscoveryError } from "../../repository/discovery-error.js";
import { stepText } from "./step-rendering.js";
import { findStepWriteFailure, stepApiFailures } from "./step-write-errors.js";
import type { StepWriteAttempt, StepWriteOperation } from "./step-write-errors.js";

type ReadPhase = "prepare" | "request" | "render" | "output";
const apiFailure = (cause: unknown, seen = new Set<unknown>()): ApiError | undefined => {
  if (!(cause instanceof Error) || seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof ApiError) return cause;
  if (cause instanceof AggregateError) {
    for (const child of cause.errors as readonly unknown[]) {
      const failure = apiFailure(child, seen);
      if (failure !== undefined) return failure;
    }
  }
  return apiFailure(cause.cause, seen);
};

const projectDiscoveryFailure = (cause: unknown, seen = new Set<unknown>()): ProjectDiscoveryError | undefined => {
  if (!(cause instanceof Error) || seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof ProjectDiscoveryError) return cause;
  if (cause instanceof AggregateError) {
    for (const child of cause.errors as readonly unknown[]) {
      const failure = projectDiscoveryFailure(child, seen);
      if (failure !== undefined) return failure;
    }
  }
  return projectDiscoveryFailure(cause.cause, seen);
};

const discoveryMessage = (failure: ProjectDiscoveryError): string => failure.kind === "missing" ? "Project does not exist."
  : `Multiple projects match this repository (${failure.projectIds.map(stepText).join(", ")}); specify --project <id>.`;

const ordinaryStepMessage = (cause: unknown, operation: "list" | "show" | StepWriteOperation, phase: ReadPhase, api: ApiError | undefined): string => {
  const discovery = projectDiscoveryFailure(cause);
  const operationFailure = api?.cause instanceof OperationError ? api.cause : cause instanceof OperationError ? cause : undefined;
  return cause instanceof UsageError ? `${cause.message} Run ${cause.helpCommand} for usage.`
    : discovery !== undefined ? discoveryMessage(discovery)
    : api?.serverMessage !== undefined ? `${api.code}: ${stepText(api.serverMessage)}`
    : operationFailure !== undefined ? operationFailure.message
    : phase === "prepare" ? operation !== "list" && operation !== "show" ? `Could not prepare the Step ${stepOperationLabel(operation)}. Check configuration and authentication; run daynight login if needed.` : "Could not prepare the Steps read. Check configuration and authentication; run daynight login if needed."
    : `Steps ${operation} failed.`;
};

export class StepReadCommandError extends PublicDiagnosticError {
  constructor(cause: unknown, operation: "list" | "show", phase: ReadPhase, projectId?: string, taskId?: string, stepId?: string) {
    const discovery = projectDiscoveryFailure(cause);
    const api = discovery === undefined ? apiFailure(cause) : undefined;
    const message = ordinaryStepMessage(cause, operation, phase, api);
    const context = ["source=cli", `operation=task.step.${operation}`, `phase=${api?.phase ?? phase}`,
      ...(projectId === undefined ? [] : [`projectId=${projectId}`]),
      ...(taskId === undefined ? [] : [`taskId=${taskId}`]),
      ...(stepId === undefined ? [] : [`stepId=${stepId}`]),
      ...(api?.status === undefined ? [] : [`status=${api.status}`]),
      ...(api?.code === undefined ? [] : [`code=${api.code}`]),
      ...(api?.requestId === undefined ? [] : [`requestId=${stepText(api.requestId)}`]),
      ...(api?.details === undefined ? [] : [`details=${stepText(JSON.stringify(api.details))}`]),
    ];
    super(`${message}${api?.status === 401 ? " Run daynight login to authenticate." : ""}\n${context.join(" ")}`,
      cause instanceof UsageError ? 2 : 1, { cause });
    this.name = "StepReadCommandError";
  }
}

export const stepOperationLabel = (operation: StepWriteOperation): string => operation === "add" ? "Add" : operation === "update" ? "Update" : operation === "move" ? "Move" : "Set-status";
export const stepConfirmedMessage = (operation: StepWriteOperation, stepId: string): string => `${operation === "add" ? "Step added." : operation === "update" ? "Step updated." : operation === "move" ? "Step moved." : "Step status set."} ID: ${stepId}`;

export class StepWriteCommandError extends PublicDiagnosticError {
  constructor(cause: unknown, phase: ReadPhase, projectId?: string, taskId?: string, stepId?: string, confirmed?: StepWriteAttempt, requestedOperation: StepWriteOperation = "add") {
    const failure = findStepWriteFailure(cause);
    const attempt = confirmed === undefined ? failure?.attempt : confirmed;
    const operation = attempt?.operation ?? requestedOperation;
    const label = stepOperationLabel(operation);
    const outcome = confirmed !== undefined ? "confirmed" : failure === undefined ? "failed" : failure.outcome;
    const discovery = projectDiscoveryFailure(cause);
    const api = attempt === undefined ? discovery === undefined ? apiFailure(cause) : undefined
      : stepApiFailures(cause).find((error) => error.operation === `task.step.${operation}` && error.sentRequestId === attempt.requestId);
    const message = outcome === "unknown" ? `The Step ${label} outcome is unknown.`
      : outcome === "confirmed" ? `${stepConfirmedMessage(operation, attempt!.stepId)}\nThe Step is confirmed, but local result handling failed.`
      : ordinaryStepMessage(cause, operation, phase, api);
    const context = ["source=cli", `operation=task.step.${operation}`, `phase=${api?.phase ?? phase}`, `outcome=${outcome}`,
      ...(projectId === undefined && attempt === undefined ? [] : [`projectId=${attempt === undefined ? projectId : attempt.projectId}`]),
      ...(taskId === undefined && attempt === undefined ? [] : [`taskId=${attempt === undefined ? taskId : attempt.taskId}`]),
      ...(stepId === undefined && attempt === undefined ? [] : [`stepId=${attempt === undefined ? stepId : attempt.stepId}`]),
      ...(attempt === undefined ? [] : [`requestId=${attempt.requestId}`]),
      ...(api?.status === undefined ? [] : [`status=${api.status}`]),
      ...(api?.code === undefined ? [] : [`code=${api.code}`]),
      ...(api?.requestId === undefined ? [] : [`serverRequestId=${stepText(api.requestId)}`]),
      ...(api?.responseRequestId === undefined ? [] : [`responseRequestId=${stepText(api.responseRequestId)}`]),
      ...(api?.details === undefined ? [] : [`details=${stepText(JSON.stringify(api.details))}`]),
      ...(failure?.recoveryAttempted === true ? [`recoveryRequestId=${failure.attempt.requestId}.r1`] : []),
    ];
    const observation = outcome !== "unknown" ? "" : failure?.observation === undefined ? "\nNo current observation is available."
      : `\nCurrent facts only: version=${failure.observation.version} target=${failure.observation.found ? "found" : "absent"}. The ${label} outcome remains unknown.`;
    const guidance = outcome !== "unknown" || attempt === undefined ? ""
      : `\nRead current Steps: daynight task step list ${attempt.taskId} --project ${attempt.projectId}\nInspect the original ID: daynight task step show ${attempt.taskId} ${attempt.stepId} --project ${attempt.projectId}`;
    super(`${message}${api?.status === 401 ? " Run daynight login to authenticate." : ""}\n${context.join(" ")}${observation}${guidance}`,
      cause instanceof UsageError ? 2 : 1, { cause });
    this.name = "StepWriteCommandError";
  }
}
