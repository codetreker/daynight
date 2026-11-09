package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTeamMemberMCPPagePreservesCountAndContinues(t *testing.T) {
	mocks := newTeamToolMocks(t)
	f := registerTeamToolMocks(t, mocks)
	var items []model.TeamMemberProfile
	avatar := "https://example.com/" + strings.Repeat("a", (512<<10)-len("https://example.com/"))
	for i := range 10 {
		stamp := time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		items = append(items, model.TeamMemberProfile{Membership: model.TeamMember{TeamID: unknownTeam, UserID: fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1), Role: model.ProjectMemberRole, Version: 1, CreatedAt: stamp, UpdatedAt: stamp}, Profile: model.ProjectParticipantProfile{AvatarURL: &avatar}})
	}
	next := "member-page-2"
	mocks.expect("Teams.MembersPage", "Teams.MembersPage")
	calls := 0
	mocks.teams.MembersPageFunc = func(_ context.Context, _ model.Principal, id string, request model.PageRequest) (coreteam.MemberPage, error) {
		offset := calls * 8
		calls++
		expected := model.PageRequest{Limit: 8}
		if offset > 0 {
			expected.Cursor = &next
		}
		if id != unknownTeam || !reflect.DeepEqual(request, expected) {
			t.Errorf("member request %s %+v want=%+v", id, request, expected)
		}
		page := coreteam.MemberPage{Items: items[offset:min(offset+8, len(items))]}
		if offset == 0 {
			page.NextCursor = &next
		}
		return page, nil
	}

	client := f.client(t, "2025-11-25", "alice")
	var cursor *string
	for offset := 0; offset < len(items); offset += 8 {
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
		if len(env.Data.Items) != min(8, len(items)-offset) {
			t.Fatalf("page %d count: %d", offset, len(env.Data.Items))
		}
		for i, item := range env.Data.Items {
			if item.UserID != items[offset+i].Membership.UserID {
				t.Fatalf("page %d lost member %d", offset, i)
			}
		}
		cursor = env.Data.NextCursor
		if (cursor != nil) != (offset+8 < len(items)) {
			t.Fatalf("page %d cursor: %v", offset, cursor)
		}
	}
}
