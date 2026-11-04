import { randomUUID } from "node:crypto";
import type { AddTaskStepInput, UpdateTaskStepInput, SetTaskStepStatusInput, MoveTaskStepInput, StepsResource } from "../../api/types.js";
import { OperationError } from "../../api/operation.js";
import type { ServerSession } from "../server/runtime.js";
import { StepWriteFailure, stepApiFailures } from "./step-write-errors.js";
import type { StepAddAttempt, StepWriteAttempt, StepUpdateAttempt, StepStatusAttempt, StepMoveAttempt, StepCurrentObservation } from "./step-write-errors.js";

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
  const attempt = Object.freeze({ operation: "add" as const, projectId, taskId, stepId: payload.id, requestId: randomUUID(), payload });
  return executeStepWrite(session, attempt, () => api.addTaskStep(projectId, taskId, payload, { requestId: attempt.requestId, ...(previous === undefined ? {} : { previous }) }));
};

export type StepUpdateDraft = Omit<UpdateTaskStepInput, "version"> & { readonly version?: bigint };
export type StepStatusDraft = Omit<SetTaskStepStatusInput, "version"> & { readonly version?: bigint };

export const updateStep = async (session: ServerSession, projectId: string, taskId: string, stepId: string, draft: StepUpdateDraft) => {
  const { api, operation } = session;
  operation.check();
  const previous = draft.version === undefined ? await api.listTaskSteps(projectId, taskId) : undefined;
  operation.check();
  const payload: UpdateTaskStepInput = Object.freeze({ version: draft.version === undefined ? previous!.version : draft.version,
    ...(draft.title === undefined ? {} : { title: draft.title }),
    ...(draft.description === undefined ? {} : { description: draft.description }),
  });
  const attempt: StepUpdateAttempt = Object.freeze({ operation: "update", projectId, taskId, stepId, requestId: randomUUID(), payload });
  return executeStepWrite(session, attempt, () => api.updateTaskStep(projectId, taskId, stepId, payload, { requestId: attempt.requestId, ...(previous === undefined ? {} : { previous }) }));
};

export const setStepStatus = async (session: ServerSession, projectId: string, taskId: string, stepId: string, draft: StepStatusDraft) => {
  const { api, operation } = session;
  operation.check();
  const previous = draft.version === undefined ? await api.listTaskSteps(projectId, taskId) : undefined;
  operation.check();
  const payload: SetTaskStepStatusInput = Object.freeze({ version: draft.version === undefined ? previous!.version : draft.version, status: draft.status });
  const attempt: StepStatusAttempt = Object.freeze({ operation: "set-status", projectId, taskId, stepId, requestId: randomUUID(), payload });
  return executeStepWrite(session, attempt, () => api.setTaskStepStatus(projectId, taskId, stepId, payload, { requestId: attempt.requestId, ...(previous === undefined ? {} : { previous }) }));
};

export type StepMoveDraft = Omit<MoveTaskStepInput, "version"> & { readonly version?: bigint };
export const moveStep = async (session: ServerSession, projectId: string, taskId: string, stepId: string, draft: StepMoveDraft): Promise<{ readonly attempt: StepMoveAttempt; readonly resource: StepsResource }> => {
  const { api, operation } = session;
  operation.check();
  const previous = draft.version === undefined ? await api.listTaskSteps(projectId, taskId) : undefined;
  operation.check();
  const payload: MoveTaskStepInput = Object.freeze({ ...draft, version: draft.version === undefined ? previous!.version : draft.version });
  const attempt: StepMoveAttempt = Object.freeze({ projectId, taskId, stepId, requestId: randomUUID(), payload, operation: "move" });
  return executeStepWrite(session, attempt, () => api.moveTaskStep(projectId, taskId, stepId, payload, { requestId: attempt.requestId, ...(previous === undefined ? {} : { previous }) }));
};

const executeStepWrite = async <T extends StepWriteAttempt>(session: ServerSession, attempt: T, write: () => Promise<StepsResource>): Promise<{ readonly attempt: T; readonly resource: StepsResource }> => {
  const { api, operation } = session;
  const { projectId, taskId } = attempt;
  try {
    const resource = await write();
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
      const current = await api.listTaskSteps(projectId, taskId, { requestId: `${attempt.requestId}.r1` });
      operation.check();
      observation = Object.freeze({ version: current.version, found: current.steps.some((step) => step.id === attempt.stepId) });
    } catch (recoveryCause) {
      failure = new AggregateError([cause, recoveryCause], `Step ${attempt.operation} and its current-state observation failed.`);
    }
    throw new StepWriteFailure("unknown", attempt, failure, observation, recoveryAttempted);
  }
};
