import { decodeMemberReceipt, parseTeamMember } from "./teams";
import type { TeamMember } from "./teams";
import { memberSearchId, searchMemberCandidates, sendMemberSearchRequest } from "./member-candidates";
import type { MemberCandidate, MemberCandidatePage } from "./member-candidates";
import { malformed, record } from "./validation";

export type TeamMemberCandidate = MemberCandidate;
export type TeamMemberCandidatePage = MemberCandidatePage;
export type AddExistingTeamMemberReceipt = { readonly membership: TeamMember; readonly added: boolean; readonly actorRole: "admin" };

const exact = (data: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(data).some((key) => !keys.includes(key))) malformed();
};

export const searchTeamMemberCandidates = (teamId: string, userId: string, query: string, cursor: string | null, signal: AbortSignal, onMismatch: () => void): Promise<TeamMemberCandidatePage> =>
  searchMemberCandidates("teams", teamId, userId, query, cursor, signal, onMismatch);

export const addExistingTeamMember = (userId: string, teamId: string, targetUserId: string, signal: AbortSignal, onMismatch: () => void, onDispatch: () => void): Promise<AddExistingTeamMemberReceipt> => {
  const user = memberSearchId(userId), team = memberSearchId(teamId), target = memberSearchId(targetUserId);
  return sendMemberSearchRequest(`/api/v1/teams/${team}/members/${target}`, user, { expectedUserId: user }, signal, onMismatch, (value) => {
    const data = record(value); exact(data, ["membership", "added", "actorRole"]);
    const membership = parseTeamMember(data.membership, team);
    if (membership.userId !== target || typeof data.added !== "boolean" || data.added && membership.role !== "member" || data.actorRole !== "admin") return malformed();
    return { membership, added: data.added, actorRole: "admin" };
  }, onDispatch, decodeMemberReceipt);
};
