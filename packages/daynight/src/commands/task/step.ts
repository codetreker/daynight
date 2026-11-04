import { canonicalId } from "../../api/validation.js";
import { canonicalStepId } from "../../api/task-steps.js";
import type { CliContext } from "../../cli/context.js";
import { UsageError } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import type { TaskCommandDependencies } from "./command.js";
import { StepReadCommandError } from "./step-diagnostics.js";
import { renderTaskStep, renderTaskSteps, renderTaskStepsJson } from "./step-rendering.js";

type Command = Extract<ParsedCommand, { readonly kind: "run" }>;
const fullId = (value: string, label: string, help: string): string => {
  const parsed = canonicalId(value);
  if (parsed === null) throw new UsageError(`${label} must be a hyphenated UUID.`, help);
  return parsed;
};

export const runTaskStepCommand = async (command: Command, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  if (command.command.name === "add") {
    const { runTaskStepAddCommand } = await import("./step-add.js");
    await runTaskStepAddCommand(command, context, dependencies);
    return;
  }
  if (command.command.name === "update" || command.command.name === "set-status") {
    const { runTaskStepUpdateCommand } = await import("./step-update.js");
    await runTaskStepUpdateCommand(command, context, dependencies);
    return;
  }
  const name = command.command.name as "list" | "show";
  let projectId: string | undefined, taskId: string | undefined, stepId: string | undefined;
  let phase: "prepare" | "request" | "render" | "output" = "prepare";
  try {
    const help = `${command.path.join(" ")} --help`;
    taskId = fullId(command.values[0]!, "task-id", help);
    const project = command.options.get("--project") as string | undefined;
    if (project !== undefined) projectId = fullId(project, "project-id", help);
    if (name === "show") {
      const parsed = canonicalStepId(command.values[1]!);
      if (parsed === null) throw new UsageError("step-id must contain exactly eight hexadecimal characters.", help);
      stepId = parsed;
    }
    await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
      operation.check();
      if (projectId === undefined) projectId = (await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })).id;
      operation.check();
      phase = "request";
      const resource = name === "list" ? await api.listTaskSteps(projectId, taskId!) : await api.getTaskStep(projectId, taskId!, stepId!);
      operation.check();
      phase = "render";
      const check = () => operation.check();
      const output = command.options.has("--json") ? renderTaskStepsJson(resource, check)
        : "steps" in resource ? renderTaskSteps(resource, check) : renderTaskStep(resource, check);
      operation.check();
      phase = "output";
      await context.stdoutBytes(Buffer.from(output, "utf8"), operation.signal);
    });
  } catch (cause) {
    throw new StepReadCommandError(cause, name, phase, projectId, taskId, stepId);
  }
};
