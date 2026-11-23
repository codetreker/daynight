import { parseVersionArgument } from "../../api/json.js";
import { canonicalId } from "../../api/parse.js";
import { normalizeTaskTagIds } from "../../api/task-tags.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import type { TaskCommandDependencies } from "./command.js";
import { renderTask } from "./rendering.js";

export const runTaskTagCommand = async (
  command: Extract<ParsedCommand, { readonly kind: "run" }>,
  context: CliContext,
  dependencies: TaskCommandDependencies,
): Promise<void> => {
  const help = `${command.path.join(" ")} --help`;
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const taskId = canonicalId(command.values[0]!);
  if (taskId === null) throw new UsageError("task-id must be a hyphenated UUID.", help);
  const tagId = canonicalId(command.values[1]!);
  if (tagId === null) throw new UsageError("tag-id must be a hyphenated UUID.", help);
  const rawVersion = command.options.get("--if-version") as string | undefined;
  let expectedVersion: bigint | undefined;
  if (rawVersion !== undefined) {
    try { expectedVersion = parseVersionArgument(rawVersion); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : String(cause), help); }
  }
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    operation.check();
    const project = projectId === undefined
      ? (await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })).id
      : projectId;
    operation.check();
    const observed = await api.getTask(project, taskId);
    operation.check();
    if (expectedVersion !== undefined && expectedVersion !== observed.version) {
      throw new Error(`Task version conflict for project=${project} task=${taskId}: expected ${expectedVersion}, observed ${observed.version}. No update was submitted.`);
    }
    const ids = observed.tags.map(tag => tag.id);
    const tagIds = normalizeTaskTagIds(command.command.name === "add" ? [...ids, tagId] : ids.filter(id => id !== tagId));
    const version = expectedVersion ?? observed.version;
    const result = await api.updateTask(project, taskId, { version, tagIds }, { tagOnlyPreviousIds: ids });
    operation.check();
    return `Task tags updated.\n${renderTask(result)}`;
  });
};
