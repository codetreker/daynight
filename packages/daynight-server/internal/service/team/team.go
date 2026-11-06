package team

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
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
func (s *Teams) write(ctx context.Context, id string, op func(store.TeamWriteDAO) error) error {
	var refusal *model.Fault
	c, err := s.writer.WriteTeam(ctx, id, func(dao store.TeamWriteDAO) error {
		return completion.Capture(func() error { return op(dao) }, &refusal)
	})
	return completed(c, err, refusal)
}
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
	return s.write(ctx, id, func(dao store.TeamWriteDAO) error { return core.Delete(ctx, dao, p, input) })
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
func (s *Teams) changeMember(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember, remove bool) (core.TeamMemberResult, error) {
	id, target, err := core.ValidateMemberChange(p, id, user, input, remove)
	if err != nil {
		return core.TeamMemberResult{}, err
	}
	var result core.TeamMemberResult
	err = s.write(ctx, id, func(dao store.TeamWriteDAO) error {
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
	err := s.write(ctx, id, func(dao store.TeamWriteDAO) error {
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
