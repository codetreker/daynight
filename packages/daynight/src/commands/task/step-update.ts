import { parseVersionArgument } from "../../api/json.js";
import { canonicalStepId } from "../../api/task-steps.js";
import type { TaskStepStatus } from "../../api/types.js";
import { canonicalId } from "../../api/validation.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { isNonemptyText, isText } from "../../platform/text.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import type { TaskCommandDependencies } from "./command.js";
import { StepWriteCommandError, stepConfirmedMessage } from "./step-diagnostics.js";
import { renderTaskSteps, renderTaskStepsJson, stepText } from "./step-rendering.js";
import { setStepStatus, updateStep } from "./step-write.js";
import type { StepStatusDraft, StepUpdateDraft } from "./step-write.js";
import type { StepWriteAttempt } from "./step-write-errors.js";

type Command = Extract<ParsedCommand, { readonly kind: "run" }>;
type Edit = { readonly operation: "update"; readonly draft: StepUpdateDraft } | { readonly operation: "set-status"; readonly draft: StepStatusDraft };

export const compileStepUpdate = (command: Command): Edit & { readonly taskId: string; readonly projectId?: string; readonly stepId: string } => {
  const help = `${command.path.join(" ")} --help`;
  const taskId = canonicalId(command.values[0]!);
  if (taskId === null) throw new UsageError("task-id must be a hyphenated UUID.", help);
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const stepId = canonicalStepId(command.values[1]!);
  if (stepId === null) throw new UsageError("step-id must contain exactly eight hexadecimal characters.", help);
  const rawVersion = command.options.get("--if-version") as string | undefined;
  let version: bigint | undefined;
  if (rawVersion !== undefined) {
    try { version = parseVersionArgument(rawVersion); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : "Version must be a positive int64.", help); }
  }
  const identity = { taskId, stepId, ...(projectId === undefined ? {} : { projectId }) };
  const versionField = version === undefined ? {} : { version };
  if (command.command.name === "set-status") {
    const status = command.values[2] as TaskStepStatus;
    if (!["todo", "in_progress", "done", "skipped"].includes(status)) throw new UsageError("Step status must be todo, in_progress, done or skipped.", help);
    return Object.freeze({ ...identity, operation: "set-status", draft: Object.freeze({ ...versionField, status }) });
  }
  const title = command.options.get("--title") as string | undefined;
  const description = command.options.get("--description") as string | undefined;
  if (title === undefined && description === undefined) throw new UsageError("Provide --title or --description to update a Step.", help);
  if (title !== undefined && !isNonemptyText(title)) throw new UsageError("Step title must be nonempty UTF-8 text without NUL characters.", help);
  if (description !== undefined && !isText(description)) throw new UsageError("Step description must be UTF-8 text without NUL characters.", help);
  return Object.freeze({ ...identity, operation: "update", draft: Object.freeze({ ...versionField,
    ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }),
  }) });
};

export const runTaskStepUpdateCommand = async (command: Command, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  let projectId: string | undefined, taskId: string | undefined, stepId: string | undefined;
  let confirmed: StepWriteAttempt | undefined;
  let phase: "prepare" | "request" | "render" | "output" = "prepare";
  const operation = command.command.name as "update" | "set-status";
  try {
    const input = compileStepUpdate(command);
    projectId = input.projectId; taskId = input.taskId; stepId = input.stepId;
    await dependencies.runServerCommand(context, async (session) => {
      session.operation.check();
      if (projectId === undefined) projectId = (await dependencies.resolveProject({ ...session, workingDirectory: context.workingDirectory() })).id;
      session.operation.check();
      phase = "request";
      const result = input.operation === "update"
        ? await updateStep(session, projectId, input.taskId, input.stepId, input.draft)
        : await setStepStatus(session, projectId, input.taskId, input.stepId, input.draft);
      confirmed = result.attempt;
      phase = "render";
      const check = () => session.operation.check();
      const output = command.options.has("--json") ? renderTaskStepsJson(result.resource, check)
        : `${stepConfirmedMessage(operation, stepText(input.stepId))}\n${renderTaskSteps(result.resource, check)}`;
      phase = "output";
      return { kind: "confirmed-mutation", output,
        failureText: (failedPhase) => `${stepConfirmedMessage(operation, input.stepId)}\nThe Step is confirmed, but local ${failedPhase} failed.\nprojectId=${projectId} taskId=${input.taskId} stepId=${input.stepId} requestId=${result.attempt.requestId}`,
      };
    });
  } catch (cause) {
    if (confirmed !== undefined && cause instanceof PublicDiagnosticError) throw cause;
    throw new StepWriteCommandError(cause, phase, projectId, taskId, stepId, confirmed, operation);
  }
};
