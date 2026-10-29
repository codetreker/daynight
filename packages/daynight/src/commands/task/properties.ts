import { parseVersionArgument } from "../../api/json.js";
import { canonicalId, ProtocolError } from "../../api/parse.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import type { TaskCommandDependencies } from "./command.js";

const resourceVersion = (source: string): bigint => {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string") throw new ProtocolError("The properties resource must contain a decimal task version string.");
  return parseVersionArgument(value.version);
};

export const runTaskPropertiesCommand = async (
  command: Extract<ParsedCommand, { kind: "run" }>,
  context: CliContext,
  dependencies: TaskCommandDependencies,
): Promise<void> => {
  const help = `${command.path.join(" ")} --help`;
  const taskId = canonicalId(command.values[0]!);
  if (taskId === null) throw new UsageError("task-id must be a hyphenated UUID.", help);
  const rawProjectId = command.options.get("--project") as string | undefined;
  const projectId = rawProjectId === undefined ? undefined : canonicalId(rawProjectId);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const versionArgument = command.options.get("--if-version") as string | undefined;
  let version: bigint | undefined;
  if (versionArgument !== undefined) {
    try { version = parseVersionArgument(versionArgument); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : String(cause), help); }
  }
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    operation.check();
    const project = projectId === undefined
      ? await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })
      : await api.getProject(projectId);
    operation.check();
    if (command.command.name === "get-properties") return api.getTaskProperties(project.id, taskId);
    const observedVersion = version === undefined ? resourceVersion(await api.getTaskProperties(project.id, taskId)) : version;
    operation.check();
    if (command.command.name === "remove-property") return api.removeTaskProperty(project.id, taskId, command.values[1]!, { version: observedVersion });
    return api.setTaskProperty(project.id, taskId, command.values[1]!, { version: observedVersion, value: command.values[2]! });
  });
};
