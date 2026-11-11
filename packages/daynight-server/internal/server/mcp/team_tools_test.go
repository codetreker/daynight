package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTeamBusinessBodyLimitAndVersion(t *testing.T) {
	base := api.CreateTeamRequest{ExpectedUserID: "account"}
	encoded, _ := json.Marshal(base)
	base.Name = strings.Repeat("x", httpx.MaxJSONBody-len(encoded))
	if err := checkTeamBody(base); err != nil {
		t.Fatalf("exact limit: %v", err)
	}
	base.Name += "x"
	if err := checkTeamBody(base); err == nil {
		t.Fatal("oversized business body accepted")
	}
	// These characters remain unescaped in the CLI's JSON.stringify output.
	for _, text := range []string{strings.Repeat("<>&", 200000), strings.Repeat("\u2028", 200000), strings.Repeat("\u2029", 200000)} {
		base.Name = text
		if err := checkTeamBody(base); err != nil {
			t.Fatalf("valid JSON.stringify input rejected: %v", err)
		}
	}
	// An actual backslash-u sequence is escaped by JSON.stringify and counts as
	// seven bytes, rather than as one three-byte Unicode character.
	base.Name = strings.Repeat(`\u2028`, 150000)
	if err := checkTeamBody(base); err == nil {
		t.Fatal("escaped literal over limit accepted")
	}

	old := "9"
	if _, err := observedVersion(&old, 10); err == nil {
		t.Fatal("stale version accepted")
	}
	huge := "9223372036854775808"
	if _, err := observedVersion(&huge, 10); err == nil {
		t.Fatal("overflow accepted")
	}
	if v, err := observedVersion(nil, 10); err != nil || v != 10 {
		t.Fatalf("default version=%d, %v", v, err)
	}
}

func exerciseMCPTeams(t *testing.T, tx *httpTestStore, alice, bob *sdk.ClientSession, principals []model.Principal) {
	t.Helper()
	identity := tx.WriteIdentityCall
	defer func() { tx.WriteIdentityCall = identity }()
	personalID := "e1111111-1111-4111-8111-111111111111"
	mcpOrgAuthenticate(t, tx, principals, []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}, []string{personalID, "e2222222-2222-4222-8222-222222222222"}, 2)
	call := func(client *sdk.ClientSession, name string, args map[string]any, code string) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Data  map[string]any `json:"data"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err = json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if result.IsError != (code != "") || envelope.Error.Code != code {
			t.Fatalf("%s: %s", name, raw)
		}
		return envelope.Data
	}
	team := mcpOrgTeam(t, "e3333333-3333-4333-8333-333333333333", "MCP Team", principals[0].UserID)
	mcpOrgCreateTeam(t, tx, principals[0], team)
	created := call(alice, "team_create", map[string]any{"name": "MCP Team", "confirm": true}, "")
	projectHTTPCheck(t, created["id"], team.ID)
	id := team.ID
	prepareTeamRead := func(actor model.Principal, v model.Team) {
		t.Helper()
		read := projectHTTPCount(t, 1)
		mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(ctx context.Context, user, id string) (model.Team, error) {
			read()
			projectHTTPCheck(t, []string{user, id}, []string{actor.UserID, v.ID})
			return v, nil
		}})
	}
	prepareTeamRead(principals[0], team)
	readTeam, rename := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	renamed := team
	newName := "Renamed"
	renamed.Name = &newName
	renamed.Version = 2
	renamed.UpdatedAt = team.UpdatedAt.Add(time.Second)
	mcpOrgWriteTeam(t, tx, id, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
		readTeam()
		projectHTTPCheck(t, user, principals[0].UserID)
		return team, nil
	}, RenameCall: func(ctx context.Context, user, name string) (model.Team, error) {
		rename()
		projectHTTPCheck(t, []string{user, name}, []string{principals[0].UserID, "Renamed"})
		return renamed, nil
	}}, nil)
	receipt := call(alice, "team_rename", map[string]any{"team": id, "name": "Renamed", "confirm": true}, "")
	projectHTTPCheck(t, receipt["version"], "2")
	personal := mcpOrgTeam(t, personalID, "", principals[0].UserID)
	personal.Kind = "personal"
	personal.Name = nil
	for _, operation := range []string{"team_rename", "team_delete"} {
		prepareTeamRead(principals[0], personal)
		read := projectHTTPCount(t, 1)
		mcpOrgWriteTeam(t, tx, personal.ID, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
			read()
			projectHTTPCheck(t, user, principals[0].UserID)
			return personal, nil
		}}, nil)
		args := map[string]any{"team": "personal", "confirm": true}
		if operation == "team_rename" {
			args["name"] = "no"
		}
		call(alice, operation, args, "personal_team_immutable")
	}
	bobMember := model.TeamMember{TeamID: id, UserID: principals[1].UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: team.CreatedAt.Add(time.Second), UpdatedAt: team.CreatedAt.Add(time.Second)}
	members := []model.TeamMemberProfile{{Membership: team.Membership}, {Membership: bobMember}}
	var pages [2]map[string]any
	var cursor any
	for i := range 2 {
		access, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		want := store.Page{Limit: 1}
		if i > 0 {
			want.After = &store.Position{CreatedAt: members[i-1].Membership.CreatedAt, ID: members[i-1].Membership.UserID}
		}
		row := members[i]
		mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamAccessCall: func(ctx context.Context, user, id string) error {
			access()
			projectHTTPCheck(t, []string{user, id}, []string{principals[0].UserID, team.ID})
			return nil
		}, TeamMembersPageCall: func(ctx context.Context, id string, page store.Page) (store.TeamMemberPage, error) {
			read()
			projectHTTPCheck(t, id, team.ID)
			projectHTTPCheck(t, page, want)
			return store.TeamMemberPage{Items: []model.TeamMemberProfile{row}, HasMore: i == 0}, nil
		}})
		args := map[string]any{"team": id, "limit": 1}
		if cursor != nil {
			args["cursor"] = cursor
		}
		pages[i] = call(alice, "team_member_list", args, "")
		cursor = pages[i]["nextCursor"]
	}
	if len(pages[0]["items"].([]any)) != 1 || len(pages[1]["items"].([]any)) != 1 {
		t.Fatalf("member pages: %#v %#v", pages[0], pages[1])
	}
	next := pages[0]["nextCursor"].(string)
	tx.ReadSnapshotCall = nil
	call(bob, "team_member_list", map[string]any{"team": id, "cursor": next}, "invalid_input")
	bobVersion := ""
	for _, page := range pages {
		item := page["items"].([]any)[0].(map[string]any)
		if item["userId"] == principals[1].UserID {
			bobVersion = item["version"].(string)
		}
	}
	if bobVersion != "1" {
		t.Fatal("member missing from pages or version is incorrect")
	}
	prepareMember := func(actor model.Principal, v model.TeamMember) {
		t.Helper()
		access, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamAccessCall: func(ctx context.Context, user, teamID string) error {
			access()
			projectHTTPCheck(t, []string{user, teamID}, []string{actor.UserID, id})
			return nil
		}, InvitationTeamMemberCall: func(ctx context.Context, teamID, user string) (model.TeamMember, error) {
			read()
			projectHTTPCheck(t, []string{teamID, user}, []string{id, v.UserID})
			return v, nil
		}})
	}
	prepareMember(principals[0], bobMember)
	readTeam, member, setRole := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	promoted := bobMember
	promoted.Role = model.ProjectAdmin
	promoted.Version = 2
	promoted.UpdatedAt = bobMember.UpdatedAt.Add(time.Second)
	mcpOrgWriteTeam(t, tx, id, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
		readTeam()
		projectHTTPCheck(t, user, principals[0].UserID)
		return renamed, nil
	}, MemberCall: func(ctx context.Context, user string) (model.TeamMember, error) {
		member()
		projectHTTPCheck(t, user, bobMember.UserID)
		return bobMember, nil
	}, SetMemberRoleCall: func(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
		setRole()
		projectHTTPCheck(t, user, bobMember.UserID)
		projectHTTPCheck(t, role, model.ProjectAdmin)
		return promoted, nil
	}}, mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{TeamID: id, UserID: bobMember.UserID}))
	call(alice, "team_member_set_role", map[string]any{"team": id, "userId": principals[1].UserID, "role": "admin", "ifVersion": bobVersion, "confirm": true}, "")
	prepareMember(principals[0], promoted)
	tx.WriteTeamCall = nil
	call(alice, "team_member_set_role", map[string]any{"team": id, "userId": principals[1].UserID, "role": "admin", "ifVersion": bobVersion, "confirm": true}, "version_conflict")
	projects := []model.Project{projectHTTPRecord("e4444444-4444-4444-8444-444444444444", "MCP 0", "https://example.com/mcp-0", id), projectHTTPRecord("e5555555-5555-4555-8555-555555555555", "MCP 1", "https://example.com/mcp-1", id)}
	projects[1].CreatedAt = projects[1].CreatedAt.Add(time.Second)
	projects[1].UpdatedAt = projects[1].CreatedAt
	var projectPages [2]map[string]any
	cursor = nil
	for i := range 2 {
		read := projectHTTPCount(t, 1)
		want := store.Page{Limit: 1}
		if i > 0 {
			want.After = &store.Position{CreatedAt: projects[i-1].CreatedAt, ID: projects[i-1].ID}
		}
		row := projects[i]
		mcpOrgRead(t, tx, 1, mcpOrgProjectReader{ScopedProjectsCall: func(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
			read()
			projectHTTPCheck(t, p, principals[0])
			projectHTTPCheck(t, scope, store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: id})
			projectHTTPCheck(t, page, want)
			return store.ProjectPage{Items: []model.Project{row}, HasMore: i == 0}, nil
		}}, nil)
		args := map[string]any{"team": id, "limit": 1}
		if cursor != nil {
			args["cursor"] = cursor
		}
		projectPages[i] = call(alice, "team_projects", args, "")
		cursor = projectPages[i]["nextCursor"]
	}
	if len(projectPages[0]["items"].([]any)) != 1 || len(projectPages[1]["items"].([]any)) != 1 {
		t.Fatal("project pagination lost items")
	}
	prepareTeamRead(principals[0], renamed)
	readTeam, hasProjects := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	mcpOrgWriteTeam(t, tx, id, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
		readTeam()
		projectHTTPCheck(t, user, principals[0].UserID)
		return renamed, nil
	}, HasProjectsCall: func(context.Context) (bool, error) { hasProjects(); return true, nil }}, nil)
	call(alice, "team_delete", map[string]any{"team": id, "confirm": true}, "team_not_empty")
	prepareMember(principals[1], promoted)
	readTeam, member, count, remove := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	bobTeam := renamed
	bobTeam.Membership = promoted
	mcpOrgWriteTeam(t, tx, id, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
		readTeam()
		projectHTTPCheck(t, user, principals[1].UserID)
		return bobTeam, nil
	}, MemberCall: func(ctx context.Context, user string) (model.TeamMember, error) {
		member()
		projectHTTPCheck(t, user, principals[1].UserID)
		return promoted, nil
	}, AdminCountCall: func(context.Context) (int64, error) { count(); return 2, nil }, RemoveMemberCall: func(ctx context.Context, user string) error {
		remove()
		projectHTTPCheck(t, user, principals[1].UserID)
		return nil
	}}, mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{TeamID: id, UserID: principals[1].UserID}))
	call(bob, "team_leave", map[string]any{"team": id, "confirm": true}, "")
	access := projectHTTPCount(t, 1)
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamAccessCall: func(ctx context.Context, user, teamID string) error {
		access()
		projectHTTPCheck(t, []string{user, teamID}, []string{principals[1].UserID, id})
		return model.ErrNotFound
	}})
	call(bob, "team_member_list", map[string]any{"team": id}, "not_found")
	prepareMember(principals[0], team.Membership)
	readTeam, member, count = projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	mcpOrgWriteTeam(t, tx, id, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
		readTeam()
		projectHTTPCheck(t, user, principals[0].UserID)
		return renamed, nil
	}, MemberCall: func(ctx context.Context, user string) (model.TeamMember, error) {
		member()
		projectHTTPCheck(t, user, principals[0].UserID)
		return team.Membership, nil
	}, AdminCountCall: func(context.Context) (int64, error) { count(); return 1, nil }}, nil)
	call(alice, "team_leave", map[string]any{"team": id, "confirm": true}, "last_admin")
}

func TestMCPTeamsProductionLifecycle(t *testing.T) {
	tx := newHTTPTestStore(t)
	principals := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	mcpOrgAuthenticate(t, tx, principals, tokens, []string{"e1111111-1111-4111-8111-111111111111", "e2222222-2222-4222-8222-222222222222"}, 0)
	server, _ := newMCPHTTPServer(t, tx)
	exerciseMCPTeams(t, tx, mcpPATClient(t, server.URL, tokens[0]), mcpPATClient(t, server.URL, tokens[1]), principals)
}
