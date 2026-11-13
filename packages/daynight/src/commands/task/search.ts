import { parseTagFilter } from "./tag-filter.js";
import { ApiError } from "../../api/client.js";
import { canonicalId } from "../../api/parse.js";
import type { TaskFilters, TaskSearchItem } from "../../api/types.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import { isNonemptyText } from "../../platform/text.js";
import type { TaskCommandDependencies } from "./command.js";
import { parseParent } from "./parent.js";

type Command = Extract<ParsedCommand, { readonly kind: "run" }>;

// Both renderers consume the same explicit projection, independently of wire additions.
const projectResults = (items: readonly TaskSearchItem[]): TaskSearchItem[] => items.map((item) => ({
  id: item.id, type: item.type, parentId: item.parentId, projectId: item.projectId, title: item.title, status: item.status, cancelledAt: item.cancelledAt,
  tags: item.tags.map(({ id, name }) => ({ id, name })),
  context: item.context === null ? null : { taskId: item.context.taskId, title: item.context.title },
  match: { fields: [...item.match.fields], descriptionSnippet: item.match.descriptionSnippet },
}));

const renderText = (project: string, items: readonly TaskSearchItem[]): string => {
  const header = `Project: ${terminalText(project)}\n`;
  if (items.length === 0) return `${header}No matching tasks.\n`;
  return `${header}Found ${items.length} matching ${items.length === 1 ? "task" : "tasks"}.\n\n${items.map((item) => [
    `ID: ${terminalText(item.id)}`,
    `Type: ${item.type}`,
    `Parent: ${item.parentId === null ? "none" : terminalText(item.parentId)}`,
    `Title: ${terminalText(item.title)}`,
    ...(item.tags.length === 0 ? ["Tags: none"] : ["Tags:", ...item.tags.map(({ name }) => `  ${terminalText(name)}`)]),
    `Status: ${terminalText(item.status)}`,
    `Goal: ${item.context === null ? "none" : `${terminalText(item.context.taskId)}  ${terminalText(item.context.title)}`}`,
    `Match: ${item.match.fields.length === 0 ? "negative condition" : item.match.fields.join(", ")}`,
    ...(item.match.descriptionSnippet === null ? [] : [`Snippet: ${terminalText(item.match.descriptionSnippet)}`]),
    "",
  ].join("\n")).join("\n")}`;
};

export const runTaskSearchCommand = async (command: Command, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  const help = `${command.path.join(" ")} --help`;
  const query = command.values[0]!;
  if (!isNonemptyText(query)) throw new UsageError("Search expression must be nonempty UTF-8 text without NUL characters.", help);
  const rawProject = command.options.get("--project") as string | undefined;
  let projectId = rawProject === undefined ? undefined : canonicalId(rawProject) ?? undefined;
  if (rawProject !== undefined && projectId === undefined) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const rawAssignee = command.options.get("--assigned-to") as string | undefined;
  const assignedTo = rawAssignee === undefined || rawAssignee === "me" || rawAssignee === "unassigned" ? rawAssignee : canonicalId(rawAssignee);
  if (assignedTo === null) throw new UsageError("--assigned-to must be a hyphenated UUID, me or unassigned.", help);
  const status = command.options.get("--status") as TaskFilters["status"];
  const compatiblePlatform = command.options.get("--compatible-platform") as TaskFilters["compatiblePlatform"];
  const allowAgents = command.options.get("--allow-agents") as string | undefined;
  const type = command.options.get("--type") as "task" | "goal" | undefined;
  const parentId = await parseParent(command.options.get("--parent") as string | undefined, help);
  const filters: TaskFilters = {
    ...parseTagFilter(command, help),
    ...(type === undefined ? {} : { type }), ...(parentId === undefined ? {} : { parentId }),
    ...(assignedTo === undefined ? {} : { assignedTo }), ...(status === undefined ? {} : { status }),
    ...(command.options.has("--ready") ? { ready: true } : {}),
    ...(allowAgents === undefined ? {} : { allowAgents: allowAgents === "true" }),
    ...(compatiblePlatform === undefined ? {} : { compatiblePlatform }),
  };
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    if (projectId === undefined) projectId = (await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })).id;
    operation.check();
    try {
      const results = projectResults(await api.searchTasks(projectId, { query, ...filters }));
      operation.check();
      return command.options.has("--json") ? `${JSON.stringify(results)}\n` : renderText(projectId, results);
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_search_expression" && error.status === 400) {
        throw new PublicDiagnosticError(terminalText(error.message), 2, { cause: error });
      }
      throw error;
    }
  });
};
