import { searchTeamMemberCandidates } from "../../../api/team-member-search";
import { useMemberSearch, type MemberSearchOptions } from "../../member-search/useMemberSearch";

export { normalizeMemberQuery } from "../../member-search/useMemberSearch";

type Options = Omit<MemberSearchOptions, "resourceId" | "search"> & { readonly teamId: string };

export const useTeamMemberSearch = ({ teamId, ...options }: Options) =>
  useMemberSearch({ ...options, resourceId: teamId, search: searchTeamMemberCandidates });
