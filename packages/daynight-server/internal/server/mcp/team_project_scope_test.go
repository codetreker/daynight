package mcp

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func TestCombinedScopedTeamAndProjectTools(t *testing.T) {
	tx := newHTTPTestStore(t)
	provider := scopedAuthorization
	snapshot := func(ctx context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		return provider(ctx, p)
	}
	teams, err := teamservice.NewScopedTeams(tx, provider, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	f := newEntryFixture(t)
	auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{
		"both":    scopedTestAuthorization(t, "project:read", "team:read"),
		"project": scopedTestAuthorization(t, "project:read"),
		"team":    scopedTestAuthorization(t, "team:read"),
	}}
	if err := f.entry.EnableScopedAuthentication(auth); err != nil {
		t.Fatal(err)
	}
	projects := &scopedProjectFixture{visible: true}
	if err := RegisterCombinedScopedTeamTools(f.entry, teams, projects, &identityservice.Identity{}, provider); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedProjectTools(f.entry, projects, &identityservice.Identity{}, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	actor := auth.policies["both"].Principal
	team := mcpOrgTeam(t, unknownTeam, "Team", actor.UserID)
	readTeam := func(failure error) {
		mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(_ context.Context, user, id string) (model.Team, error) {
			projectHTTPCheck(t, []string{user, id}, []string{actor.UserID, team.ID})
			return team, failure
		}})
	}
	client := func(token string) *structClient { return &structClient{t: t, client: f.client(t, "2026-07-28", token)} }
	both, project, teamOnly := client("both"), client("project"), client("team")
	readTeam(nil)
	v := both.call("team_projects", map[string]any{"team": team.ID}, false)
	if len(object(t, v["data"])["items"].([]any)) != 1 {
		t.Fatalf("missing Team Projects: %#v", v)
	}
	readTeam(nil)
	v = project.call("team_projects", map[string]any{"team": team.ID}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("team scope refusal: %#v", v)
	}
	readTeam(nil)
	v = teamOnly.call("team_projects", map[string]any{"team": team.ID}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("project scope refusal: %#v", v)
	}
	readTeam(model.ErrNotFound)
	v = project.call("team_projects", map[string]any{"team": team.ID}, true)
	if object(t, v["error"])["code"] != "not_found" {
		t.Fatalf("hidden Team: %#v", v)
	}
	both.call("project_list", map[string]any{}, false)
	auth.policies["both"] = scopedTestAuthorization(t, "team:read")
	readTeam(nil)
	v = both.call("team_projects", map[string]any{"team": team.ID}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("revoked project scope: %#v", v)
	}
}

func TestCombinedScopedInvitationDomains(t *testing.T) {
	tx := newHTTPTestStore(t)
	provider := scopedAuthorization
	snapshot := func(ctx context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		return provider(ctx, p)
	}
	teams, err := teamservice.NewScopedTeams(tx, provider, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	f := newEntryFixture(t)
	auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{
		"team-read":           scopedTestAuthorization(t, "team:invitation-read"),
		"team-accept":         scopedTestAuthorization(t, "team:invitation-accept", "team:invitation-read"),
		"project-read":        scopedTestAuthorization(t, "project:invitation-read", "project:read"),
		"project-accept":      scopedTestAuthorization(t, "project:invitation-accept", "project:read"),
		"project-accept-only": scopedTestAuthorization(t, "project:invitation-accept"),
	}}
	if err := f.entry.EnableScopedAuthentication(auth); err != nil {
		t.Fatal(err)
	}
	projects := &scopedInvitationFixture{}
	if err := RegisterCombinedScopedInvitationTools(f.entry, &identityservice.Identity{}, teams, projects, "https://daynight.test", provider); err != nil {
		t.Fatal(err)
	}
	client := func(token string) *structClient { return &structClient{t: t, client: f.client(t, "2026-07-28", token)} }
	teamRead, teamAccept, projectRead, projectAccept, projectAcceptOnly := client("team-read"), client("team-accept"), client("project-read"), client("project-accept"), client("project-accept-only")
	actor := auth.policies["team-read"].Principal
	team := mcpOrgTeam(t, unknownTeam, "Team", actor.UserID)
	token := "dnteam_" + strings.Repeat("A", 43)
	teamLink := "https://daynight.test/team-invitations#" + token
	projectLink := "https://daynight.test/invitations#dninvite_" + strings.Repeat("A", 43)
	now := time.Now().UTC()
	invite := model.TeamInvitation{ID: "55555555-5555-4555-8555-555555555555", TeamID: team.ID, CreatedBy: actor.UserID, CreatedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour)}
	mcpOrgInspectTeam(t, tx, actor, team.TeamRef, invite, token, &team.Membership)
	v := teamRead.call("invitation_inspect", map[string]any{"link": teamLink}, false)
	if object(t, v["data"])["scope"] != "team" {
		t.Fatalf("Team inspection: %#v", v)
	}
	mcpOrgAcceptTeam(t, tx, actor, team.TeamRef, invite, token, team.Membership, true)
	v = teamAccept.call("invitation_accept", map[string]any{"link": teamLink, "confirm": true}, false)
	if object(t, v["data"])["scope"] != "team" {
		t.Fatalf("Team acceptance: %#v", v)
	}
	v = projectRead.call("invitation_inspect", map[string]any{"link": projectLink}, false)
	if object(t, v["data"])["scope"] != "project" {
		t.Fatalf("Project inspection: %#v", v)
	}
	v = teamRead.call("invitation_inspect", map[string]any{"link": projectLink}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("Project scope refusal: %#v", v)
	}
	v = projectAcceptOnly.call("invitation_accept", map[string]any{"link": projectLink, "confirm": true}, true)
	if e := object(t, v["error"]); e["code"] != "insufficient_scope" || e["writeOutcome"] != "not_committed" {
		t.Fatalf("Project receipt read refusal: %#v", v)
	}
	v = projectAccept.call("invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	if object(t, v["data"])["scope"] != "project" {
		t.Fatalf("Project acceptance: %#v", v)
	}
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: mcpOrgInvitationLookup(t, invite, token), InvitationTeamCall: func(context.Context, string) (model.TeamRef, error) { return team.TeamRef, nil }})
	v = projectRead.call("invitation_inspect", map[string]any{"link": teamLink}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("Team scope refusal: %#v", v)
	}
}

func TestCombinedScopedTeamProviderMustMatchRequestSnapshot(t *testing.T) {
	tx := newHTTPTestStore(t)
	serviceProvider := scopedAuthorization
	snapshot := func(ctx context.Context, _ store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
		return serviceProvider(ctx, p)
	}
	teams, err := teamservice.NewScopedTeams(tx, serviceProvider, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "project:read")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"project": a}}); err != nil {
		t.Fatal(err)
	}
	broader := scopedTestAuthorization(t, "project:read", "team:read", "team:write", "team:invitation-read", "team:invitation-accept")
	var mode string
	provider := func(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		switch mode {
		case "different scopes":
			return broader, nil
		case "different principal":
			other := a
			other.Principal.UserID = unknownTarget
			return other, nil
		case "missing policy":
			other := a
			other.Policy = nil
			return other, nil
		default:
			return model.CredentialAuthorization{}, context.Canceled
		}
	}
	projects := &scopedProjectFixture{visible: true}
	identity := &identityservice.Identity{}
	if err := RegisterCombinedScopedTeamTools(f.entry, teams, projects, identity, provider); err != nil {
		t.Fatal(err)
	}
	invitations := &scopedInvitationFixture{}
	if err := RegisterCombinedScopedInvitationTools(f.entry, identity, teams, invitations, "https://daynight.test", provider); err != nil {
		t.Fatal(err)
	}
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "project")}
	for _, mode = range []string{"different scopes", "different principal", "missing policy", "unavailable"} {
		for _, tc := range []struct {
			name  string
			args  map[string]any
			write bool
		}{
			{"team_show", map[string]any{"team": unknownTeam}, false},
			{"team_rename", map[string]any{"team": unknownTeam, "name": "new", "confirm": true}, true},
			{"invitation_inspect", map[string]any{"link": "https://daynight.test/invitations#dninvite_" + strings.Repeat("A", 43)}, false},
			{"invitation_accept", map[string]any{"link": "https://daynight.test/team-invitations#dnteam_" + strings.Repeat("A", 43), "confirm": true}, true},
		} {
			v := c.call(tc.name, tc.args, true)
			e := object(t, v["error"])
			if e["code"] == "insufficient_scope" || v["data"] != nil || tc.write && e["writeOutcome"] != "not_committed" {
				t.Fatalf("%s with %s: %#v", tc.name, mode, v)
			}
		}
	}
	if len(projects.calls) != 0 || len(invitations.calls) != 0 {
		t.Fatal("business service called after policy mismatch")
	}
}

func TestCombinedScopedRegistrationsRequireProtectedServices(t *testing.T) {
	f := newEntryFixture(t)
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"project": scopedTestAuthorization(t, "project:read")}}); err != nil {
		t.Fatal(err)
	}
	identity := &identityservice.Identity{}
	project := &scopedProjectFixture{visible: true}
	invitations := &scopedInvitationFixture{}
	provider := scopedAuthorization
	if err := RegisterCombinedScopedTeamTools(f.entry, &scopedTeamFixture{}, project, identity, provider); err == nil {
		t.Fatal("unprotected Team service registered")
	}
	if err := RegisterCombinedScopedInvitationTools(f.entry, identity, &invitationTestTeams{}, invitations, "https://daynight.test", provider); err == nil {
		t.Fatal("unprotected Team invitations registered")
	}
	if err := RegisterCombinedScopedTeamTools(nil, nil, project, identity, provider); err == nil {
		t.Fatal("nil entry accepted")
	}
	if err := RegisterCombinedScopedInvitationTools(nil, identity, nil, invitations, "https://daynight.test", provider); err == nil {
		t.Fatal("nil entry accepted")
	}
	if err := RegisterCombinedScopedTeamTools(f.entry, nil, nil, identity, provider); err == nil {
		t.Fatal("nil Project service accepted")
	}
	if err := RegisterCombinedScopedInvitationTools(f.entry, identity, nil, nil, "https://daynight.test", provider); err == nil {
		t.Fatal("nil Project invitation service accepted")
	}
}
