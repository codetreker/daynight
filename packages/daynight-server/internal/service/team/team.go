package team

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

type Teams struct {
	writer store.TeamWriter
	reader store.SnapshotReader
	now    func() time.Time
}

func NewTeams(database interface {
	store.TeamWriter
	store.SnapshotReader
}) *Teams {
	return &Teams{writer: database, reader: database, now: time.Now}
}
func completed(c store.Completion, err error, refusal *model.Fault) error {
	if err != nil {
		return err
	}
	if c.Outcome != store.TransactionCommitted {
		return errors.New("Team transaction did not confirm commit")
	}
	if refusal != nil {
		return refusal
	}
	return nil
}
func (s *Teams) writeScope(ctx context.Context, id string, op func(store.TeamWriteScope) error, after func(store.TeamWriteScope) error) error {
	var refusal *model.Fault
	c, err := s.writer.WriteTeam(ctx, id, func(scope store.TeamWriteScope) error {
		// Eligibility errors must abort the source write; only business refusals
		// participate in the existing completed-check behavior.
		if err := completion.Capture(func() error { return op(scope) }, &refusal); err != nil {
			return err
		}
		if refusal != nil || after == nil {
			return nil
		}
		return after(scope)
	})
	return completed(c, err, refusal)
}
func (s *Teams) write(ctx context.Context, id string, op func(store.TeamWriteDAO) error) error {
	return s.writeScope(ctx, id, func(scope store.TeamWriteScope) error { return op(scope.TeamDAO()) }, nil)
}
func (s *Teams) writeAccess(ctx context.Context, id string, change store.WebhookEligibilityChange, op func(store.TeamWriteDAO) error) error {
	return s.writeScope(ctx, id, func(scope store.TeamWriteScope) error { return op(scope.TeamDAO()) }, func(scope store.TeamWriteScope) error {
		return scope.WebhookEligibilityDAO().RefreshAffected(ctx, change)
	})
}

// CreationError retains only the allocated identifier when transaction
// completion fails; it does not establish that the Team exists.
type CreationError struct {
	TeamID string
	Cause  error
}

func (e *CreationError) Error() string { return e.Cause.Error() }
func (e *CreationError) Unwrap() error { return e.Cause }

func (s *Teams) Create(ctx context.Context, p model.Principal, input core.CreateTeam) (model.Team, error) {
	if err := core.ValidateCreate(p, input); err != nil {
		return model.Team{}, err
	}
	var result model.Team
	var refusal *model.Fault
	c, err := s.writer.CreateTeam(ctx, p.UserID, func(dao store.TeamCreationDAO) error {
		return completion.Capture(func() error { var err error; result, err = core.Create(ctx, dao, input); return err }, &refusal)
	})
	if err := completed(c, err, refusal); err != nil {
		if result.ID != "" {
			return model.Team{}, &CreationError{TeamID: result.ID, Cause: err}
		}
		return model.Team{}, err
	}
	return result, nil
}
func (s *Teams) Get(ctx context.Context, p model.Principal, id string) (model.Team, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return model.Team{}, err
	}
	var result model.Team
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error { var err error; result, err = core.Get(ctx, sc.TeamDAO(), p, id); return err }, &refusal)
	})
	if err != nil {
		return model.Team{}, err
	}
	if refusal != nil {
		return model.Team{}, refusal
	}
	return result, nil
}
func (s *Teams) List(ctx context.Context, p model.Principal, request model.PageRequest) (core.TeamPage, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return core.TeamPage{}, err
	}
	if _, err := query.ListPage(request, query.ListScope{Kind: "teams", UserID: p.UserID}); err != nil {
		return core.TeamPage{}, err
	}
	var result core.TeamPage
	err := s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		var err error
		result, err = core.List(ctx, sc.TeamDAO(), p, request)
		return err
	})
	if err != nil {
		return core.TeamPage{}, err
	}
	return result, nil
}

// GetBounded and ListBounded constrain protocol-side materialization while
// leaving the ordinary REST projections intact.
func (s *Teams) GetBounded(ctx context.Context, p model.Principal, id string, limit int) (model.Team, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return model.Team{}, err
	}
	var result model.Team
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error { var e error; result, e = core.GetBounded(ctx, sc.TeamDAO(), p, id, limit); return e }, &refusal)
	})
	if err != nil {
		return model.Team{}, err
	}
	if refusal != nil {
		return model.Team{}, refusal
	}
	return result, nil
}
func (s *Teams) ListBounded(ctx context.Context, p model.Principal, request model.PageRequest, limit int) (core.TeamPage, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return core.TeamPage{}, err
	}
	if _, err := query.ListPage(request, query.ListScope{Kind: "teams", UserID: p.UserID}); err != nil {
		return core.TeamPage{}, err
	}
	var result core.TeamPage
	var refusal *model.Fault
	err := s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error {
			var e error
			result, e = core.ListBounded(ctx, sc.TeamDAO(), p, request, limit)
			return e
		}, &refusal)
	})
	if err != nil {
		return core.TeamPage{}, err
	}
	if refusal != nil {
		return core.TeamPage{}, refusal
	}
	return result, nil
}

type boundedTeamWriter struct {
	store.TeamWriteDAO
	limit int
}

func (d boundedTeamWriter) Team(ctx context.Context, userID string) (model.Team, error) {
	t, oversized, err := d.TeamWriteDAO.TeamBounded(ctx, userID, d.limit)
	if err != nil {
		return model.Team{}, err
	}
	if oversized {
		return model.Team{}, &model.Fault{Code: "payload_too_large", Message: "Team exceeds the write read budget."}
	}
	return t, nil
}
func (s *Teams) RenameBounded(ctx context.Context, p model.Principal, id string, input core.ChangeTeam, limit int) (model.Team, error) {
	id, err := core.ValidateChange(p, id, input)
	if err != nil {
		return model.Team{}, err
	}
	var result model.Team
	err = s.write(ctx, id, func(dao store.TeamWriteDAO) error {
		var e error
		result, e = core.Rename(ctx, boundedTeamWriter{dao, limit}, p, input)
		return e
	})
	if err != nil {
		return model.Team{}, err
	}
	return result, nil
}
func (s *Teams) DeleteBounded(ctx context.Context, p model.Principal, id string, input core.ChangeTeam, limit int) error {
	id, err := core.ValidateChange(p, id, input)
	if err != nil {
		return err
	}
	return s.writeAccess(ctx, id, store.WebhookEligibilityChange{DeletedOwner: &webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: id}}, func(dao store.TeamWriteDAO) error { return core.Delete(ctx, boundedTeamWriter{dao, limit}, p, input) })
}
func (s *Teams) changeMemberBounded(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember, remove bool, limit int) (core.TeamMemberResult, error) {
	id, target, err := core.ValidateMemberChange(p, id, user, input, remove)
	if err != nil {
		return core.TeamMemberResult{}, err
	}
	var result core.TeamMemberResult
	err = s.writeAccess(ctx, id, store.WebhookEligibilityChange{TeamIDs: []string{id}, UserIDs: []string{target}}, func(dao store.TeamWriteDAO) error {
		var e error
		result, e = core.ChangeMember(ctx, boundedTeamWriter{dao, limit}, p, target, input, remove)
		return e
	})
	if err != nil {
		return core.TeamMemberResult{}, err
	}
	return result, nil
}
func (s *Teams) SetMemberRoleBounded(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember, limit int) (core.TeamMemberResult, error) {
	return s.changeMemberBounded(ctx, p, id, user, input, false, limit)
}
func (s *Teams) RemoveMemberBounded(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember, limit int) (core.TeamMemberResult, error) {
	return s.changeMemberBounded(ctx, p, id, user, input, true, limit)
}

func (s *Teams) Rename(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) (model.Team, error) {
	id, err := core.ValidateChange(p, id, input)
	if err != nil {
		return model.Team{}, err
	}
	var result model.Team
	err = s.write(ctx, id, func(dao store.TeamWriteDAO) error {
		var err error
		result, err = core.Rename(ctx, dao, p, input)
		return err
	})
	if err != nil {
		return model.Team{}, err
	}
	return result, nil
}
func (s *Teams) Delete(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) error {
	id, err := core.ValidateChange(p, id, input)
	if err != nil {
		return err
	}
	return s.writeAccess(ctx, id, store.WebhookEligibilityChange{DeletedOwner: &webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: id}}, func(dao store.TeamWriteDAO) error { return core.Delete(ctx, dao, p, input) })
}
func (s *Teams) Members(ctx context.Context, p model.Principal, id string) ([]model.TeamMemberProfile, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return nil, err
	}
	var result []model.TeamMemberProfile
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error { var err error; result, err = core.Members(ctx, sc.TeamDAO(), p, id); return err }, &refusal)
	})
	if err != nil {
		return nil, err
	}
	if refusal != nil {
		return nil, refusal
	}
	return result, nil
}
func (s *Teams) MembersPage(ctx context.Context, p model.Principal, id string, request model.PageRequest) (core.MemberPage, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return core.MemberPage{}, err
	}
	if _, err := query.ListPage(request, query.ListScope{Kind: "team_members", UserID: p.UserID, TeamID: id}); err != nil {
		return core.MemberPage{}, err
	}
	var result core.MemberPage
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error {
			var err error
			result, err = core.MembersPage(ctx, sc.TeamDAO(), p, id, request)
			return err
		}, &refusal)
	})
	if err != nil {
		return core.MemberPage{}, err
	}
	if refusal != nil {
		return core.MemberPage{}, refusal
	}
	return result, nil
}

func (s *Teams) Member(ctx context.Context, p model.Principal, id, userID string) (model.TeamMember, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return model.TeamMember{}, err
	}
	canonical, err := model.CanonicalID(userID)
	if err != nil || canonical != userID {
		return model.TeamMember{}, &model.Fault{Code: "invalid_input", Message: "User ID must be a canonical UUID."}
	}
	var result model.TeamMember
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error { var err error; result, err = core.Member(ctx, sc.TeamDAO(), p, id, userID); return err }, &refusal)
	})
	if err != nil {
		return model.TeamMember{}, err
	}
	if refusal != nil {
		return model.TeamMember{}, refusal
	}
	return result, nil
}
func (s *Teams) changeMember(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember, remove bool) (core.TeamMemberResult, error) {
	id, target, err := core.ValidateMemberChange(p, id, user, input, remove)
	if err != nil {
		return core.TeamMemberResult{}, err
	}
	var result core.TeamMemberResult
	err = s.writeAccess(ctx, id, store.WebhookEligibilityChange{TeamIDs: []string{id}, UserIDs: []string{target}}, func(dao store.TeamWriteDAO) error {
		var err error
		result, err = core.ChangeMember(ctx, dao, p, target, input, remove)
		return err
	})
	if err != nil {
		return core.TeamMemberResult{}, err
	}
	return result, nil
}
func (s *Teams) SetMemberRole(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember) (core.TeamMemberResult, error) {
	return s.changeMember(ctx, p, id, user, input, false)
}
func (s *Teams) RemoveMember(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember) (core.TeamMemberResult, error) {
	return s.changeMember(ctx, p, id, user, input, true)
}
func (s *Teams) CreateInvitation(ctx context.Context, p model.Principal, id, expected string) (core.MintedTeamInvitation, error) {
	id, err := core.ValidateInvitationWrite(p, id, expected)
	if err != nil {
		return core.MintedTeamInvitation{}, err
	}
	var result core.MintedTeamInvitation
	err = s.write(ctx, id, func(dao store.TeamWriteDAO) error {
		var err error
		result, err = core.CreateInvitation(ctx, dao, p, id, s.now)
		return err
	})
	if err != nil {
		return core.MintedTeamInvitation{}, err
	}
	return result, nil
}
func (s *Teams) ListInvitations(ctx context.Context, p model.Principal, id string) ([]model.TeamInvitation, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return nil, err
	}
	var result []model.TeamInvitation
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		var err error
		result, err = core.ListInvitations(ctx, sc.TeamDAO(), p, id, s.now)
		return err
	})
	return result, err
}

func (s *Teams) ListInvitationPage(ctx context.Context, p model.Principal, id string, request model.PageRequest) (core.InvitationPage, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return core.InvitationPage{}, err
	}
	var result core.InvitationPage
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		var err error
		result, err = core.ListInvitationPage(ctx, sc.TeamDAO(), p, id, request, s.now)
		return err
	})
	return result, err
}

func (s *Teams) RevokeInvitation(ctx context.Context, p model.Principal, id, inviteID, expected string) (bool, error) {
	id, inviteID, err := core.ValidateInvitationRevoke(p, id, inviteID, expected)
	if err != nil {
		return false, err
	}
	var changed bool
	err = s.write(ctx, id, func(dao store.TeamWriteDAO) error {
		var err error
		changed, err = core.RevokeInvitation(ctx, dao, p, inviteID, s.now)
		return err
	})
	if err != nil {
		return false, err
	}
	return changed, nil
}
func (s *Teams) inspect(ctx context.Context, p model.Principal, secret string, op func(store.TeamReader, model.TeamInvitation) error) error {
	if err := core.ValidateInvitation(p, secret); err != nil {
		return err
	}
	var refusal *model.Fault
	err := s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error {
			i, err := core.Invitation(ctx, sc.TeamDAO(), secret, s.now)
			if err != nil {
				return err
			}
			return op(sc.TeamDAO(), i)
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
func (s *Teams) InspectInvitation(ctx context.Context, p model.Principal, secret string) (core.TeamInvitationInspection, error) {
	var result core.TeamInvitationInspection
	err := s.inspect(ctx, p, secret, func(dao store.TeamReader, i model.TeamInvitation) error {
		var err error
		result, err = core.InspectInvitation(ctx, dao, p, i)
		return err
	})
	return result, err
}
func (s *Teams) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (core.TeamInvitationAcceptance, error) {
	if err := core.RequireActor(p, expected); err != nil {
		return core.TeamInvitationAcceptance{}, err
	}
	var id string
	if err := s.inspect(ctx, p, secret, func(_ store.TeamReader, i model.TeamInvitation) error { id = i.TeamID; return nil }); err != nil {
		return core.TeamInvitationAcceptance{}, err
	}
	var result core.TeamInvitationAcceptance
	err := s.writeAccess(ctx, id, store.WebhookEligibilityChange{TeamIDs: []string{id}, UserIDs: []string{p.UserID}}, func(dao store.TeamWriteDAO) error {
		var err error
		result, err = core.AcceptInvitation(ctx, dao, p, secret, s.now)
		return err
	})
	if fault, classified := core.WriteFault(err); classified && fault.Code == "not_found" {
		return core.TeamInvitationAcceptance{}, model.InvitationUnavailable(nil)
	}
	if err != nil {
		return core.TeamInvitationAcceptance{}, err
	}
	return result, nil
}
