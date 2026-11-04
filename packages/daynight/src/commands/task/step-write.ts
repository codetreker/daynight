import { randomUUID } from "node:crypto";
import type { AddTaskStepInput, StepsResource } from "../../api/types.js";
import { OperationError } from "../../api/operation.js";
import type { ServerSession } from "../server/runtime.js";
import { StepWriteFailure, stepApiFailures } from "./step-write-errors.js";
import type { StepAddAttempt, StepCurrentObservation } from "./step-write-errors.js";

export type StepAddDraft = Omit<AddTaskStepInput, "version"> & { readonly version?: bigint };
export type StepAddResult = { readonly attempt: StepAddAttempt; readonly resource: StepsResource };

export const addStep = async (session: ServerSession, projectId: string, taskId: string, draft: StepAddDraft): Promise<StepAddResult> => {
  const { api, operation } = session;
  operation.check();
  const previous = draft.version === undefined ? await api.listTaskSteps(projectId, taskId) : undefined;
  operation.check();
  const version = draft.version === undefined ? previous!.version : draft.version;
  const payload: AddTaskStepInput = Object.freeze({ version, id: draft.id, title: draft.title,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.status === undefined ? {} : { status: draft.status }),
    ...(draft.before === undefined ? {} : { before: draft.before }),
    ...(draft.after === undefined ? {} : { after: draft.after }),
  });
  const attempt = Object.freeze({ projectId, taskId, stepId: payload.id, requestId: randomUUID(), payload });
  try {
    const resource = await api.addTaskStep(projectId, taskId, payload, { requestId: attempt.requestId, ...(previous === undefined ? {} : { previous }) });
    return { attempt, resource };
  } catch (cause) {
    const failures = stepApiFailures(cause).filter((error) => error.operation === "task.step.add" && error.sentRequestId === attempt.requestId);
    if (failures.some((error) => error.confirmedMutationId === attempt.stepId)) throw new StepWriteFailure("confirmed", attempt, cause);
    if (failures.some((error) => error.confirmedRefusal)) throw new StepWriteFailure("refused", attempt, cause);
    if (!failures.some((error) => error.outcomeUnconfirmed)) throw new StepWriteFailure("failed", attempt, cause);
    let observation: StepCurrentObservation | undefined;
    let recoveryAttempted = false;
    let failure = cause;
    try {
      operation.check();
      if (operation.remainingBytes() === 0) throw new OperationError("total_limit");
      recoveryAttempted = true;
      const current = await api.listTaskSteps(projectId, taskId, { requestId: `${attempt.requestId}.r1` });
      operation.check();
      observation = Object.freeze({ version: current.version, found: current.steps.some((step) => step.id === attempt.stepId) });
    } catch (recoveryCause) {
      failure = new AggregateError([cause, recoveryCause], "Step Add and its current-state observation failed.");
    }
    throw new StepWriteFailure("unknown", attempt, failure, observation, recoveryAttempted);
  }
};
