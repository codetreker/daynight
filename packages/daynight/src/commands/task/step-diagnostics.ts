import { ApiError } from "../../api/client.js";
import { OperationError } from "../../api/operation.js";
import { UsageError } from "../../cli/context.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { ProjectDiscoveryError } from "../../repository/discovery-error.js";
import { stepText } from "./step-rendering.js";

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

export class StepReadCommandError extends PublicDiagnosticError {
  constructor(cause: unknown, operation: "list" | "show", phase: ReadPhase, projectId?: string, taskId?: string, stepId?: string) {
    const discovery = projectDiscoveryFailure(cause);
    const api = discovery === undefined ? apiFailure(cause) : undefined;
    const operationFailure = api?.cause instanceof OperationError ? api.cause : cause instanceof OperationError ? cause : undefined;
    const message = cause instanceof UsageError ? `${cause.message} Run ${cause.helpCommand} for usage.`
      : discovery !== undefined ? discoveryMessage(discovery)
      : api?.serverMessage !== undefined ? `${api.code}: ${stepText(api.serverMessage)}`
      : operationFailure !== undefined ? operationFailure.message
      : phase === "prepare" ? "Could not prepare the Steps read. Check configuration and authentication; run daynight login if needed."
      : `Steps ${operation} failed.`;
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
