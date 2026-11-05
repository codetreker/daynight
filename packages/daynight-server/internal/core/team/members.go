package team

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ChangeTeamMember struct {
	Version        int64
	Role           model.ProjectRole
	ExpectedUserID string
}
type TeamMemberResult struct {
	Membership model.TeamMember
	ActorRole  *model.ProjectRole
}

func Members(ctx context.Context, dao store.TeamReader, p model.Principal, id string) ([]model.TeamMemberProfile, error) {
	if _, err := Get(ctx, dao, p, id); err != nil {
		return nil, err
	}
	return dao.TeamMembers(ctx, id)
}
func ValidateMemberChange(p model.Principal, id, userID string, input ChangeTeamMember, remove bool) (string, string, error) {
	if err := RequireActor(p, input.ExpectedUserID); err != nil {
		return "", "", err
	}
	id, err := CanonicalID(id)
	if err != nil {
		return "", "", err
	}
	target, err := model.CanonicalID(userID)
	if err != nil || target != userID {
		return "", "", invalidInput("User ID must be a canonical UUID.")
	}
	if input.Version < 1 {
		return "", "", invalidInput("Version must be a positive integer.")
	}
	if !remove && input.Role != model.ProjectAdmin && input.Role != model.ProjectMemberRole {
		return "", "", invalidInput("Role must be admin or member.")
	}
	return id, target, nil
}
func ChangeMember(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, target string, input ChangeTeamMember, remove bool) (TeamMemberResult, error) {
	t, err := dao.Team(ctx, p.UserID)
	if err != nil {
		return TeamMemberResult{}, err
	}
	if t.Kind == "personal" {
		return TeamMemberResult{}, &model.Fault{Code: "personal_team_immutable", Message: "Personal Team membership cannot be changed."}
	}
	if t.Membership.Role != model.ProjectAdmin && (!remove || target != p.UserID) {
		return TeamMemberResult{}, &model.Fault{Code: "forbidden", Message: "Team administrator access is required."}
	}
	member, err := dao.Member(ctx, target)
	if errors.Is(err, model.ErrNotFound) {
		return TeamMemberResult{}, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
	}
	if err != nil {
		return TeamMemberResult{}, err
	}
	if member.Version != input.Version {
		return TeamMemberResult{}, &model.Fault{Code: "version_conflict", Message: "Team member version does not match."}
	}
	if member.Role == model.ProjectAdmin && (remove || input.Role != model.ProjectAdmin) {
		count, err := dao.AdminCount(ctx)
		if err != nil {
			return TeamMemberResult{}, err
		}
		if count <= 1 {
			return TeamMemberResult{}, &model.Fault{Code: "last_admin", Message: "Team must retain an administrator."}
		}
	}
	role := t.Membership.Role
	if remove {
		if err := dao.RemoveMember(ctx, target); err != nil {
			return TeamMemberResult{}, err
		}
		result := TeamMemberResult{Membership: member}
		if target != p.UserID {
			result.ActorRole = &role
		}
		return result, nil
	}
	if member.Role != input.Role {
		member, err = dao.SetMemberRole(ctx, target, input.Role)
		if err != nil {
			return TeamMemberResult{}, err
		}
	}
	if target == p.UserID {
		role = member.Role
	}
	return TeamMemberResult{Membership: member, ActorRole: &role}, nil
}
