package team

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ResolveTeamMember struct {
	ExpectedUserID string
	ExternalUserID string
}

func ValidateResolveMember(p model.Principal, id string, input ResolveTeamMember) (string, string, error) {
	id, err := validateMemberActor(p, id, input.ExpectedUserID)
	if err != nil {
		return "", "", err
	}
	user, err := identity.ValidateExternalUser(model.User{UniAuthID: input.ExternalUserID})
	if err != nil {
		return "", "", err
	}
	return id, user.UniAuthID, nil
}

func ResolveMember(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, externalID string) (*model.TeamMember, error) {
	if err := AuthorizeAddMember(ctx, dao, p); err != nil {
		return nil, err
	}
	member, err := dao.MemberByExternalID(ctx, externalID)
	if errors.Is(err, model.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &member, nil
}
