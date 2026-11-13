import { ApiError, assertResponsePrincipal, json, read, request, requestId, type TaskResponseAdmission } from "./client";
import { isTaskVersion, stringifyApiJson } from "./json";
import { project } from "./parse";
import { decodeProjectJson } from "./project-json";
import type { Project } from "./types";

export const isExecutionWarningMinutes = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

const boundProject = (data: unknown, id: string): Project => {
  const value = project(data);
  if (value.id !== id) throw new ApiError("protocol");
  return value;
};

export const getProject = (projectId: string, signal: AbortSignal, admission?: TaskResponseAdmission, onDispatch?: () => void): Promise<Project> => {
  const id = requestId(projectId);
  if (admission === undefined) return read(`/api/v1/projects/${id}`, signal, (data) => boundProject(data, id), decodeProjectJson);
  return request(`/api/v1/projects/${id}`, signal, { headers: { Accept: "application/json" } }, onDispatch).then((response) => {
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    return json(response, signal, (data) => boundProject(data, id), decodeProjectJson);
  });
};

export const saveProjectSettings = async (
  projectId: string,
  input: { readonly version: bigint; readonly executionWarningMinutes: number },
  signal: AbortSignal,
  onDispatch?: () => void,
  admission?: TaskResponseAdmission & { readonly onConfirmed?: (project: Project) => void; readonly onRejected?: (error: ApiError) => void },
): Promise<Project> => {
  const id = requestId(projectId);
  if (!isTaskVersion(input.version) || !isExecutionWarningMinutes(input.executionWarningMinutes)) throw new ApiError("protocol");
  const response = await request(`/api/v1/projects/${id}/settings`, signal, {
    method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson(input),
  }, onDispatch);
  if (admission !== undefined) assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, (data) => {
    const saved = boundProject(data, id);
    if (response.status !== 200 || saved.settings.executionWarningMinutes !== input.executionWarningMinutes
      || (saved.settings.version !== input.version && saved.settings.version !== input.version + 1n)) throw new ApiError("protocol", response.status);
    admission?.onConfirmed?.(saved);
    return saved;
  }, decodeProjectJson, false, admission?.onRejected);
};
