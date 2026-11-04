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
import { moveStep } from "./step-write.js";
import type { StepMoveDraft } from "./step-write.js";
import type { StepMoveAttempt } from "./step-write-errors.js";

type Command = Extract<ParsedCommand, { readonly kind: "run" }>;
export const compileStepMove = (command: Command): { readonly taskId: string; readonly projectId?: string; readonly stepId: string; readonly draft: StepMoveDraft } => {
  const help = `${command.path.join(" ")} --help`;
  const taskId = canonicalId(command.values[0]!);
  if (taskId === null) throw new UsageError("task-id must be a hyphenated UUID.", help);
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const stepId = canonicalStepId(command.values[1]!);
  if (stepId === null) throw new UsageError("step-id must contain exactly eight hexadecimal characters.", help);
  const positions = ["--before", "--after", "--first", "--last"].filter((option) => command.options.has(option));
  if (positions.length !== 1) throw new UsageError("Exactly one of --before, --after, --first or --last is required.", help);
  const selected = positions[0]!;
  const rawAnchor = command.options.get(selected);
  const anchor = selected === "--before" || selected === "--after" ? canonicalStepId(rawAnchor as string) : undefined;
  if (anchor === null) throw new UsageError("Step anchor must contain exactly eight hexadecimal characters.", help);
  if (anchor === stepId) throw new UsageError("A Step cannot be moved relative to itself.", help);
  const rawVersion = command.options.get("--if-version") as string | undefined;
  let version: bigint | undefined;
  if (rawVersion !== undefined) {
    try { version = parseVersionArgument(rawVersion); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : "Version must be a positive int64.", help); }
  }
  const draft: StepMoveDraft = Object.freeze({
    ...(selected === "--before" ? { before: anchor! } : selected === "--after" ? { after: anchor! } : { position: selected === "--first" ? "first" as const : "last" as const }),
    ...(version === undefined ? {} : { version }),
  });
  return Object.freeze({ taskId, stepId, ...(projectId === undefined ? {} : { projectId }), draft });
};

export const runTaskStepMoveCommand = async (command: Command, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  let projectId: string | undefined, taskId: string | undefined, stepId: string | undefined;
  let confirmed: StepMoveAttempt | undefined;
  let phase: "prepare" | "request" | "render" | "output" = "prepare";
  try {
    const input = compileStepMove(command);
    projectId = input.projectId; taskId = input.taskId; stepId = input.stepId;
    await dependencies.runServerCommand(context, async (session) => {
      session.operation.check();
      if (projectId === undefined) projectId = (await dependencies.resolveProject({ ...session, workingDirectory: context.workingDirectory() })).id;
      session.operation.check();
      phase = "request";
      const result = await moveStep(session, projectId, input.taskId, input.stepId, input.draft);
      confirmed = result.attempt;
      phase = "render";
      const check = () => session.operation.check();
      const output = command.options.has("--json") ? renderTaskStepsJson(result.resource, check)
        : `Step moved. ID: ${stepText(input.stepId)}\n${renderTaskSteps(result.resource, check)}`;
      phase = "output";
      return { kind: "confirmed-mutation", output,
        failureText: (failedPhase) => `Step moved. ID: ${input.stepId}\nThe Step is confirmed, but local ${failedPhase} failed.\nprojectId=${projectId} taskId=${input.taskId} stepId=${input.stepId} requestId=${result.attempt.requestId}`,
      };
    });
  } catch (cause) {
    if (confirmed !== undefined && cause instanceof PublicDiagnosticError) throw cause;
    throw new StepWriteCommandError(cause, phase, projectId, taskId, stepId, confirmed, "move");
  }
};
