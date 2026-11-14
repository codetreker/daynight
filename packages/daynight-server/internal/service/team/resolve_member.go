package team

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

func (s *DirectMembers) ResolveMember(ctx context.Context, p model.Principal, id string, input core.ResolveTeamMember) (*model.TeamMember, error) {
	id, externalID, err := core.ValidateResolveMember(p, id, input)
	if err != nil {
		return nil, err
	}
	var member *model.TeamMember
	err = s.strict(ctx, id, func(scope store.TeamWriteScope) error {
		if err := s.lockCredential(ctx, scope, p); err != nil {
			return err
		}
		var err error
		member, err = core.ResolveMember(ctx, scope.TeamDAO(), p, externalID)
		if err != nil {
			return err
		}
		return s.lockCredential(ctx, scope, p)
	})
	if err != nil {
		return nil, err
	}
	return member, nil
}
