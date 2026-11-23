package team

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ExistingMemberResult struct {
	Membership model.TeamMemberProfile
	Added      bool
}

// ValidateAddExistingMember checks the actor fence and both path identifiers.
func ValidateAddExistingMember(p model.Principal, teamID, expectedUserID, targetID string) (string, error) {
	id, err := validateMemberActor(p, teamID, expectedUserID)
	if err != nil {
		return "", err
	}
	if !canonicalNonzeroID(targetID) {
		return "", invalidInput("User ID must be a nonzero canonical UUID.")
	}
	return id, nil
}

// AddExistingMember preserves any existing role and never initializes an account.
// The caller must execute this operation within the Team write scope.
func AddExistingMember(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, target string) (ExistingMemberResult, error) {
	if err := AuthorizeAddMember(ctx, dao, p); err != nil {
		return ExistingMemberResult{}, err
	}
	candidate, err := dao.MemberCandidate(ctx, target)
	if errors.Is(err, model.ErrNotFound) {
		return ExistingMemberResult{}, &model.Fault{Code: "user_not_found", Message: "User was not found.", Cause: err}
	}
	if err != nil {
		return ExistingMemberResult{}, err
	}
	member, err := dao.Member(ctx, target)
	added := false
	if errors.Is(err, model.ErrNotFound) {
		member, err = dao.AddMember(ctx, target, model.ProjectMemberRole)
		added = true
		if errors.Is(err, model.ErrNotFound) {
			return ExistingMemberResult{}, &model.Fault{Code: "user_not_found", Message: "User was not found.", Cause: err}
		}
	}
	if err != nil {
		return ExistingMemberResult{}, err
	}
	return ExistingMemberResult{Membership: model.TeamMemberProfile{Membership: member, Profile: candidate.Profile}, Added: added}, nil
}
