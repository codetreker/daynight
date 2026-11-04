import { parseVersionArgument } from "../../api/json.js";
import { canonicalStepId } from "../../api/task-steps.js";
import { canonicalId } from "../../api/validation.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import type { TaskCommandDependencies } from "./command.js";
import { StepWriteCommandError } from "./step-diagnostics.js";
import { renderTaskSteps, renderTaskStepsJson, stepText } from "./step-rendering.js";
import { deleteStep } from "./step-write.js";
import type { StepDeleteAttempt } from "./step-write-errors.js";

type Command = Extract<ParsedCommand, { readonly kind: "run" }>;

const compileStepDelete = (command: Command) => {
  const help = `${command.path.join(" ")} --help`;
  const taskId = canonicalId(command.values[0]!);
  if (taskId === null) throw new UsageError("task-id must be a hyphenated UUID.", help);
  const stepId = canonicalStepId(command.values[1]!);
  if (stepId === null) throw new UsageError("step-id must contain exactly eight hexadecimal characters.", help);
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const rawVersion = command.options.get("--if-version") as string | undefined;
  let version: bigint | undefined;
  if (rawVersion !== undefined) {
    try { version = parseVersionArgument(rawVersion); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : "Version must be a positive int64.", help); }
  }
  return { taskId, stepId, projectId, version };
};

export const runTaskStepDeleteCommand = async (command: Command, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  let projectId: string | undefined, taskId: string | undefined, stepId: string | undefined;
  let confirmed: StepDeleteAttempt | undefined;
  let phase: "prepare" | "request" | "render" | "output" = "prepare";
  try {
    const input = compileStepDelete(command);
    projectId = input.projectId; taskId = input.taskId; stepId = input.stepId;
    await dependencies.runServerCommand(context, async (session) => {
      session.operation.check();
      if (projectId === undefined) projectId = (await dependencies.resolveProject({ ...session, workingDirectory: context.workingDirectory() })).id;
      session.operation.check();
      phase = "request";
      const result = await deleteStep(session, projectId, input.taskId, input.stepId, input.version);
      confirmed = result.attempt;
      phase = "render";
      const check = () => session.operation.check();
      const output = command.options.has("--json") ? renderTaskStepsJson(result.resource, check)
        : `Step deleted. ID: ${stepText(result.attempt.stepId)}\n${renderTaskSteps(result.resource, check)}`;
      phase = "output";
      return { kind: "confirmed-mutation", output,
        failureText: (failedPhase) => `Step deleted. ID: ${result.attempt.stepId}\nThe deletion is confirmed, but local ${failedPhase} failed.\nprojectId=${projectId} taskId=${input.taskId} stepId=${result.attempt.stepId} requestId=${result.attempt.requestId}`,
      };
    });
  } catch (cause) {
    if (confirmed !== undefined && cause instanceof PublicDiagnosticError) throw cause;
    throw new StepWriteCommandError(cause, phase, projectId, taskId, stepId, confirmed, "delete");
  }
};
