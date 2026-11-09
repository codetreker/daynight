package team

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

type Teams struct {
	writer store.TeamWriter
	reader store.SnapshotReader
	now    func() time.Time
	core   teamOperations
}

type teamOperations struct {
	validateCreate           func(model.Principal, core.CreateTeam) error
	create                   func(context.Context, store.TeamCreationDAO, core.CreateTeam) (model.Team, error)
	validateRead             func(model.Principal, string) (string, error)
	get                      func(context.Context, store.TeamReader, model.Principal, string) (model.Team, error)
	list                     func(context.Context, store.TeamReader, model.Principal, model.PageRequest) (core.TeamPage, error)
	validateChange           func(model.Principal, string, core.ChangeTeam) (string, error)
	rename                   func(context.Context, store.TeamWriteDAO, model.Principal, core.ChangeTeam) (model.Team, error)
	delete                   func(context.Context, store.TeamWriteDAO, model.Principal, core.ChangeTeam) error
	members                  func(context.Context, store.TeamReader, model.Principal, string) ([]model.TeamMemberProfile, error)
	membersPage              func(context.Context, store.TeamReader, model.Principal, string, model.PageRequest) (core.MemberPage, error)
	member                   func(context.Context, store.TeamReader, model.Principal, string, string) (model.TeamMember, error)
	validateMemberChange     func(model.Principal, string, string, core.ChangeTeamMember, bool) (string, string, error)
	changeMember             func(context.Context, store.TeamWriteDAO, model.Principal, string, core.ChangeTeamMember, bool) (core.TeamMemberResult, error)
	validateInvitationWrite  func(model.Principal, string, string) (string, error)
	createInvitation         func(context.Context, store.TeamWriteDAO, model.Principal, string, func() time.Time) (core.MintedTeamInvitation, error)
	listInvitations          func(context.Context, store.TeamReader, model.Principal, string, func() time.Time) ([]model.TeamInvitation, error)
	listInvitationPage       func(context.Context, store.TeamReader, model.Principal, string, model.PageRequest, func() time.Time) (core.InvitationPage, error)
	validateInvitationRevoke func(model.Principal, string, string, string) (string, string, error)
	revokeInvitation         func(context.Context, store.TeamWriteDAO, model.Principal, string, func() time.Time) (bool, error)
	validateInvitation       func(model.Principal, string) error
	invitation               func(context.Context, store.TeamReader, string, func() time.Time) (model.TeamInvitation, error)
	inspectInvitation        func(context.Context, store.TeamReader, model.Principal, model.TeamInvitation) (core.TeamInvitationInspection, error)
	requireActor             func(model.Principal, string) error
	acceptInvitation         func(context.Context, store.TeamWriteDAO, model.Principal, string, func() time.Time) (core.TeamInvitationAcceptance, error)
	refreshEligibility       func(context.Context, store.WebhookEligibilityDAO, store.WebhookEligibilityFilter) error
}

func NewTeams(database interface {
	store.TeamWriter
	store.SnapshotReader
}) *Teams {
	return &Teams{writer: database, reader: database, now: time.Now, core: teamOperations{
		validateCreate:           core.ValidateCreate,
		create:                   core.Create,
		validateRead:             core.ValidateRead,
		get:                      core.Get,
		list:                     core.List,
		validateChange:           core.ValidateChange,
		rename:                   core.Rename,
		delete:                   core.Delete,
		members:                  core.Members,
		membersPage:              core.MembersPage,
		member:                   core.Member,
		validateMemberChange:     core.ValidateMemberChange,
		changeMember:             core.ChangeMember,
		validateInvitationWrite:  core.ValidateInvitationWrite,
		createInvitation:         core.CreateInvitation,
		listInvitations:          core.ListInvitations,
		listInvitationPage:       core.ListInvitationPage,
		validateInvitationRevoke: core.ValidateInvitationRevoke,
		revokeInvitation:         core.RevokeInvitation,
		validateInvitation:       core.ValidateInvitation,
		invitation:               core.Invitation,
		inspectInvitation:        core.InspectInvitation,
		requireActor:             core.RequireActor,
		acceptInvitation:         core.AcceptInvitation,
		refreshEligibility:       webhook.RefreshEligibility,
	}}
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
func (s *Teams) write(ctx context.Context, id string, op func(store.TeamWriteScope) error) error {
	var refusal *model.Fault
	c, err := s.writer.WriteTeam(ctx, id, func(scope store.TeamWriteScope) error {
		return completion.Capture(func() error { return op(scope) }, &refusal)
	})
	return completed(c, err, refusal)
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
	if err := s.core.validateCreate(p, input); err != nil {
		return model.Team{}, err
	}
	var result model.Team
	var refusal *model.Fault
	c, err := s.writer.CreateTeam(ctx, p.UserID, func(dao store.TeamCreationDAO) error {
		return completion.Capture(func() error { var err error; result, err = s.core.create(ctx, dao, input); return err }, &refusal)
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
	id, err := s.core.validateRead(p, id)
	if err != nil {
		return model.Team{}, err
	}
	var result model.Team
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error { var err error; result, err = s.core.get(ctx, sc.TeamDAO(), p, id); return err }, &refusal)
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
		result, err = s.core.list(ctx, sc.TeamDAO(), p, request)
		return err
	})
	if err != nil {
		return core.TeamPage{}, err
	}
	return result, nil
}

func (s *Teams) Rename(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) (model.Team, error) {
	id, err := s.core.validateChange(p, id, input)
	if err != nil {
		return model.Team{}, err
	}
	var result model.Team
	err = s.write(ctx, id, func(scope store.TeamWriteScope) error {
		dao := scope.TeamDAO()
		var err error
		result, err = s.core.rename(ctx, dao, p, input)
		return err
	})
	if err != nil {
		return model.Team{}, err
	}
	return result, nil
}
func (s *Teams) Delete(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) error {
	id, err := s.core.validateChange(p, id, input)
	if err != nil {
		return err
	}
	return s.write(ctx, id, func(scope store.TeamWriteScope) error {
		dao := scope.TeamDAO()
		if err := s.core.delete(ctx, dao, p, input); err != nil {
			return err
		}
		return s.core.refreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{TeamID: id, TeamOwner: true})
	})
}
func (s *Teams) Members(ctx context.Context, p model.Principal, id string) ([]model.TeamMemberProfile, error) {
	id, err := s.core.validateRead(p, id)
	if err != nil {
		return nil, err
	}
	var result []model.TeamMemberProfile
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error { var err error; result, err = s.core.members(ctx, sc.TeamDAO(), p, id); return err }, &refusal)
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
	id, err := s.core.validateRead(p, id)
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
			result, err = s.core.membersPage(ctx, sc.TeamDAO(), p, id, request)
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
	id, err := s.core.validateRead(p, id)
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
		return completion.Capture(func() error { var err error; result, err = s.core.member(ctx, sc.TeamDAO(), p, id, userID); return err }, &refusal)
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
	id, target, err := s.core.validateMemberChange(p, id, user, input, remove)
	if err != nil {
		return core.TeamMemberResult{}, err
	}
	var result core.TeamMemberResult
	err = s.write(ctx, id, func(scope store.TeamWriteScope) error {
		dao := scope.TeamDAO()
		var err error
		result, err = s.core.changeMember(ctx, dao, p, target, input, remove)
		if err != nil {
			return err
		}
		return s.core.refreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{TeamID: id, UserID: target})
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
	id, err := s.core.validateInvitationWrite(p, id, expected)
	if err != nil {
		return core.MintedTeamInvitation{}, err
	}
	var result core.MintedTeamInvitation
	err = s.write(ctx, id, func(scope store.TeamWriteScope) error {
		dao := scope.TeamDAO()
		var err error
		result, err = s.core.createInvitation(ctx, dao, p, id, s.now)
		return err
	})
	if err != nil {
		return core.MintedTeamInvitation{}, err
	}
	return result, nil
}
func (s *Teams) ListInvitations(ctx context.Context, p model.Principal, id string) ([]model.TeamInvitation, error) {
	id, err := s.core.validateRead(p, id)
	if err != nil {
		return nil, err
	}
	var result []model.TeamInvitation
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		var err error
		result, err = s.core.listInvitations(ctx, sc.TeamDAO(), p, id, s.now)
		return err
	})
	return result, err
}

func (s *Teams) ListInvitationPage(ctx context.Context, p model.Principal, id string, request model.PageRequest) (core.InvitationPage, error) {
	id, err := s.core.validateRead(p, id)
	if err != nil {
		return core.InvitationPage{}, err
	}
	var result core.InvitationPage
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		var err error
		result, err = s.core.listInvitationPage(ctx, sc.TeamDAO(), p, id, request, s.now)
		return err
	})
	return result, err
}

func (s *Teams) RevokeInvitation(ctx context.Context, p model.Principal, id, inviteID, expected string) (bool, error) {
	id, inviteID, err := s.core.validateInvitationRevoke(p, id, inviteID, expected)
	if err != nil {
		return false, err
	}
	var changed bool
	err = s.write(ctx, id, func(scope store.TeamWriteScope) error {
		dao := scope.TeamDAO()
		var err error
		changed, err = s.core.revokeInvitation(ctx, dao, p, inviteID, s.now)
		return err
	})
	if err != nil {
		return false, err
	}
	return changed, nil
}
func (s *Teams) inspect(ctx context.Context, p model.Principal, secret string, op func(store.TeamReader, model.TeamInvitation) error) error {
	if err := s.core.validateInvitation(p, secret); err != nil {
		return err
	}
	var refusal *model.Fault
	err := s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error {
			i, err := s.core.invitation(ctx, sc.TeamDAO(), secret, s.now)
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
		result, err = s.core.inspectInvitation(ctx, dao, p, i)
		return err
	})
	return result, err
}
func (s *Teams) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (core.TeamInvitationAcceptance, error) {
	if err := s.core.requireActor(p, expected); err != nil {
		return core.TeamInvitationAcceptance{}, err
	}
	var id string
	if err := s.inspect(ctx, p, secret, func(_ store.TeamReader, i model.TeamInvitation) error { id = i.TeamID; return nil }); err != nil {
		return core.TeamInvitationAcceptance{}, err
	}
	var result core.TeamInvitationAcceptance
	err := s.write(ctx, id, func(scope store.TeamWriteScope) error {
		dao := scope.TeamDAO()
		var err error
		result, err = s.core.acceptInvitation(ctx, dao, p, secret, s.now)
		if err != nil {
			return err
		}
		return s.core.refreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{TeamID: id, UserID: p.UserID})
	})
	if fault, classified := core.WriteFault(err); classified && fault.Code == "not_found" {
		return core.TeamInvitationAcceptance{}, model.InvitationUnavailable(nil)
	}
	if err != nil {
		return core.TeamInvitationAcceptance{}, err
	}
	return result, nil
}
