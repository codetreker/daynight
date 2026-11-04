package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ChangeTeamMember struct {
	Version        int64
	Role           core.ProjectRole
	ExpectedUserID string
}

type TeamMemberResult struct {
	Membership core.TeamMember
	ActorRole  *core.ProjectRole
}

func (s *Teams) Members(ctx context.Context, principal core.Principal, teamID string) ([]core.TeamMemberProfile, error) {
	if err := requirePrincipal(principal); err != nil {
		return nil, err
	}
	id, err := canonicalTeamID(teamID)
	if err != nil {
		return nil, err
	}
	var result []core.TeamMemberProfile
	var missing error
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		if _, err := snapshot.Team(ctx, principal.UserID, id); err != nil {
			if errors.Is(err, core.ErrNotFound) {
				missing = err
				return nil
			}
			return err
		}
		var err error
		result, err = snapshot.TeamMembers(ctx, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	if missing != nil {
		return nil, &Fault{Code: "not_found", Message: "Team was not found.", Cause: missing}
	}
	return result, nil
}

func (s *Teams) changeMember(ctx context.Context, principal core.Principal, teamID, userID string, input ChangeTeamMember, remove bool) (TeamMemberResult, error) {
	if err := requireTeamActor(principal, input.ExpectedUserID); err != nil {
		return TeamMemberResult{}, err
	}
	id, err := canonicalTeamID(teamID)
	if err != nil {
		return TeamMemberResult{}, err
	}
	target, err := CanonicalID(userID)
	if err != nil || target != userID {
		return TeamMemberResult{}, invalidInput("User ID must be a canonical UUID.")
	}
	if input.Version < 1 {
		return TeamMemberResult{}, invalidInput("Version must be a positive integer.")
	}
	if !remove && input.Role != core.ProjectAdmin && input.Role != core.ProjectMemberRole {
		return TeamMemberResult{}, invalidInput("Role must be admin or member.")
	}
	var result TeamMemberResult
	err = s.store.WriteTeam(ctx, id, func(tx *store.TeamTx) error {
		team, err := tx.Team(ctx, principal.UserID)
		if err != nil {
			return err
		}
		if team.Kind == "personal" {
			return &Fault{Code: "personal_team_immutable", Message: "Personal Team membership cannot be changed."}
		}
		if team.Membership.Role != core.ProjectAdmin && (!remove || target != principal.UserID) {
			return &Fault{Code: "forbidden", Message: "Team administrator access is required."}
		}
		member, err := tx.Member(ctx, target)
		if errors.Is(err, core.ErrNotFound) {
			return &Fault{Code: "not_found", Message: "Team member was not found.", Cause: err}
		}
		if err != nil {
			return err
		}
		if member.Version != input.Version {
			return &Fault{Code: "version_conflict", Message: "Team member version does not match."}
		}
		if member.Role == core.ProjectAdmin && (remove || input.Role != core.ProjectAdmin) {
			count, err := tx.AdminCount(ctx)
			if err != nil {
				return err
			}
			if count <= 1 {
				return &Fault{Code: "last_admin", Message: "Team must retain an administrator."}
			}
		}
		role := team.Membership.Role
		if remove {
			if err := tx.RemoveMember(ctx, target); err != nil {
				return err
			}
			if target != principal.UserID {
				result.ActorRole = &role
			}
			result.Membership = member
			return nil
		}
		if member.Role != input.Role {
			member, err = tx.SetMemberRole(ctx, target, input.Role)
			if err != nil {
				return err
			}
		}
		if target == principal.UserID {
			role = member.Role
		}
		result = TeamMemberResult{Membership: member, ActorRole: &role}
		return nil
	})
	if err != nil {
		return TeamMemberResult{}, err
	}
	return result, nil
}

func (s *Teams) SetMemberRole(ctx context.Context, principal core.Principal, teamID, userID string, input ChangeTeamMember) (TeamMemberResult, error) {
	return s.changeMember(ctx, principal, teamID, userID, input, false)
}
func (s *Teams) RemoveMember(ctx context.Context, principal core.Principal, teamID, userID string, input ChangeTeamMember) (TeamMemberResult, error) {
	return s.changeMember(ctx, principal, teamID, userID, input, true)
}
