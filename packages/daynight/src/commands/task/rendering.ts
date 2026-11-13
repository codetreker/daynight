import { stringifyApiJson } from "../../api/json.js";
import type { GraphTask, Task, TaskGraph, TaskPropertyResource, TaskPropertySchema } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";
import type { ObservedTask, ObservedTaskGraph, ObservedGraphTask } from "../../api/task-observation.js";
import { renderSessionAggregation, renderSessionObservation, taskObservationQuery } from "./observation-rendering.js";

const identifiers = (values: readonly string[]): string => values.length === 0 ? "none" : values.map(terminalText).join(", ");

const taskIdentity = (task: Task): readonly string[] => [
  `ID: ${terminalText(task.id)}`,
  `Project: ${terminalText(task.projectId)}`,
  `Type: ${task.type}`,
  `Parent: ${task.parentId === null ? "none" : terminalText(task.parentId)}`,
  `Title: ${terminalText(task.title)}`,
  ...(task.tags.length === 0 ? ["Tags: none"] : ["Tags:", ...task.tags.map(({ name }) => `  ${terminalText(name)}`)]),
];

const taskProperties = (task: Task): readonly string[] => [
  `Properties: ${Object.keys(task.properties).length}`,
  ...Object.entries(task.properties).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `  ${terminalText(name)}: ${terminalText(stringifyApiJson(value))}`),
];

const taskAssignment = (task: Pick<Task, "assignedTo">): string => `Assigned to: ${task.assignedTo === null ? "unassigned" : terminalText(task.assignedTo)}`;

const taskDependencies = (task: Pick<Task, "ready" | "dependsOn" | "externalDependsOn" | "blockedBy">): readonly string[] => [
  `Ready: ${task.ready}`,
  `Depends on: ${identifiers(task.dependsOn)}`,
  `External dependencies (${task.externalDependsOn.length}): ${identifiers(task.externalDependsOn)}`,
  `Blocked by: ${identifiers(task.blockedBy)}`,
];

export const renderTask = (task: Task | ObservedTask): string => [
  ...taskIdentity(task),
  `Description: ${terminalText(task.description)}`,
  ...taskProperties(task),
  `Status: ${terminalText(task.status)}`,
  taskAssignment(task),
  ...("session" in task ? [...renderSessionObservation(task.session), taskObservationQuery(task.projectId, task.id)] : []),
  `Automatic execution: ${task.allowAgents}`,
  `Required platform: ${task.requiredPlatform === null ? "any" : task.requiredPlatform}`,
  `Version: ${task.version}`,
  ...taskDependencies(task),
  ...(task.progress === undefined ? [] : [`Progress: total=${task.progress.total}, done=${task.progress.done}, cancelled=${task.progress.cancelled}, unfinished=${task.progress.unfinished}`]),
  `Created: ${terminalText(task.createdAt)}`,
  `Updated: ${terminalText(task.updatedAt)}`,
  ...(task.cancelledAt === null ? [] : [`Cancelled at: ${terminalText(task.cancelledAt)}`]),
  "",
].join("\n");

export const renderTaskList = (tasks: readonly Task[]): string => tasks.length === 0 ? "No tasks.\n" : tasks.map(renderTask).join("\n");

export const renderTaskSummaryList = (tasks: readonly (Task | ObservedTask)[]): string => tasks.length === 0 ? "No tasks.\n" : tasks.map((task) => [
  ...taskIdentity(task),
  ...taskProperties(task),
  `Status: ${terminalText(task.status)}`,
  taskAssignment(task),
  ...("session" in task ? [...renderSessionObservation(task.session), taskObservationQuery(task.projectId, task.id)] : []),
  `Automatic execution: ${task.allowAgents}`,
  `Required platform: ${task.requiredPlatform === null ? "any" : task.requiredPlatform}`,
  ...taskDependencies(task),
  "",
].join("\n")).join("\n");

const renderGraphTask = (task: GraphTask | ObservedGraphTask, projectId: string): string => [
  `ID: ${terminalText(task.id)}`,
  `Type: ${task.type}`,
  `Parent: ${task.parentId === null ? "none" : terminalText(task.parentId)}`,
  `Title preview: ${terminalText(task.titlePreview)}`,
  `Title truncated: ${task.titleTruncated}`,
  `Status: ${terminalText(task.status)}`,
  taskAssignment(task),
  ...("session" in task ? [`Relation: ${task.relation}`, ...renderSessionObservation(task.session), taskObservationQuery(projectId, task.id)] : []),
  `Automatic execution: ${task.allowAgents}`,
  `Required platform: ${task.requiredPlatform === null ? "any" : task.requiredPlatform}`,
  ...taskDependencies(task),
  `Created: ${terminalText(task.createdAt)}`,
  `Updated: ${terminalText(task.updatedAt)}`,
  ...(task.cancelledAt === null ? [] : [`Cancelled at: ${terminalText(task.cancelledAt)}`]),
  "",
].join("\n");

export const renderTaskGraph = (graph: TaskGraph | ObservedTaskGraph): string => [
  `Project: ${terminalText(graph.project.id)}`,
  `Name: ${terminalText(graph.project.name)}`,
  `Repository: ${terminalText(graph.project.repoUrl)}`,
  `Created: ${terminalText(graph.project.createdAt)}`,
  `Updated: ${terminalText(graph.project.updatedAt)}`,
  "",
  "Summary:",
  `Total: ${graph.summary.total}`,
  `Proposed: ${graph.summary.proposed}`,
  `Todo: ${graph.summary.todo}`,
  `In progress: ${graph.summary.inProgress}`,
  `Done: ${graph.summary.done}`,
  `Cancelled: ${graph.summary.cancelled}`,
  `Ready: ${graph.summary.ready}`,
  `Blocked: ${graph.summary.blocked}`,
  ...("sessionSummary" in graph ? renderSessionAggregation(graph.sessionSummary) : []),
  "",
  graph.tasks.map(task => renderGraphTask(task, graph.project.id)).join("\n"),
].join("\n");

export const renderTaskGraphDependencies = (graph: TaskGraph, json: boolean): string => {
  const tasks = graph.tasks.map(({ id, dependsOn, externalDependsOn }) => ({ id, dependsOn, externalDependsOn }));
  return json ? `${stringifyApiJson(tasks)}\n` : tasks.map((task) => [
    `ID: ${terminalText(task.id)}`,
    `Depends on: ${identifiers(task.dependsOn)}`,
    `External dependencies: ${identifiers(task.externalDependsOn)}`,
    "",
  ].join("\n")).join("\n");
};

export const renderTaskJson = (value: Task | readonly Task[] | TaskGraph): string => `${stringifyApiJson(value)}\n`;

export const renderTaskListJson = (tasks: readonly Task[]): string => `${stringifyApiJson(tasks.map(({ description: _description, ...task }) => task))}\n`;

export const renderTaskPropertyResource = (resource: TaskPropertyResource): string => {
  const entries = Object.entries(resource.properties).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return [
    `Task: ${terminalText(resource.taskId)}`,
    `Project: ${terminalText(resource.projectId)}`,
    `Version: ${resource.version}`,
    `Properties (${entries.length}):${entries.length === 0 ? " {}" : ""}`,
    ...entries.map(([name, value]) => `  ${terminalText(name)}: ${terminalText(stringifyApiJson(value))}`),
    "",
  ].join("\n");
};

export const renderTaskPropertySchema = (catalog: TaskPropertySchema): string => Object.entries(catalog.properties)
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([name, definition]) => [
    `Property: ${terminalText(name)}`,
    `Description: ${terminalText(definition.description)}`,
    `Read only: ${definition.readOnly}`,
    `Schema: ${terminalText(stringifyApiJson(definition.schema))}`,
    "",
  ].join("\n")).join("\n");
