package team

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
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

// MemberPage is a bounded directory in membership creation order.
type MemberPage struct {
	Items      []model.TeamMemberProfile
	NextCursor *string
	Oversized  *model.TeamMember
}

func memberScope(p model.Principal, id string) query.ListScope {
	return query.ListScope{Kind: "team_members", UserID: p.UserID, TeamID: id}
}

// EncodeMemberCursor binds a position to the actor and selected Team.
func EncodeMemberCursor(p model.Principal, id string, member model.TeamMemberProfile) (string, error) {
	return query.EncodeListCursor(memberScope(p, id), member.Membership.CreatedAt, member.Membership.UserID)
}

func MembersPage(ctx context.Context, dao store.TeamReader, p model.Principal, id string, request model.PageRequest) (MemberPage, error) {
	page, err := query.ListPage(request, memberScope(p, id))
	if err != nil {
		return MemberPage{}, err
	}
	if err := teamAccess(ctx, dao, p, id); err != nil {
		return MemberPage{}, err
	}
	result, err := dao.TeamMembersPage(ctx, id, page)
	if err != nil {
		return MemberPage{}, err
	}
	if result.Oversized != nil {
		return MemberPage{Items: result.Items, Oversized: result.Oversized}, nil
	}
	response := MemberPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := EncodeMemberCursor(p, id, last)
		if err != nil {
			return MemberPage{}, fmt.Errorf("encode Team member cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}

func teamAccess(ctx context.Context, dao store.TeamReader, p model.Principal, id string) error {
	err := dao.TeamAccess(ctx, p.UserID, id)
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
	}
	return err
}

func Member(ctx context.Context, dao store.TeamReader, p model.Principal, id, userID string) (model.TeamMember, error) {
	if err := teamAccess(ctx, dao, p, id); err != nil {
		return model.TeamMember{}, err
	}
	member, err := dao.InvitationTeamMember(ctx, id, userID)
	if errors.Is(err, model.ErrNotFound) {
		return model.TeamMember{}, &model.Fault{Code: "not_found", Message: "Team member was not found.", Cause: err}
	}
	return member, err
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
