import type { TeamMember } from "../../../api/teams";
import { MemberSearch, type MemberAdditionPresentation } from "../../member-search/MemberSearch";
import { useTeamMemberSearch } from "./useTeamMemberSearch";

export type { MemberAdditionPresentation } from "../../member-search/MemberSearch";

type Props = Parameters<typeof useTeamMemberSearch>[0] & {
  readonly members: readonly TeamMember[];
  readonly addition: MemberAdditionPresentation;
  readonly onAdd: (userId: string) => void;
  readonly onCheck: () => void;
};

export const TeamMemberSearch = (props: Props) => {
  const search = useTeamMemberSearch(props);
  return <MemberSearch {...props} scope="team" search={search} />;
};
