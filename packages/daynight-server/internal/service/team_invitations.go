package service

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const teamInvitationPrefix = "dnteam_"

type MintedTeamInvitation struct {
	Invitation core.TeamInvitation
	Secret     string
}
type TeamInvitationInspection struct {
	Team       core.TeamRef
	Membership *core.TeamMember
}
type TeamInvitationAcceptance struct {
	Team             core.TeamRef
	Membership       core.TeamMember
	Joined, Consumed bool
}

func teamInvitationAvailable(i core.TeamInvitation, now time.Time) bool {
	return i.ConsumedAt == nil && i.RevokedAt == nil && i.ExpiresAt.After(now)
}
func requireOrdinaryTeamAdmin(team core.Team) error {
	if team.Membership.Role != core.ProjectAdmin {
		return &Fault{Code: "forbidden", Message: "Team administrator access is required."}
	}
	if team.Kind == "personal" {
		return &Fault{Code: "personal_team_immutable", Message: "Personal Team invitations are unavailable."}
	}
	return nil
}
func (s *Teams) CreateInvitation(ctx context.Context, p core.Principal, teamID, expected string) (MintedTeamInvitation, error) {
	if err := requireTeamActor(p, expected); err != nil {
		return MintedTeamInvitation{}, err
	}
	id, err := canonicalTeamID(teamID)
	if err != nil {
		return MintedTeamInvitation{}, err
	}
	var result MintedTeamInvitation
	err = s.store.WriteTeam(ctx, id, func(tx *store.TeamTx) error {
		team, err := tx.Team(ctx, p.UserID)
		if err != nil {
			return err
		}
		if err = requireOrdinaryTeamAdmin(team); err != nil {
			return err
		}
		now := time.Now().UTC()
		result.Secret = randomSecret(teamInvitationPrefix)
		result.Invitation = core.TeamInvitation{ID: uuid.NewString(), TeamID: id, CreatedBy: p.UserID, TokenHash: secretHash(result.Secret), CreatedAt: now, ExpiresAt: now.Add(InvitationLifetime)}
		return tx.CreateInvitation(ctx, result.Invitation)
	})
	if err != nil {
		return MintedTeamInvitation{}, err
	}
	result.Invitation.TokenHash = nil
	return result, nil
}
func (s *Teams) ListInvitations(ctx context.Context, p core.Principal, teamID string) ([]core.TeamInvitation, error) {
	if err := requirePrincipal(p); err != nil {
		return nil, err
	}
	id, err := canonicalTeamID(teamID)
	if err != nil {
		return nil, err
	}
	var result []core.TeamInvitation
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		team, err := snapshot.Team(ctx, p.UserID, id)
		if err != nil {
			return err
		}
		if err = requireOrdinaryTeamAdmin(team); err != nil {
			return err
		}
		result, err = snapshot.TeamInvitations(ctx, id, time.Now().UTC())
		return err
	})
	return result, err
}
func (s *Teams) RevokeInvitation(ctx context.Context, p core.Principal, teamID, invitationID, expected string) (bool, error) {
	if err := requireTeamActor(p, expected); err != nil {
		return false, err
	}
	id, err := canonicalTeamID(teamID)
	if err != nil {
		return false, err
	}
	inviteID, err := CanonicalID(invitationID)
	if err != nil || inviteID != invitationID {
		return false, invalidInput("Invitation ID must be a canonical UUID.")
	}
	var changed bool
	err = s.store.WriteTeam(ctx, id, func(tx *store.TeamTx) error {
		team, err := tx.Team(ctx, p.UserID)
		if err != nil {
			return err
		}
		if err = requireOrdinaryTeamAdmin(team); err != nil {
			return err
		}
		changed, err = tx.RevokeInvitation(ctx, inviteID, time.Now().UTC())
		return err
	})
	if err != nil {
		return false, err
	}
	return changed, nil
}
func (s *Teams) inspectInvitation(ctx context.Context, p core.Principal, secret string, operation func(*store.Snapshot, core.TeamInvitation) error) error {
	if err := requirePrincipal(p); err != nil {
		return err
	}
	if !validSecret(secret, teamInvitationPrefix) {
		return invitationUnavailable(nil)
	}
	var refusal *Fault
	err := s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		return completeMembershipOperation(func() error {
			i, err := snapshot.TeamInvitation(ctx, secretHash(secret))
			if errors.Is(err, core.ErrNotFound) {
				return invitationUnavailable(nil)
			}
			if err != nil {
				return err
			}
			if !teamInvitationAvailable(i, time.Now().UTC()) {
				return invitationUnavailable(nil)
			}
			return operation(snapshot, i)
		}, &refusal)
	})
	if err != nil {
		return err
	}
	if refusal != nil {
		return refusal
	}
	return nil
}
func (s *Teams) InspectInvitation(ctx context.Context, p core.Principal, secret string) (TeamInvitationInspection, error) {
	var result TeamInvitationInspection
	err := s.inspectInvitation(ctx, p, secret, func(snapshot *store.Snapshot, i core.TeamInvitation) error {
		team, err := snapshot.InvitationTeam(ctx, i.TeamID)
		if errors.Is(err, core.ErrNotFound) {
			return invitationUnavailable(nil)
		}
		if err != nil {
			return err
		}
		if team.Kind != "ordinary" || team.Name == nil {
			return invitationUnavailable(nil)
		}
		result.Team = team
		member, err := snapshot.InvitationTeamMember(ctx, i.TeamID, p.UserID)
		if errors.Is(err, core.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		result.Membership = &member
		return nil
	})
	return result, err
}
func (s *Teams) AcceptInvitation(ctx context.Context, p core.Principal, secret, expected string) (TeamInvitationAcceptance, error) {
	if err := requireTeamActor(p, expected); err != nil {
		return TeamInvitationAcceptance{}, err
	}
	var teamID string
	if err := s.inspectInvitation(ctx, p, secret, func(_ *store.Snapshot, i core.TeamInvitation) error { teamID = i.TeamID; return nil }); err != nil {
		return TeamInvitationAcceptance{}, err
	}
	var result TeamInvitationAcceptance
	var refusal *Fault
	err := s.store.WriteTeam(ctx, teamID, func(tx *store.TeamTx) error {
		return completeMembershipOperation(func() error {
			i, err := tx.LockInvitation(ctx, secretHash(secret))
			if errors.Is(err, core.ErrNotFound) {
				return invitationUnavailable(nil)
			}
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			if !teamInvitationAvailable(i, now) {
				return invitationUnavailable(nil)
			}
			team, err := tx.InvitationTeam(ctx)
			if err != nil {
				return err
			}
			if team.Kind != "ordinary" || team.Name == nil {
				return invitationUnavailable(nil)
			}
			member, err := tx.InvitationMember(ctx, p.UserID)
			if err != nil && !errors.Is(err, core.ErrNotFound) {
				return err
			}
			if errors.Is(err, core.ErrNotFound) {
				member, err = tx.AddInvitedMember(ctx, p.UserID)
				if err != nil {
					return err
				}
				if err = tx.ConsumeInvitation(ctx, i.ID, p.UserID, now); err != nil {
					return err
				}
				result.Joined = true
				result.Consumed = true
			}
			result.Team, result.Membership = team, member
			return nil
		}, &refusal)
	})
	if fault, classified := TeamResponseFault(err); classified && fault.Code == "not_found" {
		return TeamInvitationAcceptance{}, invitationUnavailable(nil)
	}
	if err != nil {
		return TeamInvitationAcceptance{}, err
	}
	if refusal != nil {
		return TeamInvitationAcceptance{}, refusal
	}
	return result, nil
}
