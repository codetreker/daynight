import { ApiError } from "../../api/client.js";
import type { AddTaskStepInput } from "../../api/types.js";

export type StepAddAttempt = {
  readonly projectId: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly payload: AddTaskStepInput;
};
export type StepCurrentObservation = { readonly version: bigint; readonly found: boolean };
export type StepWriteOutcome = "failed" | "refused" | "unknown" | "confirmed";

export class StepWriteFailure extends Error {
  constructor(
    readonly outcome: StepWriteOutcome,
    readonly attempt: StepAddAttempt,
    cause: unknown,
    readonly observation?: StepCurrentObservation,
    readonly recoveryAttempted = false,
  ) {
    super("Step Add did not complete its local result handling.", { cause });
    this.name = "StepWriteFailure";
  }
}

export const stepApiFailures = (cause: unknown, seen = new Set<unknown>()): ApiError[] => {
  if (!(cause instanceof Error) || seen.has(cause)) return [];
  seen.add(cause);
  return [...(cause instanceof ApiError ? [cause] : []),
    ...(cause instanceof AggregateError ? cause.errors.flatMap((child: unknown) => stepApiFailures(child, seen)) : []),
    ...stepApiFailures(cause.cause, seen)];
};

export const findStepWriteFailure = (cause: unknown, seen = new Set<unknown>()): StepWriteFailure | undefined => {
  if (!(cause instanceof Error) || seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof StepWriteFailure) return cause;
  if (cause instanceof AggregateError) {
    for (const child of cause.errors as readonly unknown[]) {
      const failure = findStepWriteFailure(child, seen);
      if (failure !== undefined) return failure;
    }
  }
  return findStepWriteFailure(cause.cause, seen);
};
