import { stringifyApiJson } from "../../api/json.js";
import type { GraphTask, Task, TaskGraph } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";

const identifiers = (values: readonly string[]): string => values.length === 0 ? "none" : values.map(terminalText).join(", ");

const taskIdentity = (task: Task): readonly string[] => [
  `ID: ${terminalText(task.id)}`,
  `Project: ${terminalText(task.projectId)}`,
  `Title: ${terminalText(task.title)}`,
];

const taskProperties = (task: Task): readonly string[] => [
  `Properties: ${Object.keys(task.properties).length}`,
  ...Object.entries(task.properties).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `  ${terminalText(name)}: ${terminalText(stringifyApiJson(value))}`),
];

const taskDependencies = (task: Pick<Task, "ready" | "dependsOn" | "externalDependsOn" | "blockedBy">): readonly string[] => [
  `Ready: ${task.ready}`,
  `Depends on: ${identifiers(task.dependsOn)}`,
  `External dependencies (${task.externalDependsOn.length}): ${identifiers(task.externalDependsOn)}`,
  `Blocked by: ${identifiers(task.blockedBy)}`,
];

export const renderTask = (task: Task): string => [
  ...taskIdentity(task),
  `Description: ${terminalText(task.description)}`,
  ...taskProperties(task),
  `Status: ${terminalText(task.status)}`,
  `Automatic execution: ${task.allowAgents}`,
  `Required platform: ${task.requiredPlatform === null ? "any" : task.requiredPlatform}`,
  `Version: ${task.version}`,
  ...taskDependencies(task),
  `Created: ${terminalText(task.createdAt)}`,
  `Updated: ${terminalText(task.updatedAt)}`,
  "",
].join("\n");

export const renderTaskList = (tasks: readonly Task[]): string => tasks.length === 0 ? "No tasks.\n" : tasks.map(renderTask).join("\n");

export const renderTaskSummaryList = (tasks: readonly Task[]): string => tasks.length === 0 ? "No tasks.\n" : tasks.map((task) => [
  ...taskIdentity(task),
  ...taskProperties(task),
  `Status: ${terminalText(task.status)}`,
  `Automatic execution: ${task.allowAgents}`,
  `Required platform: ${task.requiredPlatform === null ? "any" : task.requiredPlatform}`,
  ...taskDependencies(task),
  "",
].join("\n")).join("\n");

const renderGraphTask = (task: GraphTask): string => [
  `ID: ${terminalText(task.id)}`,
  `Title preview: ${terminalText(task.titlePreview)}`,
  `Title truncated: ${task.titleTruncated}`,
  `Status: ${terminalText(task.status)}`,
  `Automatic execution: ${task.allowAgents}`,
  `Required platform: ${task.requiredPlatform === null ? "any" : task.requiredPlatform}`,
  ...taskDependencies(task),
  `Created: ${terminalText(task.createdAt)}`,
  `Updated: ${terminalText(task.updatedAt)}`,
  "",
].join("\n");

export const renderTaskGraph = (graph: TaskGraph): string => [
  `Project: ${terminalText(graph.project.id)}`,
  `Name: ${terminalText(graph.project.name)}`,
  `Repository: ${terminalText(graph.project.repoUrl)}`,
  `Created: ${terminalText(graph.project.createdAt)}`,
  `Updated: ${terminalText(graph.project.updatedAt)}`,
  "",
  "Summary:",
  `Total: ${graph.summary.total}`,
  `Todo: ${graph.summary.todo}`,
  `In progress: ${graph.summary.inProgress}`,
  `Done: ${graph.summary.done}`,
  `Ready: ${graph.summary.ready}`,
  `Blocked: ${graph.summary.blocked}`,
  "",
  graph.tasks.map(renderGraphTask).join("\n"),
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
