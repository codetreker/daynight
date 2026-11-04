import { parseApiJson } from "./json.js";
import { jsonObjectSources } from "./json-source.js";
import type { StepResource, StepsResource, TaskStep, TaskStepStatus } from "./types.js";
import { array, fields, id, malformed, resourceVersion, text, timestamp } from "./validation.js";

export const TASK_STEPS_RESPONSE_BYTES = 64 * 1024 * 1024;

export const canonicalStepId = (value: string): string | null =>
  typeof value === "string" && /^[0-9a-f]{8}$/i.test(value) ? value.toLowerCase() : null;

const stepId = (value: unknown): string => {
  const parsed = text(value);
  return canonicalStepId(parsed) === parsed ? parsed : malformed();
};

const stepTimestamp = (value: unknown): string => {
  const parsed = timestamp(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(parsed)
    || parsed.startsWith("0000-") || /^0001-01-01T00:00:00(?:\.0{1,6})?Z$/.test(parsed)) return malformed();
  return parsed;
};

const stepStatus = (value: unknown): TaskStepStatus =>
  value === "todo" || value === "in_progress" || value === "done" || value === "skipped" ? value : malformed();

const parseTaskStep = (value: unknown): TaskStep => {
  const data = fields(value, ["id", "title", "description", "status", "createdAt", "updatedAt"]);
  return { id: stepId(data.id), title: text(data.title, true), description: text(data.description), status: stepStatus(data.status), createdAt: stepTimestamp(data.createdAt), updatedAt: stepTimestamp(data.updatedAt) };
};

const parent = (data: Record<string, unknown>, projectId: string, taskId: string) => {
  const parsed = { projectId: id(data.projectId), taskId: id(data.taskId), version: resourceVersion(data.version) };
  if (parsed.projectId !== projectId || parsed.taskId !== taskId) return malformed();
  return parsed;
};

export const decodeStepsJsonSource = (source: string): unknown => {
  jsonObjectSources(source);
  return parseApiJson(source);
};

export const parseStepsResource = (value: unknown, projectId: string, taskId: string): StepsResource => {
  const data = fields(value, ["projectId", "taskId", "version", "steps"]);
  const parsed = parent(data, projectId, taskId);
  const steps = array(data.steps, parseTaskStep);
  if (new Set(steps.map((step) => step.id)).size !== steps.length) return malformed();
  return { ...parsed, steps };
};

export const parseStepResource = (value: unknown, projectId: string, taskId: string, expectedStepId: string): StepResource => {
  const data = fields(value, ["projectId", "taskId", "version", "step"]);
  const parsed = parent(data, projectId, taskId);
  const step = parseTaskStep(data.step);
  if (step.id !== expectedStepId) return malformed();
  return { ...parsed, step };
};
