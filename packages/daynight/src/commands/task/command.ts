import type { CreateTaskInput, Project, Task, TaskFilters, TaskPlatform, UpdateTaskInput } from "../../api/types.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { isNonemptyText, isText } from "../../platform/text.js";
import type { resolveProject } from "../../repository/index.js";
import type { runServerCommand } from "../server/runtime.js";
import { taskDefinition } from "./definition.js";

export type TaskCommandDependencies = {
  runServerCommand: typeof runServerCommand;
  resolveProject: typeof resolveProject;
};

const defaultDependencies: TaskCommandDependencies = {
  runServerCommand: async (...args) => (await import("../server/runtime.js")).runServerCommand(...args),
  resolveProject: async (...args) => (await import("../../repository/index.js")).resolveProject(...args),
};

const taskPriority = (task: Task): number => task.status === "in_progress" ? 0 : task.ready ? 1 : task.status === "todo" ? 2 : 3;

const compileDependencies = async (
  ordinary: readonly string[] | undefined,
  external: readonly string[] | undefined,
  clear: boolean,
  help: string,
): Promise<Pick<UpdateTaskInput, "dependsOn" | "externalDependsOn">> => {
  if (clear && (ordinary !== undefined || external !== undefined)) throw new UsageError("--clear-dependencies conflicts with --depends-on and --external-depends-on.", help);
  if (clear) return { dependsOn: [], externalDependsOn: [] };
  if (ordinary === undefined && external === undefined) return {};
  const { canonicalId } = await import("../../api/parse.js");
  const seen = new Set<string>();
  const parse = (values: readonly string[] | undefined): string[] => values === undefined ? [] : values.map((value) => {
    const id = canonicalId(value);
    if (id === null) throw new UsageError("Dependency task IDs must be hyphenated UUIDs.", help);
    if (seen.has(id)) throw new UsageError(`Dependency task ${id} is declared more than once.`, help);
    seen.add(id);
    return id;
  });
  const ordinaryIds = parse(ordinary);
  const externalIds = parse(external);
  return { dependsOn: [...ordinaryIds, ...externalIds].toSorted(), externalDependsOn: externalIds.toSorted() };
};

export const runTaskCommand = async (
  args: readonly string[],
  context: CliContext,
  dependencies: TaskCommandDependencies = defaultDependencies,
): Promise<void> => {
  const command = parseCommand(taskDefinition, args, ["daynight", "task"], "daynight task --help");
  if (command.kind !== "run") {
    context.stdout(renderCommandHelp(command.command, command.path));
    return;
  }
  if (command.path[2] === "attachment") {
    const { runTaskAttachmentCommand } = await import("./attachment.js");
    await runTaskAttachmentCommand(command, context, dependencies);
    return;
  }
  const help = `${command.path.join(" ")} --help`;
  const name = command.command.name;
  const setsStatus = name === "set-status";
  const targetsTask = name === "show" || name === "update" || setsStatus || name === "delete";
  const title = command.options.get("--title") as string | undefined;
  const description = command.options.get("--description") as string | undefined;
  const status = command.options.get("--status") as TaskFilters["status"];
  const allowAgentsArgument = command.options.get("--allow-agents") as "true" | "false" | undefined;
  const allowAgents = allowAgentsArgument === undefined ? undefined : allowAgentsArgument === "true";
  const requiredPlatform = command.options.get("--required-platform") as TaskPlatform | undefined;
  const clearRequiredPlatform = command.options.has("--clear-required-platform");
  if (clearRequiredPlatform && requiredPlatform !== undefined) throw new UsageError("--clear-required-platform conflicts with --required-platform.", help);
  const platformFields = clearRequiredPlatform ? { requiredPlatform: null } : requiredPlatform === undefined ? {} : { requiredPlatform };
  const compatiblePlatform = command.options.get("--compatible-platform") as TaskPlatform | undefined;
  const all = command.options.has("--all");
  if (all && status !== undefined) throw new UsageError("--all conflicts with --status.", help);
  const dependsOn = command.options.get("--depends-on") as readonly string[] | undefined;
  const externalDependsOn = command.options.get("--external-depends-on") as readonly string[] | undefined;
  const clearDependencies = command.options.has("--clear-dependencies");
  const pullRequestUrls = command.options.get("--pull-request-url") as readonly string[] | undefined;
  const pullRequestTitles = command.options.get("--pull-request-title") as readonly string[] | undefined;
  const clearPullRequests = command.options.has("--clear-pull-requests");
  if (clearPullRequests && (pullRequestUrls !== undefined || pullRequestTitles !== undefined)) throw new UsageError("--clear-pull-requests conflicts with --pull-request-url and --pull-request-title.", help);
  if (pullRequestUrls?.length !== pullRequestTitles?.length) throw new UsageError("Provide the same number of --pull-request-url and --pull-request-title values.", help);
  const properties = clearPullRequests ? { pullRequests: [] } : pullRequestUrls === undefined ? undefined : { pullRequests: pullRequestUrls.map((url, index) => ({ url, title: pullRequestTitles![index]! })) };
  const limitArgument = command.options.get("--limit") as string | undefined;
  const readyLimit = limitArgument === undefined ? 10 : Number(limitArgument);
  if (limitArgument !== undefined && (!/^[0-9]+$/.test(limitArgument) || !Number.isInteger(readyLimit) || readyLimit < 1 || readyLimit > 100)) throw new UsageError("Ready task limit must be a decimal integer from 1 to 100.", help);
  if (title !== undefined && !isNonemptyText(title)) throw new UsageError("Task title must be nonempty UTF-8 text without NUL characters.", help);
  if (description !== undefined && !isText(description)) throw new UsageError("Task description must be UTF-8 text without NUL characters.", help);
  const dependencyFields = await compileDependencies(dependsOn, externalDependsOn, clearDependencies, help);
  const changes: Omit<UpdateTaskInput, "version"> = {
    ...(allowAgents === undefined ? {} : { allowAgents }),
    ...platformFields,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...dependencyFields,
    ...(properties === undefined ? {} : { properties }),
  };
  if (name === "update" && Object.keys(changes).length === 0) throw new UsageError("Task update requires a title, description, automatic-execution permission, platform requirement, dependency, or PR reference change.", help);
  const rawProjectId = command.options.get("--project") as string | undefined;
  let projectId: string | undefined;
  let taskId: string | undefined;
  if (rawProjectId !== undefined || targetsTask) {
    const { canonicalId } = await import("../../api/parse.js");
    if (rawProjectId !== undefined) {
      projectId = canonicalId(rawProjectId) ?? undefined;
      if (projectId === undefined) throw new UsageError("project-id must be a hyphenated UUID.", help);
    }
    if (targetsTask) {
      taskId = canonicalId(command.values[0]!) ?? undefined;
      if (taskId === undefined) throw new UsageError("task-id must be a hyphenated UUID.", help);
    }
  }
  const versionArgument = command.options.get("--if-version") as string | undefined;
  let expectedVersion: bigint | undefined;
  if (versionArgument !== undefined) {
    const { parseVersionArgument } = await import("../../api/json.js");
    try { expectedVersion = parseVersionArgument(versionArgument); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : String(cause), help); }
  }
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    operation.check();
    let project: Project;
    if (projectId !== undefined) {
      project = await api.getProject(projectId);
    } else {
      project = await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() });
    }
    operation.check();
    const { renderTask, renderTaskGraph, renderTaskJson, renderTaskList, renderTaskListJson, renderTaskSummaryList } = await import("./rendering.js");
    operation.check();
    if (command.command.name === "create") {
      const input: CreateTaskInput = { title: title!, ...(description === undefined ? {} : { description }), ...platformFields, ...dependencyFields, ...(properties === undefined ? {} : { properties }) };
      const task = await api.createTask(project.id, input);
      operation.check();
      return `Task created.\n${renderTask(task)}`;
    }
    if (command.command.name === "list") {
      const filters: TaskFilters = { ...(status === undefined ? {} : { status }), ...(command.options.has("--ready") ? { ready: true } : {}), ...(allowAgents === undefined ? {} : { allowAgents }), ...(compatiblePlatform === undefined ? {} : { compatiblePlatform }) };
      const tasks = (await api.listTasks(project.id, filters))
        .filter((task) => all || status !== undefined || task.status !== "done")
        .toSorted((left, right) => taskPriority(left) - taskPriority(right));
      operation.check();
      return command.options.has("--json") ? renderTaskListJson(tasks) : renderTaskSummaryList(tasks);
    }
    if (command.command.name === "ready") {
      const tasks = await api.listReadyTasks(project.id, readyLimit, { ...(allowAgents === undefined ? {} : { allowAgents }), ...(compatiblePlatform === undefined ? {} : { compatiblePlatform }) });
      operation.check();
      return command.options.has("--json") ? renderTaskJson(tasks) : tasks.length === 0 ? "No ready tasks.\n" : renderTaskList(tasks);
    }
    if (command.command.name === "graph") {
      const graph = await api.getTaskGraph(project.id);
      operation.check();
      return command.options.has("--json") ? renderTaskJson(graph) : renderTaskGraph(graph);
    }
    if (command.command.name === "show") {
      const task = await api.getTask(project.id, taskId!);
      operation.check();
      return command.options.has("--json") ? renderTaskJson(task) : renderTask(task);
    }
    const version = expectedVersion === undefined ? (await api.getTask(project.id, taskId!)).version : expectedVersion;
    operation.check();
    if (name === "delete") {
      await api.deleteTask(project.id, taskId!, { version });
      operation.check();
      return `Task deleted. Stored data and attachments are retained.\nID: ${taskId!}\nProject: ${project.id}\n`;
    }
    if (setsStatus) {
      const task = await api.setTaskStatus(project.id, taskId!, { version, status: command.values[1] as Task["status"] });
      operation.check();
      return `Task status set.\n${renderTask(task)}`;
    }
    const task = await api.updateTask(project.id, taskId!, { ...changes, version });
    operation.check();
    return `Task updated.\n${renderTask(task)}`;
  });
};
