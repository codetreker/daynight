import type { CreateTaskInput, Project, Task, TaskFilters, TaskPlatform, UpdateTaskInput } from "../../api/types.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { isNonemptyText, isText } from "../../platform/text.js";
import type { resolveProject } from "../../repository/index.js";
import type { runServerCommand } from "../server/runtime.js";
import { taskDefinition } from "./definition.js";
import { isTerminalTaskStatus } from "../../task/status.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";

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
  if (command.path[2] === "session") {
    const { runTaskSessionCommand } = await import("./session/registry.js");
    await runTaskSessionCommand(command, context, dependencies);
    return;
  }
  if (command.path[2] === "step") {
    const { runTaskStepCommand } = await import("./step.js");
    await runTaskStepCommand(command, context, dependencies);
    return;
  }
  if (command.path[2] === "thread") {
    const { runTaskThreadCommand } = await import("./thread.js");
    await runTaskThreadCommand(command, context, dependencies);
    return;
  }
  if (command.path[2] === "attachment") {
    const { runTaskAttachmentCommand } = await import("./attachment.js");
    await runTaskAttachmentCommand(command, context, dependencies);
    return;
  }
  if (command.path[2] === "search") {
    const { runTaskSearchCommand } = await import("./search.js");
    await runTaskSearchCommand(command, context, dependencies);
    return;
  }
  if (["properties", "set-property", "remove-property"].includes(command.command.name)) {
    const { runTaskPropertyCommand } = await import("./property.js");
    await runTaskPropertyCommand(command, context, dependencies);
    return;
  }
  const help = `${command.path.join(" ")} --help`;
  const name = command.command.name;
  const setsStatus = name === "set-status";
  const rawClaimId = command.options.get("--claim-id") as string | undefined;
  if (rawClaimId !== undefined && command.values[1] !== "done") throw new UsageError("--claim-id is only valid when setting done.", help);
  const targetsTask = name === "show" || name === "update" || setsStatus || name === "delete" || name === "graph";
  const title = command.options.get("--title") as string | undefined;
  const description = command.options.get("--description") as string | undefined;
  const status = command.options.get("--status") as TaskFilters["status"];
  const allowAgentsArgument = command.options.get("--allow-agents") as "true" | "false" | undefined;
  const allowAgents = allowAgentsArgument === undefined ? undefined : allowAgentsArgument === "true";
  const assignedToArgument = command.options.get("--assigned-to") as string | undefined;
  const clearAssignedTo = command.options.has("--clear-assigned-to");
  if (clearAssignedTo && assignedToArgument !== undefined) throw new UsageError("--clear-assigned-to conflicts with --assigned-to.", help);
  let assignedTo: string | undefined;
  if (assignedToArgument !== undefined) {
    if (name === "list" && (assignedToArgument === "me" || assignedToArgument === "unassigned")) assignedTo = assignedToArgument;
    else {
      const { canonicalId } = await import("../../api/parse.js");
      const parsed = canonicalId(assignedToArgument);
      if (parsed === null) throw new UsageError(name === "list" ? "--assigned-to must be a hyphenated UUID, me or unassigned." : "--assigned-to must be a hyphenated UUID.", help);
      assignedTo = parsed;
    }
  }
  const assignmentFields: Pick<UpdateTaskInput, "assignedTo"> = clearAssignedTo ? { assignedTo: null } : assignedTo === undefined || name === "list" ? {} : { assignedTo };
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
  const limitArgument = command.options.get("--limit") as string | undefined;
  const grouped = command.options.get("--group-by") === "chain";
  const cursor = command.options.get("--cursor") as string | undefined;
  const groupArgument = command.options.get("--group-id") as string | undefined;
  const targetsCursor = command.options.get("--targets-cursor") as string | undefined;
  if (!grouped && name === "list" && [limitArgument, cursor, groupArgument, targetsCursor].some(value => value !== undefined)) throw new UsageError("Pagination options require --group-by chain.", help);
  if (grouped && (status !== "in_progress" || assignedTo === "unassigned" || all || command.options.has("--ready") || allowAgents !== undefined || compatiblePlatform !== undefined)) throw new UsageError("--group-by chain requires --status in_progress and an assigned user or me; other list filters are not supported.", help);
  if ((groupArgument === undefined) !== (targetsCursor === undefined)) throw new UsageError("--group-id and --targets-cursor must be supplied together.", help);
  if (groupArgument !== undefined && cursor !== undefined) throw new UsageError("--cursor cannot be combined with --targets-cursor.", help);
  const readyLimit = limitArgument === undefined ? (grouped ? 20 : 10) : Number(limitArgument);
  if (limitArgument !== undefined && (!/^[0-9]+$/.test(limitArgument) || !Number.isInteger(readyLimit) || readyLimit < 1 || readyLimit > (grouped ? 50 : 100))) throw new UsageError(grouped ? "Group limit must be a decimal integer from 1 to 50." : "Ready task limit must be a decimal integer from 1 to 100.", help);
  let groupId: string | undefined;
  if (groupArgument !== undefined) {
    const { canonicalId } = await import("../../api/parse.js");
    groupId = canonicalId(groupArgument) ?? undefined;
    if (groupId === undefined) throw new UsageError("group-id must be a hyphenated UUID.", help);
  }
  if (title !== undefined && !isNonemptyText(title)) throw new UsageError("Task title must be nonempty UTF-8 text without NUL characters.", help);
  if (description !== undefined && !isText(description)) throw new UsageError("Task description must be UTF-8 text without NUL characters.", help);
  const dependencyFields = await compileDependencies(dependsOn, externalDependsOn, clearDependencies, help);
  const changes: Omit<UpdateTaskInput, "version"> = {
    ...assignmentFields,
    ...(allowAgents === undefined ? {} : { allowAgents }),
    ...platformFields,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...dependencyFields,
  };
  if (name === "update" && Object.keys(changes).length === 0) throw new UsageError("Task update requires a title, description, assignee, automatic-execution permission, platform requirement, or dependency change.", help);
  const rawProjectId = command.options.get("--project") as string | undefined;
  let projectId: string | undefined;
  let taskId: string | undefined;
  let claimId: string | undefined;
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
    if (rawClaimId !== undefined) {
      const parsed = canonicalId(rawClaimId);
      if (parsed === null) throw new UsageError("claim-id must be a hyphenated UUID.", help);
      claimId = parsed;
    }
  }
  const versionArgument = command.options.get("--if-version") as string | undefined;
  let expectedVersion: bigint | undefined;
  if (versionArgument !== undefined) {
    const { parseVersionArgument } = await import("../../api/json.js");
    try { expectedVersion = parseVersionArgument(versionArgument); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : String(cause), help); }
  }
  let partialObservation = false;
  let unsupportedObservation = false;
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    operation.check();
    let project: Project;
    if (projectId !== undefined) {
      project = await api.getProject(projectId);
    } else {
      project = await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() });
    }
    operation.check();
    const { renderTask, renderTaskGraph, renderTaskGraphDependencies, renderTaskJson, renderTaskList, renderTaskListJson, renderTaskSummaryList } = await import("./rendering.js");
    const { taskObservationPartial } = await import("../../api/task-observation.js");
    operation.check();
    if (command.command.name === "create") {
      const createAssignedTo = assignedTo === undefined ? (await api.getCurrentUser()).id : assignedTo;
      operation.check();
      const input: CreateTaskInput = { title: title!, ...(description === undefined ? {} : { description }), assignedTo: createAssignedTo, ...platformFields, ...dependencyFields };
      const task = await api.createTask(project.id, input);
      operation.check();
      return `Task created.\n${renderTask(task)}`;
    }
    if (command.command.name === "list") {
      if (grouped) {
        const { renderTaskWorkPage } = await import("./observation-rendering.js");
        const { stringifyApiJson } = await import("../../api/json.js");
        const page = await api.listTaskWork(project.id, { assignedTo: assignedTo ?? "me", ...(limitArgument === undefined ? {} : { limit: readyLimit }), ...(cursor === undefined ? {} : { cursor }), ...(groupId === undefined ? {} : { groupId, targetsCursor: targetsCursor! }) });
        operation.check();
        partialObservation = page.partial;
        return command.options.has("--json") ? `${stringifyApiJson(page)}\n` : renderTaskWorkPage(page, project.id, assignedTo ?? "me");
      }
      const filters: TaskFilters = { ...(assignedTo === undefined ? {} : { assignedTo }), ...(status === undefined ? {} : { status }), ...(command.options.has("--ready") ? { ready: true } : {}), ...(allowAgents === undefined ? {} : { allowAgents }), ...(compatiblePlatform === undefined ? {} : { compatiblePlatform }) };
      const observed = await api.listObservedTasks(project.id, filters);
      partialObservation = observed.partial;
      unsupportedObservation = observed.unsupported;
      const tasks = observed.items
        .filter((task) => all || status !== undefined || !isTerminalTaskStatus(task.status))
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
      if (command.options.has("--depends-only")) {
        const graph = await api.getTaskGraph(project.id, taskId!);
        operation.check();
        return renderTaskGraphDependencies(graph, command.options.has("--json"));
      }
      const graph = await api.getObservedTaskGraph(project.id, taskId!);
      operation.check();
      partialObservation = graph.partial;
      unsupportedObservation = graph.tasks.some(task => task.session.observation === "unsupported");
      return command.options.has("--json") ? renderTaskJson(graph) : renderTaskGraph(graph);
    }
    if (command.command.name === "show") {
      const task = await api.getObservedTask(project.id, taskId!);
      operation.check();
      partialObservation = taskObservationPartial(task.session);
      unsupportedObservation = task.session.observation === "unsupported";
      return command.options.has("--json") ? renderTaskJson(task) : renderTask(task);
    }
    const version = expectedVersion === undefined ? (await api.getTask(project.id, taskId!)).version : expectedVersion;
    operation.check();
    if (name === "delete") {
      await api.deleteTask(project.id, taskId!, { version, ...(command.options.has("--remove-depends") ? { removeDepends: true } : {}) });
      operation.check();
      return `Task deleted. Stored data and attachments are retained.\nID: ${taskId!}\nProject: ${project.id}\n`;
    }
    if (setsStatus) {
      const task = claimId === undefined
        ? await api.setTaskStatus(project.id, taskId!, { version, status: command.values[1] as Task["status"] })
        : await api.completeWorkerTask(project.id, taskId!, { version, claimId });
      operation.check();
      return `Task status set.\n${renderTask(task)}`;
    }
    const task = await api.updateTask(project.id, taskId!, { ...changes, version });
    operation.check();
    return `Task updated.\n${renderTask(task)}`;
  });
  if (partialObservation) throw new PublicDiagnosticError(unsupportedObservation
    ? "Task data is available, but Session observations are unsupported. Upgrade the Daynight service and run the same query again."
    : "Task data is available, but Session observations are partial. Inspect each observation's reason, error and freshness before using it; run the same query again to refresh.", 3, {});
};
