package server

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func exerciseMCPTeams(t *testing.T, org *mcpOrgFixture, alice, bob *sdk.ClientSession, principals []model.Principal) {
	t.Helper()
	personalID := "e1111111-1111-4111-8111-111111111111"
	org.bindIdentity(org.identity, principals, []string{personalID, "e2222222-2222-4222-8222-222222222222"}, 2)
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
	mcpOrgCreateTeam(t, org, principals[0], team)
	created := call(alice, "team_create", map[string]any{"name": "MCP Team", "confirm": true}, "")
	projectHTTPCheck(t, created["id"], team.ID)
	id := team.ID
	prepareTeamRead := func(actor model.Principal, v model.Team) { mcpOrgTeamRead(t, org, actor, v) }
	prepareTeamRead(principals[0], team)
	renamed := team
	newName := "Renamed"
	renamed.Name = &newName
	renamed.Version = 2
	renamed.UpdatedAt = team.UpdatedAt.Add(time.Second)
	mcpOrgTeamRename(t, org, principals[0], id, teamcore.ChangeTeam{Name: "Renamed", Version: team.Version, ExpectedUserID: principals[0].UserID}, renamed, nil)
	receipt := call(alice, "team_rename", map[string]any{"team": id, "name": "Renamed", "confirm": true}, "")
	projectHTTPCheck(t, receipt["version"], "2")
	personal := mcpOrgTeam(t, personalID, "", principals[0].UserID)
	personal.Kind = "personal"
	personal.Name = nil
	for _, operation := range []string{"team_rename", "team_delete"} {
		prepareTeamRead(principals[0], personal)
		immutable := &model.Fault{Code: "personal_team_immutable", Message: "Personal Teams cannot be changed."}
		if operation == "team_rename" {
			mcpOrgTeamRename(t, org, principals[0], personal.ID, teamcore.ChangeTeam{Name: "no", Version: personal.Version, ExpectedUserID: principals[0].UserID}, model.Team{}, immutable)
		} else {
			mcpOrgTeamDelete(t, org, principals[0], personal.ID, teamcore.ChangeTeam{Name: "personal", Version: personal.Version, ExpectedUserID: principals[0].UserID}, immutable)
		}
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
		row := members[i]
		want := model.PageRequest{Limit: 1}
		if i > 0 {
			current := cursor.(string)
			want.Cursor = &current
		}
		result := teamcore.MemberPage{Items: []model.TeamMemberProfile{row}}
		if i == 0 {
			next := "member-page-2"
			result.NextCursor = &next
		}
		mcpOrgMemberPage(t, org, principals[0], id, want, result, nil)
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

	mcpOrgMemberPage(t, org, principals[1], id, model.PageRequest{Limit: 50, Cursor: &next}, teamcore.MemberPage{}, &model.Fault{Code: "invalid_input", Message: "Invalid cursor."})
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
	prepareMember := func(actor model.Principal, v model.TeamMember) { mcpOrgMember(t, org, actor, id, v) }
	prepareMember(principals[0], bobMember)
	promoted := bobMember
	promoted.Role = model.ProjectAdmin
	promoted.Version = 2
	promoted.UpdatedAt = bobMember.UpdatedAt.Add(time.Second)
	promotedActorRole := model.ProjectAdmin
	roleChanged := org.expect("Teams.SetMemberRole")
	org.teams.SetMemberRoleCall = func(ctx context.Context, p model.Principal, teamID, user string, input teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error) {
		roleChanged()
		org.check(ctx, p, principals[0], []string{teamID, user}, []string{id, principals[1].UserID})
		projectHTTPCheck(t, input, teamcore.ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: principals[0].UserID})
		role := promotedActorRole
		return teamcore.TeamMemberResult{Membership: promoted, ActorRole: &role}, nil
	}
	call(alice, "team_member_set_role", map[string]any{"team": id, "userId": principals[1].UserID, "role": "admin", "ifVersion": bobVersion, "confirm": true}, "")
	prepareMember(principals[0], promoted)
	org.teams.SetMemberRoleCall = nil
	call(alice, "team_member_set_role", map[string]any{"team": id, "userId": principals[1].UserID, "role": "admin", "ifVersion": bobVersion, "confirm": true}, "version_conflict")
	projects := []model.Project{projectHTTPRecord("e4444444-4444-4444-8444-444444444444", "MCP 0", "https://example.com/mcp-0", id), projectHTTPRecord("e5555555-5555-4555-8555-555555555555", "MCP 1", "https://example.com/mcp-1", id)}
	projects[1].CreatedAt = projects[1].CreatedAt.Add(time.Second)
	projects[1].UpdatedAt = projects[1].CreatedAt
	var projectPages [2]map[string]any
	cursor = nil
	for i := range 2 {
		row := projects[i]
		want := projectcore.ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: &id}
		if i > 0 {
			current := cursor.(string)
			want.Page.Cursor = &current
		}
		result := projectcore.ProjectPage{Items: []model.Project{row}}
		if i == 0 {
			next := "project-page-2"
			result.NextCursor = &next
		}
		mcpOrgProjectPage(t, org, principals[0], want, result)
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
	mcpOrgTeamDelete(t, org, principals[0], id, teamcore.ChangeTeam{Name: *renamed.Name, Version: renamed.Version, ExpectedUserID: principals[0].UserID}, &model.Fault{Code: "team_not_empty", Message: "Team has Projects."})
	call(alice, "team_delete", map[string]any{"team": id, "confirm": true}, "team_not_empty")
	prepareMember(principals[1], promoted)
	removed := org.expect("Teams.RemoveMember")
	org.teams.RemoveMemberCall = func(ctx context.Context, p model.Principal, teamID, user string, input teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error) {
		removed()
		org.check(ctx, p, principals[1], []string{teamID, user}, []string{id, principals[1].UserID})
		projectHTTPCheck(t, input, teamcore.ChangeTeamMember{Version: promoted.Version, ExpectedUserID: principals[1].UserID})
		return teamcore.TeamMemberResult{Membership: promoted, ActorRole: nil}, nil
	}
	call(bob, "team_leave", map[string]any{"team": id, "confirm": true}, "")
	mcpOrgMemberPage(t, org, principals[1], id, model.PageRequest{Limit: 50}, teamcore.MemberPage{}, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: model.ErrNotFound})
	call(bob, "team_member_list", map[string]any{"team": id}, "not_found")
	prepareMember(principals[0], team.Membership)
	refused := org.expect("Teams.RemoveMember")
	org.teams.RemoveMemberCall = func(ctx context.Context, p model.Principal, teamID, user string, input teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error) {
		refused()
		org.check(ctx, p, principals[0], []string{teamID, user}, []string{id, principals[0].UserID})
		projectHTTPCheck(t, input, teamcore.ChangeTeamMember{Version: team.Membership.Version, ExpectedUserID: principals[0].UserID})
		return teamcore.TeamMemberResult{}, &model.Fault{Code: "last_admin", Message: "The last administrator cannot leave."}
	}
	call(alice, "team_leave", map[string]any{"team": id, "confirm": true}, "last_admin")
}
