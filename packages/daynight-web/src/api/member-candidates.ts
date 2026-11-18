import { ApiError, assertResponsePrincipal, json, request, requestId } from "./client";
import { parseTeamMemberProfile } from "./teams";
import type { TeamMember } from "./teams";
import { array, id, malformed, record, string } from "./validation";

export type MemberCandidate = { readonly userId: string; readonly profile: TeamMember["profile"] };
export type MemberCandidatePage = { readonly items: readonly MemberCandidate[]; readonly nextCursor: string | null; readonly actorRole: "admin" };

const exact = (data: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(data).some((key) => !keys.includes(key))) malformed();
};
export const memberSearchId = (value: string): string => {
  const parsed = requestId(value);
  if (parsed === "00000000-0000-0000-0000-000000000000") throw new ApiError("protocol");
  return parsed;
};
const cursorValue = (value: unknown): string => {
  const cursor = string(value);
  if (cursor === "" || !cursor.isWellFormed() || cursor.includes("\0") || new TextEncoder().encode(cursor).length > 2048) return malformed();
  return cursor;
};
export const sendMemberSearchRequest = async <T>(url: string, user: string, body: object, signal: AbortSignal, onMismatch: () => void, parse: (value: unknown) => T, onDispatch?: () => void, decode?: (response: Response) => Promise<unknown>): Promise<T> => {
  const response = await request(url, signal, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) }, onDispatch);
  assertResponsePrincipal(response, user, onMismatch);
  if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
  try { return await json(response, signal, parse, decode); }
  catch (error) {
    if (error instanceof ApiError && error.code === "identity_mismatch") onMismatch();
    throw error;
  }
};

export const searchMemberCandidates = (resource: "teams" | "projects", resourceId: string, userId: string, query: string, cursor: string | null, signal: AbortSignal, onMismatch: () => void): Promise<MemberCandidatePage> => {
  const owner = memberSearchId(resourceId), user = memberSearchId(userId);
  if (!query.isWellFormed() || query.includes("\0") || new TextEncoder().encode(query.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")).length > 1024) throw new ApiError("protocol");
  if (cursor !== null) cursorValue(cursor);
  return sendMemberSearchRequest(`/api/v1/${resource}/${owner}/member-candidates/search`, user, { expectedUserId: user, query, limit: 20, ...(cursor === null ? {} : { cursor }) }, signal, onMismatch, (value) => {
    const data = record(value); exact(data, ["items", "nextCursor", "actorRole"]);
    const items = array(data.items, (item): MemberCandidate => {
      const candidate = record(item); exact(candidate, ["userId", "profile"]);
      const candidateId = id(candidate.userId);
      if (candidateId === "00000000-0000-0000-0000-000000000000") return malformed();
      return { userId: candidateId, profile: parseTeamMemberProfile(candidate.profile) };
    });
    if (items.length > 20 || new Set(items.map((item) => item.userId)).size !== items.length || data.actorRole !== "admin") return malformed();
    return { items, nextCursor: data.nextCursor === null ? null : cursorValue(data.nextCursor), actorRole: "admin" };
  });
};
