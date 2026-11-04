import { parseApiJson } from "./json.js";
import { jsonObjectSources } from "./json-source.js";
import type { AddTaskStepInput, DeleteTaskStepInput, MoveTaskStepInput, SetTaskStepStatusInput, StepResource, StepsResource, TaskStep, TaskStepStatus, UpdateTaskStepInput } from "./types.js";
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

export const confirmAddedTaskStep = (resource: StepsResource, input: AddTaskStepInput, previous?: StepsResource): string => {
  const index = resource.steps.findIndex((step) => step.id === input.id);
  const target = resource.steps[index];
  const description = input.description === undefined ? "" : input.description;
  const status = input.status === undefined ? "todo" : input.status;
  if (resource.version !== input.version + 1n || target === undefined || target.title !== input.title || target.description !== description || target.status !== status || target.createdAt !== target.updatedAt) return malformed();
  if (input.before !== undefined) {
    const anchor = resource.steps.findIndex((step) => step.id === input.before);
    if (anchor < 0 || index + 1 !== anchor) return malformed();
  } else if (input.after !== undefined) {
    const anchor = resource.steps.findIndex((step) => step.id === input.after);
    if (anchor < 0 || index !== anchor + 1) return malformed();
  } else if (index !== resource.steps.length - 1) return malformed();
  if (previous !== undefined) {
    const remaining = resource.steps.filter((step) => step.id !== input.id);
    if (remaining.length !== previous.steps.length || remaining.some((step, position) => {
      const old = previous.steps[position]!;
      return step.id !== old.id || step.title !== old.title || step.description !== old.description || step.status !== old.status || step.createdAt !== old.createdAt || step.updatedAt !== old.updatedAt;
    })) return malformed();
  }
  return input.id;
};

export const confirmDeletedTaskStep = (resource: StepsResource, stepId: string, input: DeleteTaskStepInput, previous?: StepsResource): string => {
  if (resource.version !== input.version + 1n || resource.steps.some((step) => step.id === stepId)) return malformed();
  if (previous !== undefined) {
    const remaining = previous.steps.filter((step) => step.id !== stepId);
    if (remaining.length !== previous.steps.length - 1 || resource.steps.length !== remaining.length || resource.steps.some((step, position) => {
      const old = remaining[position]!;
      return step.id !== old.id || step.title !== old.title || step.description !== old.description || step.status !== old.status || step.createdAt !== old.createdAt || step.updatedAt !== old.updatedAt;
    })) return malformed();
  }
  return stepId;
};

const sameStep = (step: TaskStep, other: TaskStep): boolean => step.id === other.id && step.title === other.title
  && step.description === other.description && step.status === other.status && step.createdAt === other.createdAt && step.updatedAt === other.updatedAt;

export const confirmUpdatedTaskStep = (resource: StepsResource, stepId: string, input: UpdateTaskStepInput | SetTaskStepStatusInput, previous?: StepsResource): string => {
  const index = resource.steps.findIndex((step) => step.id === stepId);
  const target = resource.steps[index];
  const changes = "status" in input ? { status: input.status } : { ...(input.title === undefined ? {} : { title: input.title }), ...(input.description === undefined ? {} : { description: input.description }) };
  if ((resource.version !== input.version && resource.version !== input.version + 1n) || target === undefined
    || Object.entries(changes).some(([field, value]) => target[field as keyof TaskStep] !== value)) return malformed();
  if (previous !== undefined) {
    const old = previous.steps[index];
    if (resource.steps.length !== previous.steps.length || old === undefined || old.id !== stepId) return malformed();
    const expected = { ...old, ...changes };
    const changed = !sameStep(expected, old);
    if (resource.version !== input.version + (changed ? 1n : 0n) || target.createdAt !== old.createdAt
      || target.title !== expected.title || target.description !== expected.description || target.status !== expected.status
      || (changed ? target.updatedAt === old.updatedAt : target.updatedAt !== old.updatedAt)
      || resource.steps.some((step, position) => position !== index && !sameStep(step, previous.steps[position]!))) return malformed();
  }
  return stepId;
};

export const confirmMovedTaskStep = (resource: StepsResource, targetId: string, input: MoveTaskStepInput, previous?: StepsResource): string => {
  if (resource.version !== input.version && resource.version !== input.version + 1n) return malformed();
  const index = resource.steps.findIndex((step) => step.id === targetId);
  if (index < 0) return malformed();
  if (input.before !== undefined) {
    const anchor = resource.steps.findIndex((step) => step.id === input.before);
    if (anchor < 0 || index + 1 !== anchor) return malformed();
  } else if (input.after !== undefined) {
    const anchor = resource.steps.findIndex((step) => step.id === input.after);
    if (anchor < 0 || index !== anchor + 1) return malformed();
  } else if (index !== (input.position === "first" ? 0 : resource.steps.length - 1)) return malformed();
  if (previous !== undefined) {
    const oldIndex = previous.steps.findIndex((step) => step.id === targetId);
    if (oldIndex < 0 || resource.steps.length !== previous.steps.length) return malformed();
    const expected = previous.steps.filter((step) => step.id !== targetId);
    expected.splice(index, 0, previous.steps[oldIndex]!);
    if (resource.version !== input.version + (oldIndex === index ? 0n : 1n)
      || resource.steps.some((step, position) => {
        const old = expected[position]!;
        return step.id !== old.id || step.title !== old.title || step.description !== old.description || step.status !== old.status || step.createdAt !== old.createdAt || step.updatedAt !== old.updatedAt;
      })) return malformed();
  }
  return targetId;
};
