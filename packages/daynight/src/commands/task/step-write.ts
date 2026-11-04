import { randomUUID } from "node:crypto";
import type { AddTaskStepInput, MoveTaskStepInput, StepsResource } from "../../api/types.js";
import { OperationError } from "../../api/operation.js";
import type { ServerSession } from "../server/runtime.js";
import { StepWriteFailure, stepApiFailures } from "./step-write-errors.js";
import type { StepAddAttempt, StepDeleteAttempt, StepMoveAttempt, StepWriteAttempt, StepCurrentObservation } from "./step-write-errors.js";

export type StepAddDraft = Omit<AddTaskStepInput, "version"> & { readonly version?: bigint };
export type StepAddResult = { readonly attempt: StepAddAttempt; readonly resource: StepsResource };

const prepareStepWrite = async (session: ServerSession, projectId: string, taskId: string, explicitVersion?: bigint) => {
  session.operation.check();
  const previous = explicitVersion === undefined ? await session.api.listTaskSteps(projectId, taskId) : undefined;
  session.operation.check();
  return { previous, version: explicitVersion === undefined ? previous!.version : explicitVersion, requestId: randomUUID() };
};

export const addStep = async (session: ServerSession, projectId: string, taskId: string, draft: StepAddDraft): Promise<StepAddResult> => {
  const { previous, version, requestId } = await prepareStepWrite(session, projectId, taskId, draft.version);
  const payload: AddTaskStepInput = Object.freeze({ version, id: draft.id, title: draft.title,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.status === undefined ? {} : { status: draft.status }),
    ...(draft.before === undefined ? {} : { before: draft.before }),
    ...(draft.after === undefined ? {} : { after: draft.after }),
  });
  const attempt = Object.freeze({ operation: "add" as const, projectId, taskId, stepId: payload.id, requestId, payload });
  return performStepWrite(session, attempt, () => session.api.addTaskStep(projectId, taskId, payload, { requestId, ...(previous === undefined ? {} : { previous }) }));
};

export const deleteStep = async (session: ServerSession, projectId: string, taskId: string, stepId: string, explicitVersion?: bigint): Promise<{ readonly attempt: StepDeleteAttempt; readonly resource: StepsResource }> => {
  const { previous, version, requestId } = await prepareStepWrite(session, projectId, taskId, explicitVersion);
  const payload = Object.freeze({ version });
  const attempt = Object.freeze({ operation: "delete" as const, projectId, taskId, stepId, requestId, payload });
  return performStepWrite(session, attempt, () => session.api.deleteTaskStep(projectId, taskId, stepId, payload, { requestId, ...(previous === undefined ? {} : { previous }) }));
};

export type StepMoveDraft = Omit<MoveTaskStepInput, "version"> & { readonly version?: bigint };
export const moveStep = async (session: ServerSession, projectId: string, taskId: string, stepId: string, draft: StepMoveDraft): Promise<{ readonly attempt: StepMoveAttempt; readonly resource: StepsResource }> => {
  const { previous, version, requestId } = await prepareStepWrite(session, projectId, taskId, draft.version);
  const payload: MoveTaskStepInput = Object.freeze({ ...draft, version });
  const attempt = Object.freeze({ operation: "move" as const, projectId, taskId, stepId, requestId, payload });
  return performStepWrite(session, attempt, () => session.api.moveTaskStep(projectId, taskId, stepId, payload, { requestId, ...(previous === undefined ? {} : { previous }) }));
};

const performStepWrite = async <Attempt extends StepWriteAttempt>(session: ServerSession, attempt: Attempt, submit: () => Promise<StepsResource>): Promise<{ readonly attempt: Attempt; readonly resource: StepsResource }> => {
  const { api, operation } = session;
  try {
    const resource = await submit();
    return { attempt, resource };
  } catch (cause) {
    const failures = stepApiFailures(cause).filter((error) => error.operation === `task.step.${attempt.operation}` && error.sentRequestId === attempt.requestId);
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
      const current = await api.listTaskSteps(attempt.projectId, attempt.taskId, { requestId: `${attempt.requestId}.r1` });
      operation.check();
      observation = Object.freeze({ version: current.version, found: current.steps.some((step) => step.id === attempt.stepId) });
    } catch (recoveryCause) {
      failure = new AggregateError([cause, recoveryCause], `Step ${attempt.operation} and its current-state observation failed.`);
    }
    throw new StepWriteFailure("unknown", attempt, failure, observation, recoveryAttempted);
  }
};
