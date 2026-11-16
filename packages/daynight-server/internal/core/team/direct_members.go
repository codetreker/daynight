package team

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type AddTeamMember struct {
	ExpectedUserID string
	User           model.User
	Role           model.ProjectRole
}

type DirectMemberResult struct {
	Membership model.TeamMember
	Added      bool
}

func ValidateAddMember(p model.Principal, id, expected string, role model.ProjectRole) (string, error) {
	id, err := validateMemberActor(p, id, expected)
	if err != nil {
		return "", err
	}
	if role != model.ProjectAdmin && role != model.ProjectMemberRole {
		return "", invalidInput("Role must be admin or member.")
	}
	return id, nil
}

func validateMemberActor(p model.Principal, id, expected string) (string, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return "", err
	}
	if canonical, err := model.CanonicalID(expected); err != nil || canonical != expected || canonical == uuid.Nil.String() {
		return "", invalidInput("expectedUserId must be a nonzero canonical user UUID.")
	}
	if err := RequireActor(p, expected); err != nil {
		return "", err
	}
	id, err := CanonicalID(id)
	if err != nil {
		return "", err
	}
	if id == uuid.Nil.String() {
		return "", invalidInput("Team ID must be a nonzero canonical UUID.")
	}
	return id, nil
}

func AuthorizeAddMember(ctx context.Context, dao store.TeamWriteDAO, p model.Principal) error {
	t, err := dao.Team(ctx, p.UserID)
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
	}
	if err != nil {
		return err
	}
	if t.Membership.Role != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Team administrator access is required."}
	}
	if t.Kind != "ordinary" {
		return &model.Fault{Code: "personal_team_immutable", Message: "Personal Team membership cannot be changed."}
	}
	return nil
}

func AddMember(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, target string, role model.ProjectRole) (DirectMemberResult, error) {
	if err := AuthorizeAddMember(ctx, dao, p); err != nil {
		return DirectMemberResult{}, err
	}
	member, err := dao.Member(ctx, target)
	if err == nil {
		if member.Role != role {
			return DirectMemberResult{}, &model.Fault{Code: "resource_conflict", Message: "Team member already has a different role. Read its current version before changing the role."}
		}
		return DirectMemberResult{Membership: member}, nil
	}
	if !errors.Is(err, model.ErrNotFound) {
		return DirectMemberResult{}, err
	}
	member, err = dao.AddMember(ctx, target, role)
	if err != nil {
		return DirectMemberResult{}, err
	}
	return DirectMemberResult{Membership: member, Added: true}, nil
}
