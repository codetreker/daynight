package mcp

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type listTeamsDB struct {
	store.TeamWriter
	store.SnapshotReader
	items []model.Team
}
type listTeamsScope struct {
	store.SnapshotScope
	items []model.Team
}
type listTeamsReader struct {
	store.TeamReader
	items []model.Team
}

func (d *listTeamsDB) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	return f(listTeamsScope{items: d.items})
}
func (s listTeamsScope) TeamDAO() store.TeamReader { return listTeamsReader{items: s.items} }
func (r listTeamsReader) Teams(_ context.Context, _ string, page store.Page) (store.TeamPage, error) {
	result := store.TeamPage{Items: []model.Team{}}
	for _, item := range r.items {
		if page.After != nil && !item.CreatedAt.After(page.After.CreatedAt) {
			continue
		}
		if len(result.Items) == page.Limit {
			result.HasMore = true
			break
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

func TestTeamListMCPPagination(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	db := &listTeamsDB{}
	for i, name := range []string{"First", "Second", "Third"} {
		team := testUnknownTeam()
		team.ID = []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}[i]
		team.Name = &name
		team.CreatedAt = time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		db.items = append(db.items, team)
	}
	if err := RegisterTeamTools(f.entry, teamservice.NewTeams(db), projectservice.NewProjects(&failedTeamReadDB{}), identity.New(nil, nil, "")); err != nil {
		t.Fatal(err)
	}
	c := f.client(t, "2025-11-25", "alice")
	var cursor *string
	for offset := 0; offset < len(db.items); offset += 2 {
		args := map[string]any{"limit": 2}
		if cursor != nil {
			args["cursor"] = *cursor
		}
		result, err := c.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_list", Arguments: args})
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
		if len(env.Data.Items) != min(2, len(db.items)-offset) {
			t.Fatalf("page %d count: %s", offset, raw)
		}
		for i, item := range env.Data.Items {
			if item.ID != db.items[offset+i].ID {
				t.Fatalf("page %d item %d: %s", offset, i, raw)
			}
		}
		cursor = env.Data.NextCursor
		if (cursor != nil) != (offset+2 < len(db.items)) {
			t.Fatalf("page %d cursor: %s", offset, raw)
		}
	}
}
