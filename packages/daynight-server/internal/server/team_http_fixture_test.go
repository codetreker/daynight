package server

import (
	"context"
	"io"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type teamHTTPOperations struct {
	t                     *testing.T
	CreateCall            func(ctx context.Context, p model.Principal, input core.CreateTeam) (model.Team, error)
	GetCall               func(ctx context.Context, p model.Principal, id string) (model.Team, error)
	ListCall              func(ctx context.Context, p model.Principal, request model.PageRequest) (core.TeamPage, error)
	RenameCall            func(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) (model.Team, error)
	DeleteCall            func(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) error
	MembersCall           func(ctx context.Context, p model.Principal, id string) ([]model.TeamMemberProfile, error)
	SetMemberRoleCall     func(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember) (core.TeamMemberResult, error)
	RemoveMemberCall      func(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember) (core.TeamMemberResult, error)
	CreateInvitationCall  func(ctx context.Context, p model.Principal, id, expected string) (core.MintedTeamInvitation, error)
	ListInvitationsCall   func(ctx context.Context, p model.Principal, id string) ([]model.TeamInvitation, error)
	RevokeInvitationCall  func(ctx context.Context, p model.Principal, id, inviteID, expected string) (bool, error)
	InspectInvitationCall func(ctx context.Context, p model.Principal, secret string) (core.TeamInvitationInspection, error)
	AcceptInvitationCall  func(ctx context.Context, p model.Principal, secret, expected string) (core.TeamInvitationAcceptance, error)
}

func (m *teamHTTPOperations) Create(ctx context.Context, p model.Principal, input core.CreateTeam) (model.Team, error) {
	if m.CreateCall == nil {
		unexpectedHTTPCall(m.t, "Team Create")
	}
	return m.CreateCall(ctx, p, input)
}

func (m *teamHTTPOperations) Get(ctx context.Context, p model.Principal, id string) (model.Team, error) {
	if m.GetCall == nil {
		unexpectedHTTPCall(m.t, "Team Get")
	}
	return m.GetCall(ctx, p, id)
}

func (m *teamHTTPOperations) List(ctx context.Context, p model.Principal, request model.PageRequest) (core.TeamPage, error) {
	if m.ListCall == nil {
		unexpectedHTTPCall(m.t, "Team List")
	}
	return m.ListCall(ctx, p, request)
}

func (m *teamHTTPOperations) Rename(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) (model.Team, error) {
	if m.RenameCall == nil {
		unexpectedHTTPCall(m.t, "Team Rename")
	}
	return m.RenameCall(ctx, p, id, input)
}

func (m *teamHTTPOperations) Delete(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) error {
	if m.DeleteCall == nil {
		unexpectedHTTPCall(m.t, "Team Delete")
	}
	return m.DeleteCall(ctx, p, id, input)
}

func (m *teamHTTPOperations) Members(ctx context.Context, p model.Principal, id string) ([]model.TeamMemberProfile, error) {
	if m.MembersCall == nil {
		unexpectedHTTPCall(m.t, "Team Members")
	}
	return m.MembersCall(ctx, p, id)
}

func (m *teamHTTPOperations) SetMemberRole(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember) (core.TeamMemberResult, error) {
	if m.SetMemberRoleCall == nil {
		unexpectedHTTPCall(m.t, "Team SetMemberRole")
	}
	return m.SetMemberRoleCall(ctx, p, id, user, input)
}

func (m *teamHTTPOperations) RemoveMember(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember) (core.TeamMemberResult, error) {
	if m.RemoveMemberCall == nil {
		unexpectedHTTPCall(m.t, "Team RemoveMember")
	}
	return m.RemoveMemberCall(ctx, p, id, user, input)
}

func (m *teamHTTPOperations) CreateInvitation(ctx context.Context, p model.Principal, id, expected string) (core.MintedTeamInvitation, error) {
	if m.CreateInvitationCall == nil {
		unexpectedHTTPCall(m.t, "Team CreateInvitation")
	}
	return m.CreateInvitationCall(ctx, p, id, expected)
}

func (m *teamHTTPOperations) ListInvitations(ctx context.Context, p model.Principal, id string) ([]model.TeamInvitation, error) {
	if m.ListInvitationsCall == nil {
		unexpectedHTTPCall(m.t, "Team ListInvitations")
	}
	return m.ListInvitationsCall(ctx, p, id)
}

func (m *teamHTTPOperations) RevokeInvitation(ctx context.Context, p model.Principal, id, inviteID, expected string) (bool, error) {
	if m.RevokeInvitationCall == nil {
		unexpectedHTTPCall(m.t, "Team RevokeInvitation")
	}
	return m.RevokeInvitationCall(ctx, p, id, inviteID, expected)
}

func (m *teamHTTPOperations) InspectInvitation(ctx context.Context, p model.Principal, secret string) (core.TeamInvitationInspection, error) {
	if m.InspectInvitationCall == nil {
		unexpectedHTTPCall(m.t, "Team InspectInvitation")
	}
	return m.InspectInvitationCall(ctx, p, secret)
}

func (m *teamHTTPOperations) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (core.TeamInvitationAcceptance, error) {
	if m.AcceptInvitationCall == nil {
		unexpectedHTTPCall(m.t, "Team AcceptInvitation")
	}
	return m.AcceptInvitationCall(ctx, p, secret, expected)
}

func newTeamHTTPServer(t *testing.T, projects *projectHTTPOperations, teams *teamHTTPOperations, output io.Writer, principal model.Principal) *resourceTestHandler {
	t.Helper()
	return newOperationHTTPServer(t, func(deps *httpDependencies) { deps.Projects = projects; deps.Teams = teams }, output, principal)
}
func teamHTTPCreate(t *testing.T, operations *teamHTTPOperations, actor model.Principal, name string) *model.Team {
	t.Helper()
	id := "ab200000-0000-4000-8000-000000000001"
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	result := model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: at, UpdatedAt: at, Membership: model.TeamMember{TeamID: id, UserID: actor.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: at, UpdatedAt: at}}
	called := projectHTTPCount(t, 1)
	operations.CreateCall = func(ctx context.Context, p model.Principal, input core.CreateTeam) (model.Team, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, input, core.CreateTeam{Name: name, ExpectedUserID: actor.UserID})
		return projectHTTPCopyTeam(result), nil
	}
	return &result
}
func teamHTTPRead(t *testing.T, operations *teamHTTPOperations, actor model.Principal, id string, result model.Team, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	result = projectHTTPCopyTeam(result)
	operations.GetCall = func(ctx context.Context, p model.Principal, got string) (model.Team, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, got, id)
		return projectHTTPCopyTeam(result), failure
	}
}
func teamHTTPList(t *testing.T, operations *teamHTTPOperations, actor model.Principal, items []model.Team) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	items = slices.Clone(items)
	for i := range items {
		items[i] = projectHTTPCopyTeam(items[i])
	}
	operations.ListCall = func(ctx context.Context, p model.Principal, input model.PageRequest) (core.TeamPage, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, input, model.PageRequest{Limit: 1})
		result := slices.Clone(items)
		for i := range result {
			result[i] = projectHTTPCopyTeam(result[i])
		}
		return core.TeamPage{Items: result}, nil
	}
}
func teamHTTPRename(t *testing.T, operations *teamHTTPOperations, actor model.Principal, id string, input core.ChangeTeam, result model.Team, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	result = projectHTTPCopyTeam(result)
	operations.RenameCall = func(ctx context.Context, p model.Principal, got string, actual core.ChangeTeam) (model.Team, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, got, id)
		projectHTTPCheck(t, actual, input)
		return projectHTTPCopyTeam(result), failure
	}
}
func teamHTTPDelete(t *testing.T, operations *teamHTTPOperations, actor model.Principal, id string, input core.ChangeTeam, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	operations.DeleteCall = func(ctx context.Context, p model.Principal, got string, actual core.ChangeTeam) error {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, got, id)
		projectHTTPCheck(t, actual, input)
		return failure
	}
}
func teamHTTPExit(t *testing.T, operations *teamHTTPOperations, actor model.Principal, current model.Team) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	operations.RemoveMemberCall = func(ctx context.Context, p model.Principal, id, user string, input core.ChangeTeamMember) (core.TeamMemberResult, error) {
		called()
		projectHTTPContext(t, ctx, p, actor)
		projectHTTPCheck(t, id, current.ID)
		projectHTTPCheck(t, user, actor.UserID)
		projectHTTPCheck(t, input, core.ChangeTeamMember{Version: current.Membership.Version, ExpectedUserID: actor.UserID})
		return core.TeamMemberResult{Membership: current.Membership, ActorRole: nil}, nil
	}
}
