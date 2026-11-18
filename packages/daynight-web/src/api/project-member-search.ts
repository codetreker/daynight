import { parseParticipant, parseProjectAccess, projectAccessSource, sameGrant } from "./auth-parse";
import type { ProjectAccess, ProjectParticipant } from "./auth-types";
import { jsonObjectSources } from "./json-source";
import { memberSearchId, searchMemberCandidates, sendMemberSearchRequest } from "./member-candidates";
import type { MemberCandidatePage } from "./member-candidates";
import { boolean, malformed, record } from "./validation";

export type ProjectMemberCandidatePage = MemberCandidatePage;
export type AddExistingProjectMemberReceipt = { readonly added: boolean; readonly participant: ProjectParticipant; readonly actorAccess: ProjectAccess };

export const searchProjectMemberCandidates = (projectId: string, userId: string, query: string, cursor: string | null, signal: AbortSignal, onMismatch: () => void): Promise<ProjectMemberCandidatePage> =>
  searchMemberCandidates("projects", projectId, userId, query, cursor, signal, onMismatch);

const decodeReceipt = async (response: Response): Promise<unknown> => {
  const text = await response.text(), data = record(JSON.parse(text)), fields = jsonObjectSources(text);
  if (Object.hasOwn(data, "participant")) data.participant = projectAccessSource(fields.get("participant")!);
  if (Object.hasOwn(data, "actorAccess")) data.actorAccess = projectAccessSource(fields.get("actorAccess")!);
  return data;
};

export const addExistingProjectMember = (userId: string, projectId: string, targetUserId: string, signal: AbortSignal, onMismatch: () => void, onDispatch: () => void): Promise<AddExistingProjectMemberReceipt> => {
  const user = memberSearchId(userId), project = memberSearchId(projectId), target = memberSearchId(targetUserId);
  return sendMemberSearchRequest(`/api/v1/projects/${project}/members/${target}`, user, { expectedUserId: user }, signal, onMismatch, (value) => {
    const data = record(value);
    if (Object.keys(data).some((key) => !["added", "participant", "actorAccess"].includes(key))) return malformed();
    const added = boolean(data.added), actorAccess = parseProjectAccess(data.actorAccess, project, user);
    const participant = parseParticipant(data.participant, project, actorAccess);
    if (actorAccess.effectiveRole !== "admin" || participant.userId !== target ||
      added && (participant.directGrant?.role !== "member" || participant.inheritedFrom !== null) ||
      target === user && (added || participant.effectiveRole !== actorAccess.effectiveRole ||
        participant.inheritedFrom?.role !== (actorAccess.teamRole ?? undefined) || !sameGrant(participant.directGrant, actorAccess.directGrant))) return malformed();
    return { added, participant, actorAccess };
  }, onDispatch, decodeReceipt);
};
