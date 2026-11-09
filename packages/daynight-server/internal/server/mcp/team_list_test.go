package mcp

import (
	"context"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"reflect"
	"testing"
	"time"
)

func TestTeamListMCPPagination(t *testing.T) {
	mocks := newTeamToolMocks(t)
	f := registerTeamToolMocks(t, mocks)
	items := make([]model.Team, 3)
	for i, name := range []string{"First", "Second", "Third"} {
		item := testUnknownTeam()
		item.ID = []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}[i]
		item.Name = &name
		item.CreatedAt = time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		items[i] = item
	}
	next := "team-page-2"
	mocks.expect("Teams.List", "Teams.List")
	calls := 0
	mocks.teams.ListFunc = func(_ context.Context, _ model.Principal, request model.PageRequest) (coreteam.TeamPage, error) {
		offset := calls * 2
		calls++
		expected := model.PageRequest{Limit: 2}
		if offset > 0 {
			expected.Cursor = &next
		}
		if !reflect.DeepEqual(request, expected) {
			t.Errorf("request=%+v want=%+v", request, expected)
		}
		page := coreteam.TeamPage{Items: items[offset:min(offset+2, len(items))]}
		if offset == 0 {
			page.NextCursor = &next
		}
		return page, nil
	}
	client := f.client(t, "2025-11-25", "alice")
	var cursor *string
	for offset := 0; offset < len(items); offset += 2 {
		args := map[string]any{"limit": 2}
		if cursor != nil {
			args["cursor"] = *cursor
		}
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_list", Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("page %d: %#v %v", offset, result, err)
		}
		raw, _ := json.Marshal(result.StructuredContent)
		var env struct {
			Data struct {
				Items []struct {
					ID string `json:"id"`
				} `json:"items"`
				NextCursor *string `json:"nextCursor"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		if len(env.Data.Items) != min(2, len(items)-offset) {
			t.Fatalf("page %d count: %s", offset, raw)
		}
		for i, item := range env.Data.Items {
			if item.ID != items[offset+i].ID {
				t.Fatalf("page %d item %d: %s", offset, i, raw)
			}
		}
		cursor = env.Data.NextCursor
		if (cursor != nil) != (offset+2 < len(items)) {
			t.Fatalf("page %d cursor: %s", offset, raw)
		}
	}
}
