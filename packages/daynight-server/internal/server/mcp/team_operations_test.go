package mcp

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type teamCallPlan struct {
	t       *testing.T
	mu      sync.Mutex
	pending []string
}

func (p *teamCallPlan) expect(names ...string) {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.pending) != 0 {
		p.t.Fatalf("unconsumed Team operations: %v", p.pending)
	}
	p.pending = append(p.pending, names...)
}

func (p *teamCallPlan) verify() {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.pending) != 0 {
		p.t.Errorf("unconsumed Team operations: %v", p.pending)
	}
}

func (p *teamCallPlan) call(ctx context.Context, principal model.Principal, name string, configured bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	expected, _ := (validTeamAuth{}).Authenticate(ctx, model.PATCredential, "alice")
	if ctx == nil || ctx.Err() != nil || !reflect.DeepEqual(principal, expected) {
		p.t.Errorf("%s received context/principal: %v, %+v", name, ctx, principal)
		return errors.New("incorrect Team operation context or principal")
	}
	if !configured || len(p.pending) == 0 || p.pending[0] != name {
		p.t.Errorf("unexpected Team operation %s; expected %v (configured=%v)", name, p.pending, configured)
		return errors.New("unexpected Team operation")
	}
	p.pending = p.pending[1:]
	return nil
}

type teamOperationMock struct {
	plan              *teamCallPlan
	CreateFunc        func(ctx context.Context, principal model.Principal, input coreteam.CreateTeam) (model.Team, error)
	ListFunc          func(ctx context.Context, principal model.Principal, request model.PageRequest) (coreteam.TeamPage, error)
	GetFunc           func(ctx context.Context, principal model.Principal, id string) (model.Team, error)
	RenameFunc        func(ctx context.Context, principal model.Principal, id string, input coreteam.ChangeTeam) (model.Team, error)
	DeleteFunc        func(ctx context.Context, principal model.Principal, id string, input coreteam.ChangeTeam) error
	MembersPageFunc   func(ctx context.Context, principal model.Principal, id string, request model.PageRequest) (coreteam.MemberPage, error)
	MemberFunc        func(ctx context.Context, principal model.Principal, id, user string) (model.TeamMember, error)
	SetMemberRoleFunc func(ctx context.Context, principal model.Principal, id, user string, input coreteam.ChangeTeamMember) (coreteam.TeamMemberResult, error)
	RemoveMemberFunc  func(ctx context.Context, principal model.Principal, id, user string, input coreteam.ChangeTeamMember) (coreteam.TeamMemberResult, error)
}

func (m *teamOperationMock) Create(ctx context.Context, principal model.Principal, input coreteam.CreateTeam) (model.Team, error) {
	if err := m.plan.call(ctx, principal, "Teams.Create", m.CreateFunc != nil); err != nil {
		var zero model.Team
		return zero, err
	}
	return m.CreateFunc(ctx, principal, input)
}

func (m *teamOperationMock) List(ctx context.Context, principal model.Principal, request model.PageRequest) (coreteam.TeamPage, error) {
	if err := m.plan.call(ctx, principal, "Teams.List", m.ListFunc != nil); err != nil {
		var zero coreteam.TeamPage
		return zero, err
	}
	return m.ListFunc(ctx, principal, request)
}

func (m *teamOperationMock) Get(ctx context.Context, principal model.Principal, id string) (model.Team, error) {
	if err := m.plan.call(ctx, principal, "Teams.Get", m.GetFunc != nil); err != nil {
		var zero model.Team
		return zero, err
	}
	return m.GetFunc(ctx, principal, id)
}

func (m *teamOperationMock) Rename(ctx context.Context, principal model.Principal, id string, input coreteam.ChangeTeam) (model.Team, error) {
	if err := m.plan.call(ctx, principal, "Teams.Rename", m.RenameFunc != nil); err != nil {
		var zero model.Team
		return zero, err
	}
	return m.RenameFunc(ctx, principal, id, input)
}

func (m *teamOperationMock) Delete(ctx context.Context, principal model.Principal, id string, input coreteam.ChangeTeam) error {
	if err := m.plan.call(ctx, principal, "Teams.Delete", m.DeleteFunc != nil); err != nil {
		return err
	}
	return m.DeleteFunc(ctx, principal, id, input)
}

func (m *teamOperationMock) MembersPage(ctx context.Context, principal model.Principal, id string, request model.PageRequest) (coreteam.MemberPage, error) {
	if err := m.plan.call(ctx, principal, "Teams.MembersPage", m.MembersPageFunc != nil); err != nil {
		var zero coreteam.MemberPage
		return zero, err
	}
	return m.MembersPageFunc(ctx, principal, id, request)
}

func (m *teamOperationMock) Member(ctx context.Context, principal model.Principal, id, user string) (model.TeamMember, error) {
	if err := m.plan.call(ctx, principal, "Teams.Member", m.MemberFunc != nil); err != nil {
		var zero model.TeamMember
		return zero, err
	}
	return m.MemberFunc(ctx, principal, id, user)
}

func (m *teamOperationMock) SetMemberRole(ctx context.Context, principal model.Principal, id, user string, input coreteam.ChangeTeamMember) (coreteam.TeamMemberResult, error) {
	if err := m.plan.call(ctx, principal, "Teams.SetMemberRole", m.SetMemberRoleFunc != nil); err != nil {
		var zero coreteam.TeamMemberResult
		return zero, err
	}
	return m.SetMemberRoleFunc(ctx, principal, id, user, input)
}

func (m *teamOperationMock) RemoveMember(ctx context.Context, principal model.Principal, id, user string, input coreteam.ChangeTeamMember) (coreteam.TeamMemberResult, error) {
	if err := m.plan.call(ctx, principal, "Teams.RemoveMember", m.RemoveMemberFunc != nil); err != nil {
		var zero coreteam.TeamMemberResult
		return zero, err
	}
	return m.RemoveMemberFunc(ctx, principal, id, user, input)
}

type teamProjectMock struct {
	plan           *teamCallPlan
	ListScopedFunc func(context.Context, model.Principal, coreproject.ProjectListRequest) (coreproject.ProjectPage, error)
}

func (m *teamProjectMock) ListScoped(ctx context.Context, principal model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	if err := m.plan.call(ctx, principal, "Projects.ListScoped", m.ListScopedFunc != nil); err != nil {
		return coreproject.ProjectPage{}, err
	}
	return m.ListScopedFunc(ctx, principal, input)
}

type teamIdentityMock struct {
	plan               *teamCallPlan
	PersonalTeamIDFunc func(context.Context, model.Principal) (string, error)
}

func (m *teamIdentityMock) PersonalTeamID(ctx context.Context, principal model.Principal) (string, error) {
	if err := m.plan.call(ctx, principal, "Identity.PersonalTeamID", m.PersonalTeamIDFunc != nil); err != nil {
		return "", err
	}
	return m.PersonalTeamIDFunc(ctx, principal)
}

type teamToolMocks struct {
	*teamCallPlan
	teams      *teamOperationMock
	projects   *teamProjectMock
	identities *teamIdentityMock
}

func newTeamToolMocks(t *testing.T) teamToolMocks {
	t.Helper()
	plan := &teamCallPlan{t: t}
	t.Cleanup(plan.verify)
	return teamToolMocks{plan, &teamOperationMock{plan: plan}, &teamProjectMock{plan: plan}, &teamIdentityMock{plan: plan}}
}

func registerTeamToolMocks(t *testing.T, mocks teamToolMocks) *entryFixture {
	t.Helper()
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	if err := RegisterTeamTools(f.entry, mocks.teams, mocks.projects, mocks.identities); err != nil {
		t.Fatal(err)
	}
	return f
}

func configureTeamMutation(t *testing.T, mocks teamToolMocks, name string, args map[string]any, failure error) {
	t.Helper()
	check := func(got, want any) {
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s argument = %#v; want %#v", name, got, want)
		}
	}
	if name == "team_create" {
		mocks.expect("Teams.Create")
		expected := coreteam.CreateTeam{Name: args["name"].(string), ExpectedUserID: unknownActor}
		mocks.teams.CreateFunc = func(_ context.Context, _ model.Principal, input coreteam.CreateTeam) (model.Team, error) {
			check(input, expected)
			result := testUnknownTeam()
			result.ID, result.Name = createdTeamID, &expected.Name
			return result, failure
		}
		return
	}
	if name == "team_rename" || name == "team_delete" {
		method := "Teams.Rename"
		if name == "team_delete" {
			method = "Teams.Delete"
		}
		mocks.expect("Teams.Get", method)
		mocks.teams.GetFunc = func(_ context.Context, _ model.Principal, id string) (model.Team, error) {
			check(id, unknownTeam)
			return testUnknownTeam(), nil
		}
		expectedName := "Original"
		if name == "team_rename" {
			expectedName = args["name"].(string)
		}
		expected := coreteam.ChangeTeam{Name: expectedName, Version: 1, ExpectedUserID: unknownActor}
		mocks.teams.RenameFunc = func(_ context.Context, _ model.Principal, id string, input coreteam.ChangeTeam) (model.Team, error) {
			check(id, unknownTeam)
			check(input, expected)
			result := testUnknownTeam()
			result.Name = &expected.Name
			return result, failure
		}
		mocks.teams.DeleteFunc = func(_ context.Context, _ model.Principal, id string, input coreteam.ChangeTeam) error {
			check(id, unknownTeam)
			check(input, expected)
			return failure
		}
		return
	}
	target := unknownTarget
	method := "Teams.RemoveMember"
	if name == "team_leave" {
		target = unknownActor
	}
	if name == "team_member_set_role" {
		method = "Teams.SetMemberRole"
	}
	mocks.expect("Teams.Member", method)
	mocks.teams.MemberFunc = func(_ context.Context, _ model.Principal, id, user string) (model.TeamMember, error) {
		check(id, unknownTeam)
		check(user, target)
		return model.TeamMember{TeamID: unknownTeam, UserID: target, Role: model.ProjectMemberRole, Version: 1}, nil
	}
	expected := coreteam.ChangeTeamMember{Version: 1, ExpectedUserID: unknownActor}
	if name == "team_member_set_role" {
		expected.Role = model.ProjectRole(args["role"].(string))
	}
	mutate := func(_ context.Context, _ model.Principal, id, user string, input coreteam.ChangeTeamMember) (coreteam.TeamMemberResult, error) {
		check(id, unknownTeam)
		check(user, target)
		check(input, expected)
		role := model.ProjectAdmin
		return coreteam.TeamMemberResult{Membership: model.TeamMember{TeamID: unknownTeam, UserID: target, Role: expected.Role, Version: 2}, ActorRole: &role}, failure
	}
	mocks.teams.SetMemberRoleFunc, mocks.teams.RemoveMemberFunc = mutate, mutate
}
