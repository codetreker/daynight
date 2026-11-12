package team

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const invitationPrefix = "dnteam_"
const invitationLifetime = 7 * 24 * time.Hour

type MintedTeamInvitation struct {
	Invitation model.TeamInvitation
	Secret     string
}
type TeamInvitationInspection struct {
	Team       model.TeamRef
	Membership *model.TeamMember
}
type TeamInvitationAcceptance struct {
	Team             model.TeamRef
	Membership       model.TeamMember
	Joined, Consumed bool
}

func invitationAvailable(i model.TeamInvitation, now time.Time) bool {
	return i.ConsumedAt == nil && i.RevokedAt == nil && i.ExpiresAt.After(now)
}
func requireOrdinaryTeamAdmin(t model.Team) error {
	if t.Membership.Role != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Team administrator access is required."}
	}
	if t.Kind == "personal" {
		return &model.Fault{Code: "personal_team_immutable", Message: "Personal Team invitations are unavailable."}
	}
	return nil
}
func ValidateInvitationWrite(p model.Principal, teamID, expected string) (string, error) {
	if err := RequireActor(p, expected); err != nil {
		return "", err
	}
	return CanonicalID(teamID)
}
func ValidateInvitationRevoke(p model.Principal, teamID, invitationID, expected string) (string, string, error) {
	id, err := ValidateInvitationWrite(p, teamID, expected)
	if err != nil {
		return "", "", err
	}
	inviteID, err := model.CanonicalID(invitationID)
	if err != nil || inviteID != invitationID {
		return "", "", invalidInput("Invitation ID must be a canonical UUID.")
	}
	return id, inviteID, nil
}
func CreateInvitation(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, id string, clock func() time.Time) (MintedTeamInvitation, error) {
	t, err := dao.Team(ctx, p.UserID)
	if err != nil {
		return MintedTeamInvitation{}, err
	}
	if err = requireOrdinaryTeamAdmin(t); err != nil {
		return MintedTeamInvitation{}, err
	}
	now := clock().UTC()
	value := secretutil.Random(invitationPrefix)
	invitation := model.TeamInvitation{ID: uuid.NewString(), TeamID: id, CreatedBy: p.UserID, TokenHash: secretutil.Hash(value), CreatedAt: now, ExpiresAt: now.Add(invitationLifetime)}
	if err := dao.CreateInvitation(ctx, invitation); err != nil {
		return MintedTeamInvitation{}, err
	}
	invitation.TokenHash = nil
	return MintedTeamInvitation{Invitation: invitation, Secret: value}, nil
}
func ListInvitations(ctx context.Context, dao store.TeamReader, p model.Principal, id string, clock func() time.Time) ([]model.TeamInvitation, error) {
	t, err := dao.Team(ctx, p.UserID, id)
	if err != nil {
		return nil, err
	}
	if err := requireOrdinaryTeamAdmin(t); err != nil {
		return nil, err
	}
	return dao.TeamInvitations(ctx, id, clock().UTC())
}

type InvitationPage struct {
	Items      []model.TeamInvitation
	NextCursor *string
}

func ListInvitationPage(ctx context.Context, dao store.TeamReader, p model.Principal, id string, request model.PageRequest, clock func() time.Time) (InvitationPage, error) {
	scope := query.ListScope{Kind: "team_invitations", UserID: p.UserID, ProjectID: id}
	page, err := query.ListPage(request, scope)
	if err != nil {
		return InvitationPage{}, err
	}
	t, err := dao.Team(ctx, p.UserID, id)
	if errors.Is(err, model.ErrNotFound) {
		return InvitationPage{}, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
	}
	if err != nil {
		return InvitationPage{}, err
	}
	if err := requireOrdinaryTeamAdmin(t); err != nil {
		return InvitationPage{}, err
	}
	result, err := dao.TeamInvitationPage(ctx, id, clock().UTC(), page)
	if err != nil {
		return InvitationPage{}, err
	}
	response := InvitationPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return InvitationPage{}, fmt.Errorf("encode Team invitation cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}

func RevokeInvitation(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, inviteID string, clock func() time.Time) (bool, error) {
	t, err := dao.Team(ctx, p.UserID)
	if err != nil {
		return false, err
	}
	if err := requireOrdinaryTeamAdmin(t); err != nil {
		return false, err
	}
	return dao.RevokeInvitation(ctx, inviteID, clock().UTC())
}
func ValidateInvitation(p model.Principal, secret string) error {
	if err := model.RequirePrincipal(p); err != nil {
		return err
	}
	if !secretutil.Valid(secret, invitationPrefix) {
		return model.InvitationUnavailable(nil)
	}
	return nil
}
func Invitation(ctx context.Context, dao store.TeamReader, secret string, clock func() time.Time) (model.TeamInvitation, error) {
	i, err := dao.TeamInvitation(ctx, secretutil.Hash(secret))
	if errors.Is(err, model.ErrNotFound) {
		return model.TeamInvitation{}, model.InvitationUnavailable(nil)
	}
	if err != nil {
		return model.TeamInvitation{}, err
	}
	if !invitationAvailable(i, clock().UTC()) {
		return model.TeamInvitation{}, model.InvitationUnavailable(nil)
	}
	return i, nil
}
func InspectInvitation(ctx context.Context, dao store.TeamReader, p model.Principal, i model.TeamInvitation) (TeamInvitationInspection, error) {
	t, err := dao.InvitationTeam(ctx, i.TeamID)
	if errors.Is(err, model.ErrNotFound) {
		return TeamInvitationInspection{}, model.InvitationUnavailable(nil)
	}
	if err != nil {
		return TeamInvitationInspection{}, err
	}
	if t.Kind != "ordinary" || t.Name == nil {
		return TeamInvitationInspection{}, model.InvitationUnavailable(nil)
	}
	result := TeamInvitationInspection{Team: t}
	member, err := dao.InvitationTeamMember(ctx, i.TeamID, p.UserID)
	if errors.Is(err, model.ErrNotFound) {
		return result, nil
	}
	if err != nil {
		return TeamInvitationInspection{}, err
	}
	result.Membership = &member
	return result, nil
}
func AcceptInvitation(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, secret string, clock func() time.Time) (TeamInvitationAcceptance, error) {
	i, err := dao.LockInvitation(ctx, secretutil.Hash(secret))
	if errors.Is(err, model.ErrNotFound) {
		return TeamInvitationAcceptance{}, model.InvitationUnavailable(nil)
	}
	if err != nil {
		return TeamInvitationAcceptance{}, err
	}
	now := clock().UTC()
	if !invitationAvailable(i, now) {
		return TeamInvitationAcceptance{}, model.InvitationUnavailable(nil)
	}
	t, err := dao.InvitationTeam(ctx)
	if err != nil {
		return TeamInvitationAcceptance{}, err
	}
	if t.Kind != "ordinary" || t.Name == nil {
		return TeamInvitationAcceptance{}, model.InvitationUnavailable(nil)
	}
	member, err := dao.InvitationMember(ctx, p.UserID)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return TeamInvitationAcceptance{}, err
	}
	result := TeamInvitationAcceptance{}
	if errors.Is(err, model.ErrNotFound) {
		member, err = dao.AddMember(ctx, p.UserID, model.ProjectMemberRole)
		if err != nil {
			return TeamInvitationAcceptance{}, err
		}
		if err = dao.ConsumeInvitation(ctx, i.ID, p.UserID, now); err != nil {
			return TeamInvitationAcceptance{}, err
		}
		result.Joined = true
		result.Consumed = true
	}
	result.Team, result.Membership = t, member
	return result, nil
}
