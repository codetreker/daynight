import { randomUUID } from "node:crypto";
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
import { StepWriteCommandError } from "./step-diagnostics.js";
import { renderTaskSteps, renderTaskStepsJson, stepText } from "./step-rendering.js";
import { addStep } from "./step-write.js";
import type { StepAddDraft } from "./step-write.js";
import type { StepAddAttempt } from "./step-write-errors.js";

type Command = Extract<ParsedCommand, { readonly kind: "run" }>;
const inputId = (value: string, label: string, help: string): string => {
  const parsed = canonicalStepId(value);
  if (parsed === null) throw new UsageError(`${label} must contain exactly eight hexadecimal characters.`, help);
  return parsed;
};

export const compileStepAdd = (command: Command): { readonly taskId: string; readonly projectId?: string; readonly draft: StepAddDraft } => {
  const help = `${command.path.join(" ")} --help`;
  const taskId = canonicalId(command.values[0]!);
  if (taskId === null) throw new UsageError("task-id must be a hyphenated UUID.", help);
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const title = command.options.get("--title") as string;
  if (!isNonemptyText(title)) throw new UsageError("Step title must be nonempty UTF-8 text without NUL characters.", help);
  const description = command.options.get("--description") as string | undefined;
  if (description !== undefined && !isText(description)) throw new UsageError("Step description must be UTF-8 text without NUL characters.", help);
  const status = command.options.get("--status") as TaskStepStatus | undefined;
  if (status !== undefined && !["todo", "in_progress", "done", "skipped"].includes(status)) throw new UsageError("Step status must be todo, in_progress, done or skipped.", help);
  const rawBefore = command.options.get("--before") as string | undefined, rawAfter = command.options.get("--after") as string | undefined;
  if (rawBefore !== undefined && rawAfter !== undefined) throw new UsageError("--before and --after are mutually exclusive.", help);
  const before = rawBefore === undefined ? undefined : inputId(rawBefore, "before", help);
  const after = rawAfter === undefined ? undefined : inputId(rawAfter, "after", help);
  const rawId = command.options.get("--id") as string | undefined;
  const explicitId = rawId === undefined ? undefined : inputId(rawId, "step-id", help);
  const rawVersion = command.options.get("--if-version") as string | undefined;
  let version: bigint | undefined;
  if (rawVersion !== undefined) {
    try { version = parseVersionArgument(rawVersion); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : "Version must be a positive int64.", help); }
  }
  const draft = Object.freeze({ id: explicitId === undefined ? randomUUID().split("-")[0]! : explicitId, title,
    ...(description === undefined ? {} : { description }), ...(status === undefined ? {} : { status }),
    ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), ...(version === undefined ? {} : { version }),
  });
  return Object.freeze({ taskId, ...(projectId === undefined ? {} : { projectId }), draft });
};

export const runTaskStepAddCommand = async (command: Command, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  let projectId: string | undefined, taskId: string | undefined, stepId: string | undefined;
  let confirmed: StepAddAttempt | undefined;
  let phase: "prepare" | "request" | "render" | "output" = "prepare";
  try {
    const input = compileStepAdd(command);
    projectId = input.projectId; taskId = input.taskId; stepId = input.draft.id;
    await dependencies.runServerCommand(context, async (session) => {
      session.operation.check();
      if (projectId === undefined) projectId = (await dependencies.resolveProject({ ...session, workingDirectory: context.workingDirectory() })).id;
      session.operation.check();
      phase = "request";
      const result = await addStep(session, projectId, input.taskId, input.draft);
      confirmed = result.attempt;
      phase = "render";
      const check = () => session.operation.check();
      const output = command.options.has("--json") ? renderTaskStepsJson(result.resource, check)
        : `Step added. ID: ${stepText(result.attempt.stepId)}\n${renderTaskSteps(result.resource, check)}`;
      phase = "output";
      return { kind: "confirmed-mutation", output,
        failureText: (failedPhase) => `Step added. ID: ${result.attempt.stepId}\nThe Step is confirmed, but local ${failedPhase} failed.\nprojectId=${projectId} taskId=${input.taskId} stepId=${result.attempt.stepId} requestId=${result.attempt.requestId}`,
      };
    });
  } catch (cause) {
    if (confirmed !== undefined && cause instanceof PublicDiagnosticError) throw cause;
    throw new StepWriteCommandError(cause, phase, projectId, taskId, stepId, confirmed);
  }
};
