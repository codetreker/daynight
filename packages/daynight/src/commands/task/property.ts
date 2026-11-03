import { parseVersionArgument, stringifyApiJson } from "../../api/json.js";
import { canonicalId } from "../../api/parse.js";
import type { CliContext } from "../../cli/context.js";
import { UsageError } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import type { TaskCommandDependencies } from "./command.js";
import { renderTaskPropertyResource, renderTaskPropertySchema } from "./rendering.js";

export const runTaskPropertyCommand = async (
  command: Extract<ParsedCommand, { readonly kind: "run" }>,
  context: CliContext,
  dependencies: TaskCommandDependencies,
): Promise<void> => {
  const help = `${command.path.join(" ")} --help`;
  const name = command.command.name;
  const schema = command.options.has("--schema");
  const rawProject = command.options.get("--project") as string | undefined;
  if (name === "properties" && (schema === (command.values.length > 0) || schema && rawProject !== undefined)) throw new UsageError("Use either a task ID or --schema; --schema does not accept --project.", help);
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const taskId = schema ? undefined : canonicalId(command.values[0]!);
  if (taskId === null) throw new UsageError("task-id must be a hyphenated UUID.", help);
  const rawVersion = command.options.get("--if-version") as string | undefined;
  let expectedVersion: bigint | undefined;
  if (rawVersion !== undefined) {
    try { expectedVersion = parseVersionArgument(rawVersion); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : String(cause), help); }
  }
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    operation.check();
    if (schema) {
      const result = await api.getTaskPropertySchema();
      operation.check();
      return command.options.has("--json") ? `${stringifyApiJson(result)}\n` : renderTaskPropertySchema(result);
    }
    const project = projectId === undefined ? (await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })).id : projectId;
    operation.check();
    if (name === "properties") {
      const result = await api.getTaskProperties(project, taskId!);
      operation.check();
      return command.options.has("--json") ? `${stringifyApiJson(result)}\n` : renderTaskPropertyResource(result);
    }
    const version = expectedVersion === undefined ? (await api.getTaskProperties(project, taskId!)).version : expectedVersion;
    operation.check();
    const result = name === "set-property"
      ? await api.setTaskProperty(project, taskId!, command.values[1]!, { version, valueText: command.values[2]! })
      : await api.removeTaskProperty(project, taskId!, command.values[1]!, { version });
    operation.check();
    return `${name === "set-property" ? "Task property set." : "Task property removed."}\n${renderTaskPropertyResource(result)}`;
  });
};
