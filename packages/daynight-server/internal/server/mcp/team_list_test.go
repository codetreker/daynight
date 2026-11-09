package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTeamListMCPPaginationAndOversizedItem(t *testing.T) {
	mocks := newTeamToolMocks(t)
	f := registerTeamToolMocks(t, mocks)
	var items []model.Team
	for i, name := range []string{strings.Repeat("<", 500000), strings.Repeat("<", 500000), strings.Repeat("<", 800000)} {
		team := testUnknownTeam()
		team.ID = []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}[i]
		team.Name = &name
		team.CreatedAt = time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		items = append(items, team)
	}
	cursors := []string{"team-page-1", "team-page-2"}
	call := 0
	mocks.expect("Teams.ListAdmitted", "Teams.ListAdmitted", "Teams.ListAdmitted")
	mocks.teams.ListAdmittedFunc = func(_ context.Context, _ model.Principal, request model.PageRequest, measure func([]model.Team, *string) error) (coreteam.TeamPage, error) {
		index := call
		call++
		expected := model.PageRequest{Limit: 10}
		if index > 0 {
			expected.Cursor = &cursors[index-1]
		}
		if !reflect.DeepEqual(request, expected) {
			t.Errorf("request = %+v; want %+v", request, expected)
		}
		var cursor *string
		if index < len(cursors) {
			cursor = &cursors[index]
		}
		err := measure(items[index:index+1], cursor)
		if index == 2 {
			var violation *limit.Violation
			if !errors.As(err, &violation) {
				t.Errorf("oversized Team envelope = %v", err)
			}
			return coreteam.TeamPage{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Team exceeds the encoded page limit.", Cause: err}
		}
		if err != nil {
			t.Errorf("one-Team envelope: %v", err)
		}
		var violation *limit.Violation
		if err := measure(items[index:index+2], cursor); !errors.As(err, &violation) {
			t.Errorf("two-Team envelope = %v", err)
		}
		return coreteam.TeamPage{Items: items[index : index+1], NextCursor: cursor}, nil
	}
	c := f.client(t, "2025-11-25", "alice")
	var cursor string
	for i := 0; i < 2; i++ {
		args := map[string]any{"limit": 10}
		if cursor != "" {
			args["cursor"] = cursor
		}
		result, err := c.CallTool(context.Background(), &sdk.CallToolParams{Name: "team_list", Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("page %d: %#v %v", i, result, err)
		}
		raw, _ := json.Marshal(result.StructuredContent)
		var env struct {
			Data struct {
				Items []struct {
					ID string `json:"id"`
				} `json:"items"`
				NextCursor string `json:"nextCursor"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		if len(env.Data.Items) != 1 || env.Data.Items[0].ID != items[i].ID || env.Data.NextCursor == "" {
			t.Fatalf("page %d: %s", i, raw)
		}
		cursor = env.Data.NextCursor
	}
	result, err := c.CallTool(context.Background(), &sdk.CallToolParams{Name: "team_list", Arguments: map[string]any{"limit": 10, "cursor": cursor}})
	if err != nil || !result.IsError {
		t.Fatalf("oversized: %#v %v", result, err)
	}
	raw, _ := json.Marshal(result.StructuredContent)
	var env struct {
		Error struct {
			Code string         `json:"code"`
			Refs map[string]any `json:"refs"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Error.Code != "resource_limit_exceeded" {
		t.Fatalf("oversized: %s", raw)
	}
}
