package server

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type mcpOrgFixture struct {
	t           *testing.T
	projects    *mcpOrgProjects
	memberships *mcpOrgMemberships
	teams       *mcpOrgTeams
	identity    *mcpOperationIdentity
	mu          sync.Mutex
	pending     []string
	contexts    map[*mcpStepMarker]context.Context
}

func newMCPOrgFixture(t *testing.T) *mcpOrgFixture {
	t.Helper()
	f := &mcpOrgFixture{t: t, projects: &mcpOrgProjects{t: t, operationRejectedProjects: &operationRejectedProjects{t: t}}, memberships: &mcpOrgMemberships{t: t, operationRejectedMemberships: &operationRejectedMemberships{t: t}}, teams: &mcpOrgTeams{t: t, operationRejectedTeams: &operationRejectedTeams{t: t}}, contexts: make(map[*mcpStepMarker]context.Context)}
	t.Cleanup(func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.pending) != 0 {
			t.Errorf("unconsumed MCP organization operations: %v", f.pending)
		}
	})
	return f
}
func (f *mcpOrgFixture) configure(app *service.App) {
	app.Projects, app.Memberships, app.Teams = f.projects, f.memberships, f.teams
	f.identity = app.Identity.(*mcpOperationIdentity)
}
func (f *mcpOrgFixture) check(ctx context.Context, actual, expected model.Principal, got, want any) {
	f.t.Helper()
	mcpOperationContext(f.t, ctx, actual)
	projectHTTPCheck(f.t, actual, expected)
	projectHTTPCheck(f.t, got, want)
	marker := mcpStepRequestMarker(f.t, ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	if previous, ok := f.contexts[marker]; ok && previous != ctx {
		f.t.Error("MCP organization operation changed the tool context")
	}
	f.contexts[marker] = ctx
}
func (f *mcpOrgFixture) expect(name string) func() {
	f.t.Helper()
	counted := mcpOrgCount(f.t, 1)
	f.mu.Lock()
	f.pending = append(f.pending, name)
	f.mu.Unlock()
	return func() {
		counted()
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.pending) == 0 || f.pending[0] != name {
			f.t.Errorf("unexpected MCP organization operation %s; pending %v", name, f.pending)
			return
		}
		f.pending = f.pending[1:]
	}
}

func mcpOrgTeam(t *testing.T, id, name, user string) model.Team {
	t.Helper()
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: at, UpdatedAt: at, Membership: model.TeamMember{TeamID: id, UserID: user, Role: model.ProjectAdmin, Version: 1, CreatedAt: at, UpdatedAt: at}}
}
func mcpOrgCreateTeam(t *testing.T, f *mcpOrgFixture, actor model.Principal, result model.Team) {
	t.Helper()
	result = mcpOrgCopyTeam(result)
	want := teamcore.CreateTeam{Name: *result.Name, ExpectedUserID: actor.UserID}
	called := f.expect("Teams.Create")
	f.teams.CreateCall = func(ctx context.Context, p model.Principal, in teamcore.CreateTeam) (model.Team, error) {
		called()
		f.check(ctx, p, actor, in, want)
		return mcpOrgCopyTeam(result), nil
	}
}
func mcpOrgGetProject(t *testing.T, f *mcpOrgFixture, actor model.Principal, id string, result model.Project, err error) {
	t.Helper()
	called := f.expect("Projects.Get")
	f.projects.GetCall = func(ctx context.Context, p model.Principal, gotID string) (model.Project, error) {
		called()
		f.check(ctx, p, actor, gotID, id)
		return result, err
	}
}
func mcpOrgCount(t *testing.T, want int) func() {
	t.Helper()
	_, file, line, ok := runtime.Caller(1)
	if !ok {
		t.Fatal("MCP operation plan has no callsite")
	}
	label := fmt.Sprintf("%s:%d", filepath.Base(file), line)
	var seen atomic.Int64
	t.Cleanup(func() {
		if got := seen.Load(); got != int64(want) {
			t.Errorf("MCP operation plan %s calls=%d, want=%d", label, got, want)
		}
	})
	return func() {
		if got := seen.Add(1); got > int64(want) {
			unexpectedHTTPCall(t, "MCP operation plan "+label)
		}
	}
}

func (f *mcpOrgFixture) bindIdentity(identity *mcpOperationIdentity, actors []model.Principal, personal []string, want int) {
	f.t.Helper()
	if len(actors) != len(personal) {
		f.t.Fatal("MCP organization actors and Personal Teams must align")
	}
	called := mcpOrgCount(f.t, want)
	identity.PersonalTeamIDCall = func(ctx context.Context, p model.Principal) (string, error) {
		called()
		f.check(ctx, p, p, nil, nil)
		for i, actor := range actors {
			if actor == p {
				return personal[i], nil
			}
		}
		unexpectedHTTPCall(f.t, "MCP PersonalTeamID undeclared principal")
		panic("unreachable")
	}
}
func mcpOrgRepository(t *testing.T, f *mcpOrgFixture, actor model.Principal, input projectcore.CreateProject, confirm bool, result model.Project, created bool, err error) {
	t.Helper()
	input.TeamID = mcpOrgCopyPointer(input.TeamID)
	called := f.expect("Projects.RegisterRepository")
	f.projects.RegisterRepositoryCall = func(ctx context.Context, p model.Principal, got projectcore.CreateProject, gotConfirm bool) (model.Project, bool, error) {
		called()
		f.check(ctx, p, actor, got, input)
		projectHTTPCheck(t, gotConfirm, confirm)
		return result, created, err
	}
}
func mcpOrgTransfer(t *testing.T, f *mcpOrgFixture, actor model.Principal, id string, input projectcore.TransferInput, result projectcore.TransferReceipt, err error) {
	t.Helper()
	result = mcpOrgCopyTransfer(result)
	called := f.expect("Projects.Transfer")
	f.projects.TransferCall = func(ctx context.Context, p model.Principal, gotID string, got projectcore.TransferInput) (projectcore.TransferReceipt, error) {
		called()
		f.check(ctx, p, actor, gotID, id)
		projectHTTPCheck(t, got, input)
		return mcpOrgCopyTransfer(result), err
	}
}
func mcpOrgTeamCreateResult(t *testing.T, f *mcpOrgFixture, actor model.Principal, input teamcore.CreateTeam, result model.Team, err error) {
	t.Helper()
	result = mcpOrgCopyTeam(result)
	called := f.expect("Teams.Create")
	f.teams.CreateCall = func(ctx context.Context, p model.Principal, got teamcore.CreateTeam) (model.Team, error) {
		called()
		f.check(ctx, p, actor, got, input)
		return mcpOrgCopyTeam(result), err
	}
}
func mcpOrgTeamRead(t *testing.T, f *mcpOrgFixture, actor model.Principal, result model.Team) {
	t.Helper()
	result = mcpOrgCopyTeam(result)
	called := f.expect("Teams.Get")
	f.teams.GetCall = func(ctx context.Context, p model.Principal, id string) (model.Team, error) {
		called()
		f.check(ctx, p, actor, id, result.ID)
		return mcpOrgCopyTeam(result), nil
	}
}
func mcpOrgTeamRename(t *testing.T, f *mcpOrgFixture, actor model.Principal, id string, input teamcore.ChangeTeam, result model.Team, err error) {
	t.Helper()
	result = mcpOrgCopyTeam(result)
	called := f.expect("Teams.Rename")
	f.teams.RenameCall = func(ctx context.Context, p model.Principal, gotID string, got teamcore.ChangeTeam) (model.Team, error) {
		called()
		f.check(ctx, p, actor, gotID, id)
		projectHTTPCheck(t, got, input)
		return mcpOrgCopyTeam(result), err
	}
}
func mcpOrgTeamDelete(t *testing.T, f *mcpOrgFixture, actor model.Principal, id string, input teamcore.ChangeTeam, err error) {
	t.Helper()
	called := f.expect("Teams.Delete")
	f.teams.DeleteCall = func(ctx context.Context, p model.Principal, gotID string, got teamcore.ChangeTeam) error {
		called()
		f.check(ctx, p, actor, gotID, id)
		projectHTTPCheck(t, got, input)
		return err
	}
}
func mcpOrgMember(t *testing.T, f *mcpOrgFixture, actor model.Principal, id string, result model.TeamMember) {
	t.Helper()
	called := f.expect("Teams.Member")
	f.teams.MemberCall = func(ctx context.Context, p model.Principal, gotID, user string) (model.TeamMember, error) {
		called()
		f.check(ctx, p, actor, []string{gotID, user}, []string{id, result.UserID})
		return result, nil
	}
}
func mcpOrgMemberPage(t *testing.T, f *mcpOrgFixture, actor model.Principal, id string, input model.PageRequest, result teamcore.MemberPage, err error) {
	t.Helper()
	input.Cursor = mcpOrgCopyPointer(input.Cursor)
	result = mcpOrgCopyMemberPage(result)
	called := f.expect("Teams.MembersPage")
	f.teams.MembersPageCall = func(ctx context.Context, p model.Principal, gotID string, got model.PageRequest) (teamcore.MemberPage, error) {
		called()
		f.check(ctx, p, actor, gotID, id)
		projectHTTPCheck(t, got, input)
		return mcpOrgCopyMemberPage(result), err
	}
}
func mcpOrgProjectPage(t *testing.T, f *mcpOrgFixture, actor model.Principal, input projectcore.ProjectListRequest, result projectcore.ProjectPage) {
	t.Helper()
	input.Page.Cursor = mcpOrgCopyPointer(input.Page.Cursor)
	input.TeamID = mcpOrgCopyPointer(input.TeamID)
	result.Items = append([]model.Project(nil), result.Items...)
	result.NextCursor = mcpOrgCopyPointer(result.NextCursor)
	called := f.expect("Projects.ListScoped")
	f.projects.ListScopedCall = func(ctx context.Context, p model.Principal, got projectcore.ProjectListRequest) (projectcore.ProjectPage, error) {
		called()
		f.check(ctx, p, actor, got, input)
		out := result
		out.Items = append([]model.Project(nil), result.Items...)
		out.NextCursor = mcpOrgCopyPointer(result.NextCursor)
		return out, nil
	}
}
func mcpOrgCopyPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	out := *value
	return &out
}
func mcpOrgCopyTeamRef(value model.TeamRef) model.TeamRef {
	value.Name = mcpOrgCopyPointer(value.Name)
	return value
}
func mcpOrgCopyTeam(value model.Team) model.Team {
	value.TeamRef = mcpOrgCopyTeamRef(value.TeamRef)
	return value
}
func mcpOrgCopyAccess(value model.ProjectAccess) model.ProjectAccess {
	value.DirectGrant = mcpOrgCopyPointer(value.DirectGrant)
	value.OwnerTeam = mcpOrgCopyTeamRef(value.OwnerTeam)
	value.TeamRole = mcpOrgCopyPointer(value.TeamRole)
	return value
}
func mcpOrgCopyPreview(value projectcore.TransferPreview) projectcore.TransferPreview {
	value.SourceTeam = mcpOrgCopyTeamRef(value.SourceTeam)
	value.TargetTeam = mcpOrgCopyTeamRef(value.TargetTeam)
	value.ActorRole = mcpOrgCopyPointer(value.ActorRole)
	return value
}
func mcpOrgCopyTransfer(value projectcore.TransferReceipt) projectcore.TransferReceipt {
	value.SourceTeam = mcpOrgCopyTeamRef(value.SourceTeam)
	value.OwnerTeam = mcpOrgCopyTeamRef(value.OwnerTeam)
	if value.ActorAccess != nil {
		copy := mcpOrgCopyAccess(*value.ActorAccess)
		value.ActorAccess = &copy
	}
	return value
}
func mcpOrgCopyMemberPage(value teamcore.MemberPage) teamcore.MemberPage {
	if value.Items != nil {
		value.Items = append([]model.TeamMemberProfile{}, value.Items...)
	}
	for i := range value.Items {
		item := &value.Items[i]
		item.Profile.Name = mcpOrgCopyPointer(item.Profile.Name)
		item.Profile.Email = mcpOrgCopyPointer(item.Profile.Email)
		item.Profile.AvatarURL = mcpOrgCopyPointer(item.Profile.AvatarURL)
	}
	value.NextCursor = mcpOrgCopyPointer(value.NextCursor)
	return value
}
func mcpOrgMintInvitation(t *testing.T, f *mcpOrgFixture, actor model.Principal, team model.Team) *model.TeamInvitation {
	t.Helper()
	token := secret.Random("dnteam_")
	at := time.Now().UTC()
	out := model.TeamInvitation{ID: uuid.NewString(), TeamID: team.ID, CreatedBy: actor.UserID, TokenHash: secret.Hash(token), CreatedAt: at, ExpiresAt: at.Add(7 * 24 * time.Hour)}
	result := mcpOrgCopyInvitation(out)
	result.TokenHash = nil
	called := f.expect("Teams.CreateInvitation")
	f.teams.CreateInvitationCall = func(ctx context.Context, p model.Principal, id, user string) (teamcore.MintedTeamInvitation, error) {
		called()
		f.check(ctx, p, actor, []string{id, user}, []string{team.ID, actor.UserID})
		return teamcore.MintedTeamInvitation{Invitation: mcpOrgCopyInvitation(result), Secret: token}, nil
	}
	return &out
}
func mcpOrgInvitationPage(t *testing.T, f *mcpOrgFixture, actor model.Principal, id string, input model.PageRequest, result teamcore.InvitationPage, err error) {
	t.Helper()
	input.Cursor = mcpOrgCopyPointer(input.Cursor)
	result = mcpOrgCopyInvitationPage(result)
	called := f.expect("Teams.ListInvitationPage")
	f.teams.ListInvitationPageCall = func(ctx context.Context, p model.Principal, gotID string, got model.PageRequest) (teamcore.InvitationPage, error) {
		called()
		f.check(ctx, p, actor, gotID, id)
		projectHTTPCheck(t, got, input)
		return mcpOrgCopyInvitationPage(result), err
	}
}
func mcpOrgInspectTeam(t *testing.T, f *mcpOrgFixture, actor model.Principal, team model.TeamRef, token string, membership *model.TeamMember) {
	t.Helper()
	team = mcpOrgCopyTeamRef(team)
	membership = mcpOrgCopyPointer(membership)
	called := f.expect("Teams.InspectInvitation")
	f.teams.InspectInvitationCall = func(ctx context.Context, p model.Principal, got string) (teamcore.TeamInvitationInspection, error) {
		called()
		f.check(ctx, p, actor, got, token)
		return teamcore.TeamInvitationInspection{Team: mcpOrgCopyTeamRef(team), Membership: mcpOrgCopyPointer(membership)}, nil
	}
}
func mcpOrgRejectTeamAcceptance(t *testing.T, f *mcpOrgFixture, actor model.Principal, token string) {
	t.Helper()
	called := f.expect("Teams.AcceptInvitation")
	f.teams.AcceptInvitationCall = func(ctx context.Context, p model.Principal, got, user string) (teamcore.TeamInvitationAcceptance, error) {
		called()
		f.check(ctx, p, actor, []string{got, user}, []string{token, actor.UserID})
		return teamcore.TeamInvitationAcceptance{}, model.InvitationUnavailable(nil)
	}
}
func mcpOrgRejectTeamInspection(t *testing.T, f *mcpOrgFixture, actor model.Principal, token string) {
	t.Helper()
	called := f.expect("Teams.InspectInvitation")
	f.teams.InspectInvitationCall = func(ctx context.Context, p model.Principal, got string) (teamcore.TeamInvitationInspection, error) {
		called()
		f.check(ctx, p, actor, got, token)
		return teamcore.TeamInvitationInspection{}, model.InvitationUnavailable(nil)
	}
}

func mcpOrgAcceptTeam(t *testing.T, f *mcpOrgFixture, actor model.Principal, team model.TeamRef, token string, result model.TeamMember, existing bool) {
	t.Helper()
	team = mcpOrgCopyTeamRef(team)
	called := f.expect("Teams.AcceptInvitation")
	f.teams.AcceptInvitationCall = func(ctx context.Context, p model.Principal, got, user string) (teamcore.TeamInvitationAcceptance, error) {
		called()
		f.check(ctx, p, actor, []string{got, user}, []string{token, actor.UserID})
		return teamcore.TeamInvitationAcceptance{Team: mcpOrgCopyTeamRef(team), Membership: result, Joined: !existing, Consumed: !existing}, nil
	}
}
func mcpOrgRevokeInvitation(t *testing.T, f *mcpOrgFixture, actor model.Principal, team model.Team, id string, changed bool) {
	t.Helper()
	called := f.expect("Teams.RevokeInvitation")
	f.teams.RevokeInvitationCall = func(ctx context.Context, p model.Principal, gotTeam, gotID, user string) (bool, error) {
		called()
		f.check(ctx, p, actor, []string{gotTeam, gotID, user}, []string{team.ID, id, actor.UserID})
		return changed, nil
	}
}
func mcpOrgInspectProject(t *testing.T, f *mcpOrgFixture, actor model.Principal, value model.Project, token string) {
	t.Helper()
	called := f.expect("Memberships.InspectInvitation")
	f.memberships.InspectInvitationCall = func(ctx context.Context, p model.Principal, got string) (projectcore.InvitationInspection, error) {
		called()
		f.check(ctx, p, actor, got, token)
		return projectcore.InvitationInspection{ProjectID: value.ID, ProjectName: value.Name, DirectGrant: nil, Access: nil}, nil
	}
}
func mcpOrgUnavailableProjectInvitation(t *testing.T, f *mcpOrgFixture, actor model.Principal, token string) {
	t.Helper()
	called := f.expect("Memberships.AcceptInvitation")
	f.memberships.AcceptInvitationCall = func(ctx context.Context, p model.Principal, got, user string) (projectcore.InvitationAcceptance, error) {
		called()
		f.check(ctx, p, actor, []string{got, user}, []string{token, actor.UserID})
		return projectcore.InvitationAcceptance{}, model.InvitationUnavailable(nil)
	}
}
func mcpOrgAcceptProject(t *testing.T, f *mcpOrgFixture, actor model.Principal, value model.Project, token string, result model.ProjectMember, existing bool) {
	t.Helper()
	access := projectHTTPAccess(actor, value)
	access.Role = result.Grant.Role
	grant := result.Grant
	access.DirectGrant = &grant
	access = mcpOrgCopyAccess(access)
	called := f.expect("Memberships.AcceptInvitation")
	f.memberships.AcceptInvitationCall = func(ctx context.Context, p model.Principal, got, user string) (projectcore.InvitationAcceptance, error) {
		called()
		f.check(ctx, p, actor, []string{got, user}, []string{token, actor.UserID})
		return projectcore.InvitationAcceptance{ProjectID: value.ID, DirectGrant: result.Grant, Access: mcpOrgCopyAccess(access), Joined: !existing, Consumed: !existing}, nil
	}
}
func mcpOrgCopyInvitation(value model.TeamInvitation) model.TeamInvitation {
	if value.TokenHash != nil {
		value.TokenHash = append([]byte{}, value.TokenHash...)
	}
	value.ConsumedBy = mcpOrgCopyPointer(value.ConsumedBy)
	value.ConsumedAt = mcpOrgCopyPointer(value.ConsumedAt)
	value.RevokedAt = mcpOrgCopyPointer(value.RevokedAt)
	return value
}
func mcpOrgCopyInvitationPage(value teamcore.InvitationPage) teamcore.InvitationPage {
	if value.Items != nil {
		value.Items = append([]model.TeamInvitation{}, value.Items...)
	}
	for i := range value.Items {
		value.Items[i] = mcpOrgCopyInvitation(value.Items[i])
	}
	value.NextCursor = mcpOrgCopyPointer(value.NextCursor)
	return value
}
