import { assertResponsePrincipal, json, request, requestId, type TaskResponseAdmission } from "./client";
import { isTaskVersion, stringifyApiJson } from "./json";
import { ApiError } from "./client";
import { id, malformed, record, string, timestamp } from "./validation";

export type StepPlacement = { readonly position: "first" | "last" } | { readonly before: string } | { readonly after: string };
export type StepStatus = "todo" | "in_progress" | "done" | "skipped";
export type TaskStep = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: StepStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type StepsResource = {
  readonly projectId: string;
  readonly taskId: string;
  readonly version: bigint;
  readonly steps: readonly TaskStep[];
};

const text = (value: unknown): string => {
  const parsed = string(value);
  if (parsed.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(parsed)) return malformed();
  return parsed;
};
const stepTime = (value: unknown): string => {
  const parsed = timestamp(value);
  if (parsed.startsWith("0000-") || /\.\d{7,}Z$/.test(parsed) || /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(parsed)) return malformed();
  return parsed;
};
const step = (value: unknown): TaskStep => {
  const data = record(value);
  const stepId = string(data.id);
  const title = text(data.title);
  if (!/^[0-9a-f]{8}$/.test(stepId) || !/[^\p{White_Space}]/u.test(title)) return malformed();
  if (data.status !== "todo" && data.status !== "in_progress" && data.status !== "done" && data.status !== "skipped") return malformed();
  return { id: stepId, title, description: text(data.description), status: data.status,
    createdAt: stepTime(data.createdAt), updatedAt: stepTime(data.updatedAt) };
};

export const parseTaskSteps = (value: unknown, projectId: string, taskId: string): StepsResource => {
  const data = record(value);
  if (id(data.projectId) !== projectId || id(data.taskId) !== taskId || !isTaskVersion(data.version) || !Array.isArray(data.steps)) return malformed();
  const steps = data.steps.map(step);
  if (new Set(steps.map((item) => item.id)).size !== steps.length) return malformed();
  return { projectId, taskId, version: data.version, steps };
};

export const getTaskSteps = async (projectId: string, taskId: string, signal: AbortSignal, admission: TaskResponseAdmission, correlationId?: string): Promise<StepsResource> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/steps`, signal, { headers: { Accept: "application/json", ...(correlationId === undefined ? {} : { "X-Request-ID": correlationId }) } });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, (value) => {
    if (response.status !== 200) return malformed();
    return parseTaskSteps(value, project, task);
  }, undefined, true);
};

export const setTaskStepStatus = async (projectId: string, taskId: string, stepId: string, status: StepStatus, version: bigint, signal: AbortSignal, admission: TaskResponseAdmission, correlationId: string): Promise<StepsResource> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const target = stepId.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(target) || !isTaskVersion(version) || !["todo", "in_progress", "done", "skipped"].includes(status)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/steps/${target}/status`, signal, {
    method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Request-ID": correlationId }, body: stringifyApiJson({ version, status }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (value) => {
    const result = parseTaskSteps(value, project, task);
    if (response.status !== 200 || result.version !== version && result.version !== version + 1n || result.steps.find((step) => step.id === target)?.status !== status) throw new ApiError("protocol", response.status);
    return result;
  }, undefined, true, admission.onWriteRejected);
};

export type AddStepInput = { readonly id: string; readonly title: string; readonly description: string; readonly status: StepStatus; readonly version: bigint; readonly placement?: { readonly before: string } | { readonly after: string } };

export const deleteTaskStep = async (projectId: string, taskId: string, stepId: string, version: bigint, signal: AbortSignal, admission: TaskResponseAdmission, correlationId: string): Promise<StepsResource> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const target = stepId.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(target) || !isTaskVersion(version)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/steps/${target}`, signal, {
    method: "DELETE", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Request-ID": correlationId }, body: stringifyApiJson({ version }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (value) => {
    const result = parseTaskSteps(value, project, task);
    if (response.status !== 200 || result.version !== version + 1n || result.steps.some((step) => step.id === target)) throw new ApiError("protocol", response.status);
    return result;
  }, undefined, true, admission.onWriteRejected);
};

export const editTaskStep = async (projectId: string, taskId: string, stepId: string, title: string, description: string, version: bigint, signal: AbortSignal, admission: TaskResponseAdmission, correlationId: string): Promise<StepsResource> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const target = stepId.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(target) || !isTaskVersion(version) || !/[^\p{White_Space}]/u.test(title) ||
    [title, description].some((value) => value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/steps/${target}`, signal, {
    method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Request-ID": correlationId }, body: stringifyApiJson({ version, title, description }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (value) => {
    const result = parseTaskSteps(value, project, task);
    const targetStep = result.steps.find((step) => step.id === target);
    if (response.status !== 200 || result.version !== version && result.version !== version + 1n || targetStep?.title !== title || targetStep.description !== description) throw new ApiError("protocol", response.status);
    return result;
  }, undefined, true, admission.onWriteRejected);
};

export const addTaskStep = async (projectId: string, taskId: string, input: AddStepInput, signal: AbortSignal, admission: TaskResponseAdmission, correlationId: string): Promise<StepsResource> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const target = input.id.toLowerCase();
  const placement = input.placement === undefined ? undefined : "before" in input.placement ? { before: input.placement.before.toLowerCase() } : { after: input.placement.after.toLowerCase() };
  if (!/^[0-9a-f]{8}$/.test(target) || !isTaskVersion(input.version) || !["todo", "in_progress", "done", "skipped"].includes(input.status) ||
    (placement !== undefined && !/^[0-9a-f]{8}$/.test("before" in placement ? placement.before : placement.after)) ||
    !/[^\p{White_Space}]/u.test(input.title) || [input.title, input.description].some((value) => value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))) throw new ApiError("protocol");
  const path = `/api/v1/projects/${project}/tasks/${task}/steps`;
  const response = await request(path, signal, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Request-ID": correlationId },
    body: stringifyApiJson({ version: input.version, id: target, title: input.title, description: input.description, status: input.status, ...placement }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 201) admission.onWriteConfirmed?.();
  return json(response, signal, (value) => {
    const result = parseTaskSteps(value, project, task);
    const index = result.steps.findIndex((item) => item.id === target);
    const added = result.steps[index];
    const positionValid = placement === undefined ? index === result.steps.length - 1 : "before" in placement ? result.steps[index + 1]?.id === placement.before : index > 0 && result.steps[index - 1]?.id === placement.after;
    if (response.status !== 201 || response.headers.get("Location") !== `${path}/${target}` || result.version !== input.version + 1n ||
      !positionValid || added?.id !== target || added.title !== input.title || added.description !== input.description || added.status !== input.status || added.createdAt !== added.updatedAt) throw new ApiError("protocol", response.status);
    return result;
  }, undefined, true, admission.onWriteRejected);
};

export const moveTaskStep = async (projectId: string, taskId: string, stepId: string, placement: StepPlacement, version: bigint, signal: AbortSignal, admission: TaskResponseAdmission, correlationId: string): Promise<StepsResource> => {
  const project = requestId(projectId);
  const task = requestId(taskId);
  const target = stepId.toLowerCase();
  const normalized = "before" in placement ? { before: placement.before.toLowerCase() } : "after" in placement ? { after: placement.after.toLowerCase() } : placement;
  if (!/^[0-9a-f]{8}$/.test(target) || !isTaskVersion(version) ||
    ("before" in normalized ? !/^[0-9a-f]{8}$/.test(normalized.before) : "after" in normalized ? !/^[0-9a-f]{8}$/.test(normalized.after) : normalized.position !== "first" && normalized.position !== "last")) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${project}/tasks/${task}/steps/${target}/position`, signal, {
    method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Request-ID": correlationId }, body: stringifyApiJson({ version, ...normalized }),
  }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.status === 200) admission.onWriteConfirmed?.();
  return json(response, signal, (value) => {
    const result = parseTaskSteps(value, project, task);
    if (response.status !== 200 || result.version !== version && result.version !== version + 1n || !result.steps.some((step) => step.id === target)) throw new ApiError("protocol", response.status);
    return result;
  }, undefined, true, admission.onWriteRejected);
};
