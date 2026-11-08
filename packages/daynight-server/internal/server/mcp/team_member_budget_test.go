package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type memberBudgetDB struct {
	store.TeamWriter
	items []model.TeamMemberProfile
}
type memberBudgetScope struct {
	store.SnapshotScope
	items []model.TeamMemberProfile
}
type memberBudgetReader struct {
	store.TeamReader
	items []model.TeamMemberProfile
}

func (db *memberBudgetDB) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	return f(memberBudgetScope{items: db.items})
}
func (sc memberBudgetScope) TeamDAO() store.TeamReader                      { return memberBudgetReader{items: sc.items} }
func (memberBudgetReader) TeamAccess(context.Context, string, string) error { return nil }
func (r memberBudgetReader) TeamMembersPage(_ context.Context, _ string, page store.Page) (store.TeamMemberPage, error) {
	out := store.TeamMemberPage{Items: []model.TeamMemberProfile{}}
	for _, item := range r.items {
		if page.After != nil && !item.Membership.CreatedAt.After(page.After.CreatedAt) {
			continue
		}
		if len(out.Items) == page.Limit {
			out.HasMore = true
			break
		}
		out.Items = append(out.Items, item)
	}
	return out, nil
}

func TestTeamMemberMCPPageFitsMaximumProfileAndContinues(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	db := &memberBudgetDB{}
	avatar := strings.Repeat("<", 512<<10)
	for i, id := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"} {
		stamp := time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		db.items = append(db.items, model.TeamMemberProfile{Membership: model.TeamMember{TeamID: unknownTeam, UserID: id, Role: model.ProjectMemberRole, Version: 1, CreatedAt: stamp, UpdatedAt: stamp}, Profile: model.ProjectParticipantProfile{AvatarURL: &avatar}})
	}
	if err := RegisterTeamTools(f.entry, teamservice.NewTeams(db), projectservice.NewProjects(&failedTeamReadDB{}), identity.New(nil, nil, "")); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2025-11-25", "alice")
	var cursor string
	for i := range db.items {
		args := map[string]any{"team": unknownTeam, "limit": 10}
		if cursor != "" {
			args["cursor"] = cursor
		}
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_member_list", Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("page %d: %v", i, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil || len(raw) > 4<<20 {
			t.Fatalf("encoded page %d: %d %v", i, len(raw), err)
		}
		var env struct {
			Data struct {
				Items []struct {
					UserID string `json:"userId"`
				} `json:"items"`
				NextCursor *string `json:"nextCursor"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		if len(env.Data.Items) != 1 || env.Data.Items[0].UserID != db.items[i].Membership.UserID {
			t.Fatalf("page %d lost member", i)
		}
		cursor = ""
		if env.Data.NextCursor != nil {
			cursor = *env.Data.NextCursor
		}
	}
	if cursor != "" {
		t.Fatal("last page has cursor")
	}
	tooLarge := strings.Repeat("<", 800000)
	db.items[0].Profile.AvatarURL = &tooLarge
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_member_list", Arguments: map[string]any{"team": unknownTeam, "limit": 10}})
	if err != nil || !result.IsError {
		t.Fatalf("oversized: %v", err)
	}
	raw, _ := json.Marshal(result.StructuredContent)
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &failure) != nil || failure.Error.Code != "resource_limit_exceeded" {
		t.Fatalf("failure: %s", raw)
	}
}
