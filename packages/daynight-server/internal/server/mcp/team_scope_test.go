package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func scopedPAT(t *testing.T, p model.Principal, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	ids, err := scopepolicy.Normalize(scopepolicy.PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}

func scopedToolCall(t *testing.T, c *sdk.ClientSession, name string, args map[string]any, wantCode, wantOutcome string) {
	t.Helper()
	result, err := c.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil || result.IsError != (wantCode != "") {
		t.Fatalf("%s: result=%+v err=%v", name, result, err)
	}
	if wantCode == "" {
		return
	}
	var envelope struct {
		Error struct {
			Code         string `json:"code"`
			WriteOutcome string `json:"writeOutcome"`
		} `json:"error"`
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil || json.Unmarshal(data, &envelope) != nil || envelope.Error.Code != wantCode || envelope.Error.WriteOutcome != wantOutcome {
		t.Fatalf("%s: unexpected error envelope %s (%v)", name, data, err)
	}
}

func TestScopedTeamToolsPreserveVisibilityAndGuardWrites(t *testing.T) {
	tx := newHTTPTestStore(t)
	var granted []scopepolicy.ScopeID
	provider := func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		return scopedPAT(t, p, granted...), nil
	}
	snapshot := func(ctx context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		return provider(ctx, p)
	}
	teams, err := teamservice.NewScopedTeams(tx, provider, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	mocks := newTeamToolMocks(t)
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	if err := RegisterScopedTeamTools(f.entry, teamservice.NewTeams(tx), mocks.projects, mocks.identities, provider); err == nil {
		t.Fatal("legacy service admitted")
	}
	if err := RegisterScopedTeamTools(f.entry, teams, mocks.projects, mocks.identities, provider); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2025-11-25", "alice")
	actor, _ := (validTeamAuth{}).Authenticate(t.Context(), model.PATCredential, "alice")
	team := mcpOrgTeam(t, unknownTeam, "Team", actor.UserID)
	args := map[string]any{"team": unknownTeam, "name": "New", "ifVersion": "1", "confirm": true}
	readTeam := func(err error) {
		mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(_ context.Context, user, id string) (model.Team, error) {
			projectHTTPCheck(t, []string{user, id}, []string{actor.UserID, team.ID})
			return team, err
		}})
	}
	granted = []scopepolicy.ScopeID{"team:read"}
	readTeam(nil)
	mcpOrgWriteTeam(t, tx, team.ID, mcpOrgTeamWriter{TeamCall: func(context.Context, string) (model.Team, error) { return team, nil }}, nil)
	scopedToolCall(t, client, "team_rename", args, "insufficient_scope", "not_committed")
	readTeam(model.ErrNotFound)
	scopedToolCall(t, client, "team_show", map[string]any{"team": team.ID}, "not_found", "")
	readTeam(nil)
	scopedToolCall(t, client, "team_projects", map[string]any{"team": team.ID}, "insufficient_scope", "")
	granted = []scopepolicy.ScopeID{"team:write"}
	readTeam(nil)
	scopedToolCall(t, client, "team_rename", args, "insufficient_scope", "not_committed")
	readTeam(model.ErrNotFound)
	scopedToolCall(t, client, "team_show", map[string]any{"team": team.ID}, "not_found", "")
	mocks.verify()
}

func TestScopedTeamProjectsRejectsBadAuthorizationWithoutListing(t *testing.T) {
	tx := newHTTPTestStore(t)
	teamProvider := func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		return scopedPAT(t, p, "team:read"), nil
	}
	snapshot := func(ctx context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		return teamProvider(ctx, p)
	}
	teams, err := teamservice.NewScopedTeams(tx, teamProvider, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	providerCalls := 0
	projectProvider := func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		providerCalls++
		switch mode {
		case "failure":
			return model.CredentialAuthorization{}, errors.New("authorization unavailable")
		case "other identity":
			p.UserID = unknownTarget
			return scopedPAT(t, p, "project:read"), nil
		case "missing policy":
			return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile}, nil
		default:
			return scopedPAT(t, p, "project:read"), nil
		}
	}
	mocks := newTeamToolMocks(t)
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	if err := RegisterScopedTeamTools(f.entry, teams, mocks.projects, mocks.identities, projectProvider); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2025-11-25", "alice")
	actor, _ := (validTeamAuth{}).Authenticate(t.Context(), model.PATCredential, "alice")
	team := mcpOrgTeam(t, unknownTeam, "Team", actor.UserID)
	args := map[string]any{"team": team.ID}
	for _, mode = range []string{"failure", "other identity", "missing policy", "allowed"} {
		mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(_ context.Context, user, id string) (model.Team, error) {
			projectHTTPCheck(t, []string{user, id}, []string{actor.UserID, team.ID})
			return team, nil
		}})
		if mode == "allowed" {
			mocks.expect("Projects.ListScoped")
			mocks.projects.ListScopedFunc = func(_ context.Context, _ model.Principal, request coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
				if request.TeamID == nil || *request.TeamID != team.ID {
					t.Errorf("unexpected Team selection: %+v", request)
				}
				return coreproject.ProjectPage{}, nil
			}
			scopedToolCall(t, client, "team_projects", args, "", "")
		} else {
			scopedToolCall(t, client, "team_projects", args, "internal_error", "")
		}
	}
	if providerCalls != 4 {
		t.Fatalf("authorization provider called %d times", providerCalls)
	}
	mocks.verify()
}

type protectedInvitationProjects struct{ unknownInvitationProjects }

func (protectedInvitationProjects) ScopeProtected() bool { return true }

type protectedTeamMock struct{ *teamOperationMock }

func (protectedTeamMock) ScopeProtected() bool { return true }

type protectedInvitationTeams struct{ unknownInvitationTeams }

func (protectedInvitationTeams) ScopeProtected() bool { return true }

func TestScopedTeamCatalogMatchesLegacyBytes(t *testing.T) {
	legacy, candidate := newEntryFixture(t), newEntryFixture(t)
	legacy.entry.auth, candidate.entry.auth = validTeamAuth{}, validTeamAuth{}
	mocks := newTeamToolMocks(t)
	provider := func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		return scopedPAT(t, p, "team:read"), nil
	}
	if err := RegisterTeamTools(legacy.entry, mocks.teams, mocks.projects, mocks.identities); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedTeamTools(candidate.entry, protectedTeamMock{mocks.teams}, mocks.projects, mocks.identities, provider); err != nil {
		t.Fatal(err)
	}
	if err := RegisterInvitationTools(legacy.entry, mocks.identities, &unknownInvitationTeams{}, unknownInvitationProjects{}, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedInvitationTools(candidate.entry, mocks.identities, &protectedInvitationTeams{}, protectedInvitationProjects{}, "https://daynight.test", provider); err != nil {
		t.Fatal(err)
	}
	oldList, err := legacy.client(t, "2025-11-25", "alice").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	newList, err := candidate.client(t, "2025-11-25", "alice").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	oldBytes, err := json.Marshal(oldList)
	if err != nil {
		t.Fatal(err)
	}
	newBytes, err := json.Marshal(newList)
	if err != nil {
		t.Fatal(err)
	}
	if len(oldList.Tools) != len(newList.Tools) || !bytes.Equal(oldBytes, newBytes) {
		t.Fatalf("tool catalog changed: legacy=%d tools/%d bytes, candidate=%d tools/%d bytes", len(oldList.Tools), len(oldBytes), len(newList.Tools), len(newBytes))
	}
	t.Logf("legacy and scoped catalogs: %d tools, %d identical bytes", len(oldList.Tools), len(oldBytes))
}

func TestScopedInvitationTeamAcceptDoesNotRequireReadOrProjectScope(t *testing.T) {
	tx := newHTTPTestStore(t)
	var granted []scopepolicy.ScopeID
	provider := func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		return scopedPAT(t, p, granted...), nil
	}
	snapshot := func(ctx context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		return provider(ctx, p)
	}
	teams, err := teamservice.NewScopedTeams(tx, provider, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	identity := &teamIdentityMock{plan: &teamCallPlan{t: t}}
	if err := RegisterScopedInvitationTools(f.entry, identity, teams, unknownInvitationProjects{}, "https://daynight.test", provider); err == nil {
		t.Fatal("legacy Project service admitted")
	}
	if err := RegisterScopedInvitationTools(f.entry, identity, teams, protectedInvitationProjects{}, "https://daynight.test", provider); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2025-11-25", "alice")
	actor, _ := (validTeamAuth{}).Authenticate(t.Context(), model.PATCredential, "alice")
	team := mcpOrgTeam(t, unknownTeam, "Team", actor.UserID)
	token := "dnteam_" + strings.Repeat("A", 43)
	link := "https://daynight.test/team-invitations#" + token
	now := time.Now().UTC()
	invite := model.TeamInvitation{ID: "55555555-5555-4555-8555-555555555555", TeamID: team.ID, CreatedBy: actor.UserID, CreatedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour)}
	granted = []scopepolicy.ScopeID{"team:invitation-accept"}
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: mcpOrgInvitationLookup(t, invite, token)})
	mcpOrgWriteTeam(t, tx, team.ID, mcpOrgTeamWriter{
		LockInvitationCall: mcpOrgInvitationLookup(t, invite, token),
		InvitationTeamCall: func(context.Context) (model.TeamRef, error) { return team.TeamRef, nil },
	}, nil)
	scopedToolCall(t, client, "invitation_accept", map[string]any{"link": link, "confirm": true}, "insufficient_scope", "not_committed")
	granted = []scopepolicy.ScopeID{"team:invitation-accept", "team:invitation-read"}
	mcpOrgAcceptTeam(t, tx, actor, team.TeamRef, invite, token, team.Membership, true)
	scopedToolCall(t, client, "invitation_accept", map[string]any{"link": link, "confirm": true}, "", "")
	// An unavailable invitation retains its original error even without read scope.
	granted = []scopepolicy.ScopeID{"team:invitation-accept"}
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: func(context.Context, []byte) (model.TeamInvitation, error) {
		return model.TeamInvitation{}, model.ErrNotFound
	}})
	scopedToolCall(t, client, "invitation_inspect", map[string]any{"link": link}, "invitation_unavailable", "")
}

func TestTeamToolScopeMappingsAreComplete(t *testing.T) {
	var definitions []sdk.Tool
	if err := json.Unmarshal(teamToolsJSON, &definitions); err != nil {
		t.Fatal(err)
	}
	for _, definition := range definitions {
		ops, _, err := teamToolOperations(definition.Name, model.Principal{}, teamArguments{})
		if err != nil || len(ops) == 0 {
			t.Fatalf("%s is unclassified: %v", definition.Name, err)
		}
	}
	if _, _, err := teamToolOperations("unknown", model.Principal{}, teamArguments{}); err == nil {
		t.Fatal("unknown tool admitted")
	}
	var invites []sdk.Tool
	if err := json.Unmarshal([]byte(invitationSchemas), &invites); err != nil {
		t.Fatal(err)
	}
	adapter := invitationAdapter{origin: "https://daynight.test"}
	for _, definition := range invites {
		for _, path := range []string{"/team-invitations#dnteam_", "/invitations#dninvite_"} {
			ops, _, err := adapter.invitationToolOperations(definition.Name, invitationInput{Link: adapter.origin + path + strings.Repeat("A", 43)})
			if err != nil || len(ops) == 0 {
				t.Fatalf("%s %s is unclassified: %v", definition.Name, path, err)
			}
		}
	}
	actor := model.Principal{UserID: unknownActor}
	ops, _, _ := teamToolOperations("team_member_remove", actor, teamArguments{UserID: unknownActor})
	if len(ops) != 2 || ops[1] != scopepolicy.TeamLeave {
		t.Fatalf("self removal = %v", ops)
	}
	ops, _, _ = teamToolOperations("team_member_remove", actor, teamArguments{UserID: unknownTarget})
	if len(ops) != 2 || ops[1] != scopepolicy.TeamMembers {
		t.Fatalf("member removal = %v", ops)
	}
	ops, _, err := adapter.invitationToolOperations("invitation_accept", invitationInput{Link: adapter.origin + "/team-invitations#dnteam_" + strings.Repeat("A", 43)})
	if err != nil || len(ops) != 2 || ops[0] != scopepolicy.TeamInvitationAccept || ops[1] != scopepolicy.TeamInvitationRead {
		t.Fatalf("full invitation acceptance = %v, %v", ops, err)
	}
}
