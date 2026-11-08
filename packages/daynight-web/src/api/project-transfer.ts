import { parseProjectAccess, parseRole, projectAccessSource } from "./auth-parse";
import type { ProjectAccess, ProjectOwnership, ProjectRole, TeamRef } from "./auth-types";
import { ApiError, assertResponsePrincipal, json, request, requestId } from "./client";
import { isTaskVersion, parseApiJson } from "./json";
import { jsonObjectSources } from "./json-source";
import { parseProjectOwnership, parseTeamRef } from "./team-parse";
import { boolean, id, malformed, record } from "./validation";

export type ProjectTransferPreview = {
  readonly sourceTeam: TeamRef;
  readonly targetTeam: TeamRef & { readonly version: bigint };
  readonly ownership: ProjectOwnership;
  readonly actorRole: ProjectRole | null;
};
export type ProjectTransferReceipt = {
  readonly projectId: string;
  readonly changed: boolean;
  readonly sourceTeam: TeamRef;
  readonly ownerTeam: TeamRef;
  readonly ownership: ProjectOwnership;
  readonly actorAccess: ProjectAccess | null;
};

const exact = (data: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(data).some((key) => !keys.includes(key))) return malformed();
};
const sameTeam = (a: TeamRef, b: TeamRef): boolean => a.id === b.id && a.kind === b.kind && a.name === b.name;

const decodeTransfer = async (response: Response): Promise<unknown> => {
  const text = await response.text(), data = record(JSON.parse(text)), fields = jsonObjectSources(text);
  if (Object.hasOwn(data, "targetTeam")) data.targetTeam = parseApiJson(fields.get("targetTeam")!);
  if (Object.hasOwn(data, "ownership")) data.ownership = parseApiJson(fields.get("ownership")!);
  if (Object.hasOwn(data, "actorAccess") && data.actorAccess !== null) data.actorAccess = projectAccessSource(fields.get("actorAccess")!);
  return data;
};

const parsePreview = (value: unknown, targetId: string): ProjectTransferPreview => {
  const data = record(value); exact(data, ["sourceTeam", "targetTeam", "ownership", "actorRole"]);
  const sourceTeam = parseTeamRef(data.sourceTeam), targetData = record(data.targetTeam);
  exact(targetData, ["id", "kind", "name", "version"]);
  const targetTeam = { ...parseTeamRef({ id: targetData.id, kind: targetData.kind, name: targetData.name }), version: targetData.version };
  const ownership = parseProjectOwnership(data.ownership);
  const actorRole = data.actorRole === null ? null : parseRole(data.actorRole);
  if (!isTaskVersion(targetTeam.version) || targetTeam.id !== targetId || sourceTeam.id !== ownership.teamId ||
    (sourceTeam.id === targetTeam.id && (!sameTeam(sourceTeam, targetTeam) || actorRole !== "admin"))) return malformed();
  return { sourceTeam, targetTeam: { ...targetTeam, version: targetTeam.version }, ownership, actorRole };
};

const parseReceipt = (value: unknown, projectId: string, userId: string, preview: ProjectTransferPreview): ProjectTransferReceipt => {
  const data = record(value); exact(data, ["projectId", "changed", "sourceTeam", "ownerTeam", "ownership", "actorAccess"]);
  const receipt: ProjectTransferReceipt = {
    projectId: id(data.projectId), changed: boolean(data.changed), sourceTeam: parseTeamRef(data.sourceTeam),
    ownerTeam: parseTeamRef(data.ownerTeam), ownership: parseProjectOwnership(data.ownership),
    actorAccess: data.actorAccess === null ? null : parseProjectAccess(data.actorAccess, projectId, userId),
  };
  const changed = preview.ownership.teamId !== preview.targetTeam.id;
  if (receipt.projectId !== projectId || receipt.changed !== changed || receipt.sourceTeam.id !== preview.ownership.teamId ||
    !sameTeam(receipt.ownerTeam, preview.targetTeam) || receipt.ownership.teamId !== preview.targetTeam.id ||
    receipt.ownership.version !== preview.ownership.version + (changed ? 1n : 0n) ||
    (!changed && (!sameTeam(receipt.sourceTeam, receipt.ownerTeam) || receipt.actorAccess?.teamRole !== "admin")) ||
    (receipt.actorAccess !== null && (!sameTeam(receipt.actorAccess.ownerTeam, receipt.ownerTeam) ||
      receipt.actorAccess.ownership.teamId !== receipt.ownership.teamId || receipt.actorAccess.ownership.version !== receipt.ownership.version))) return malformed();
  return receipt;
};

export const previewProjectTransfer = (projectId: string, targetTeamId: string, userId: string, signal: AbortSignal, onMismatch: () => void): Promise<ProjectTransferPreview> => {
  const project = requestId(projectId), target = requestId(targetTeamId), user = requestId(userId);
  return (async () => {
    const response = await request(`/api/v1/projects/${project}/transfer-preview`, signal, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ targetTeamId: target }),
    });
    assertResponsePrincipal(response, user, onMismatch);
    if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
    return json(response, signal, (value) => parsePreview(value, target), decodeTransfer);
  })();
};

export const transferProject = (projectId: string, preview: ProjectTransferPreview, userId: string, signal: AbortSignal, onMismatch: () => void, onDispatch: () => void): Promise<ProjectTransferReceipt> => {
  const project = requestId(projectId), user = requestId(userId), source = requestId(preview.ownership.teamId), target = requestId(preview.targetTeam.id);
  if (!isTaskVersion(preview.ownership.version) || !isTaskVersion(preview.targetTeam.version) || preview.sourceTeam.id !== source) throw new ApiError("protocol");
  const body = `{"ownership":{"teamId":${JSON.stringify(source)},"version":${preview.ownership.version}},"targetTeam":{"id":${JSON.stringify(target)},"version":${preview.targetTeam.version}},"expectedUserId":${JSON.stringify(user)}}`;
  return (async () => {
    const response = await request(`/api/v1/projects/${project}/transfer`, signal, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body,
    }, onDispatch);
    assertResponsePrincipal(response, user, onMismatch);
    if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
    try { return await json(response, signal, (value) => parseReceipt(value, project, user, preview), decodeTransfer); }
    catch (error) {
      if (error instanceof ApiError && error.code === "identity_mismatch") onMismatch();
      throw error;
    }
  })();
};
