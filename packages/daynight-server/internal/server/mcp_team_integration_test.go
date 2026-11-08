package server

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func exerciseMCPTeams(t *testing.T, db *postgres.Store, alice, bob *sdk.ClientSession, principals []model.Principal) {
	t.Helper()
	call := func(client *sdk.ClientSession, name string, args map[string]any, code string) map[string]any {
		t.Helper()
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
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
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if result.IsError != (code != "") || envelope.Error.Code != code {
			t.Fatalf("%s: %s", name, raw)
		}
		return envelope.Data
	}
	team := call(alice, "team_create", map[string]any{"name": "MCP Team", "confirm": true}, "")
	id := team["id"].(string)
	call(alice, "team_rename", map[string]any{"team": id, "name": "Renamed", "confirm": true}, "")
	call(alice, "team_rename", map[string]any{"team": "personal", "name": "no", "confirm": true}, "personal_team_immutable")
	call(alice, "team_delete", map[string]any{"team": "personal", "confirm": true}, "personal_team_immutable")
	if _, err := db.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, id, principals[1].UserID); err != nil {
		t.Fatal(err)
	}
	page := call(alice, "team_member_list", map[string]any{"team": id, "limit": 1}, "")
	next := page["nextCursor"].(string)
	page2 := call(alice, "team_member_list", map[string]any{"team": id, "limit": 1, "cursor": next}, "")
	if len(page["items"].([]any)) != 1 || len(page2["items"].([]any)) != 1 {
		t.Fatalf("member pages: %#v %#v", page, page2)
	}
	call(bob, "team_member_list", map[string]any{"team": id, "cursor": next}, "invalid_input")
	var bobVersion string
	for _, p := range []map[string]any{page, page2} {
		item := p["items"].([]any)[0].(map[string]any)
		member := item
		if member["userId"] == principals[1].UserID {
			bobVersion = member["version"].(string)
		}
	}
	if bobVersion == "" {
		t.Fatal("member missing from pages")
	}
	call(alice, "team_member_set_role", map[string]any{"team": id, "userId": principals[1].UserID, "role": "admin", "ifVersion": bobVersion, "confirm": true}, "")
	call(alice, "team_member_set_role", map[string]any{"team": id, "userId": principals[1].UserID, "role": "admin", "ifVersion": bobVersion, "confirm": true}, "version_conflict")
	projects := projectservice.NewProjects(db)
	for i := range 2 {
		_, err := projects.Create(t.Context(), principals[0], coreproject.CreateProject{Name: fmt.Sprintf("MCP %d", i), RepoURL: fmt.Sprintf("https://example.com/mcp-%d", i), TeamID: &id, ExpectedUserID: principals[0].UserID})
		if err != nil {
			t.Fatal(err)
		}
	}
	first := call(alice, "team_projects", map[string]any{"team": id, "limit": 1}, "")
	second := call(alice, "team_projects", map[string]any{"team": id, "limit": 1, "cursor": first["nextCursor"]}, "")
	if len(first["items"].([]any)) != 1 || len(second["items"].([]any)) != 1 {
		t.Fatal("project pagination lost items")
	}
	call(alice, "team_delete", map[string]any{"team": id, "confirm": true}, "team_not_empty")
	call(bob, "team_leave", map[string]any{"team": id, "confirm": true}, "")
	call(bob, "team_member_list", map[string]any{"team": id}, "not_found")
	call(alice, "team_leave", map[string]any{"team": id, "confirm": true}, "last_admin")
}
