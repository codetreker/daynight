package mcp

import (
	"context"
	"encoding/json"
	"fmt"
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

type memberPageDB struct {
	store.TeamWriter
	items []model.TeamMemberProfile
}
type memberPageScope struct {
	store.SnapshotScope
	items []model.TeamMemberProfile
}
type memberPageReader struct {
	store.TeamReader
	items []model.TeamMemberProfile
}

func (db *memberPageDB) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	return f(memberPageScope{items: db.items})
}
func (sc memberPageScope) TeamDAO() store.TeamReader                      { return memberPageReader{items: sc.items} }
func (memberPageReader) TeamAccess(context.Context, string, string) error { return nil }
func (r memberPageReader) TeamMembersPage(_ context.Context, _ string, page store.Page) (store.TeamMemberPage, error) {
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

func TestTeamMemberMCPPagePreservesCountAndContinues(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	db := &memberPageDB{}
	avatar := "https://example.com/" + strings.Repeat("a", (512<<10)-len("https://example.com/"))
	for i := range 10 {
		stamp := time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		db.items = append(db.items, model.TeamMemberProfile{Membership: model.TeamMember{TeamID: unknownTeam, UserID: fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1), Role: model.ProjectMemberRole, Version: 1, CreatedAt: stamp, UpdatedAt: stamp}, Profile: model.ProjectParticipantProfile{AvatarURL: &avatar}})
	}
	if err := RegisterTeamTools(f.entry, teamservice.NewTeams(db), projectservice.NewProjects(&failedTeamReadDB{}), identity.New(nil, nil, "")); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2025-11-25", "alice")
	var cursor *string
	for offset := 0; offset < len(db.items); offset += 8 {
		args := map[string]any{"team": unknownTeam, "limit": 8}
		if cursor != nil {
			args["cursor"] = *cursor
		}
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_member_list", Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("page %d: %v", offset, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		if offset == 0 && len(raw) <= 4<<20 {
			t.Fatalf("fixture does not exceed former page budget: %d", len(raw))
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
		if len(env.Data.Items) != min(8, len(db.items)-offset) {
			t.Fatalf("page %d count: %d", offset, len(env.Data.Items))
		}
		for i, item := range env.Data.Items {
			if item.UserID != db.items[offset+i].Membership.UserID {
				t.Fatalf("page %d lost member %d", offset, i)
			}
		}
		cursor = env.Data.NextCursor
		if (cursor != nil) != (offset+8 < len(db.items)) {
			t.Fatalf("page %d cursor: %v", offset, cursor)
		}
	}
}
