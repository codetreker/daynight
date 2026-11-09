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

func TestTeamMemberMCPPageFitsMaximumProfileAndContinues(t *testing.T) {
	mocks := newTeamToolMocks(t)
	f := registerTeamToolMocks(t, mocks)
	var items []model.TeamMemberProfile
	avatar := strings.Repeat("<", 512<<10)
	for i, id := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"} {
		stamp := time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)
		items = append(items, model.TeamMemberProfile{Membership: model.TeamMember{TeamID: unknownTeam, UserID: id, Role: model.ProjectMemberRole, Version: 1, CreatedAt: stamp, UpdatedAt: stamp}, Profile: model.ProjectParticipantProfile{AvatarURL: &avatar}})
	}
	next := "member-page-1"
	call := 0
	mocks.expect("Teams.MembersAdmitted", "Teams.MembersAdmitted", "Teams.MembersAdmitted")
	mocks.teams.MembersAdmittedFunc = func(_ context.Context, _ model.Principal, id string, request model.PageRequest, measure func([]model.TeamMemberProfile, *string) error) (coreteam.MemberPage, error) {
		index := call
		call++
		expected := model.PageRequest{Limit: 10}
		if index == 1 {
			expected.Cursor = &next
		}
		if id != unknownTeam || !reflect.DeepEqual(request, expected) {
			t.Errorf("member request %s %+v; want %+v", id, request, expected)
		}
		if index == 2 {
			oversized := items[0]
			tooLarge := strings.Repeat("<", 800000)
			oversized.Profile.AvatarURL = &tooLarge
			err := measure([]model.TeamMemberProfile{oversized}, nil)
			var violation *limit.Violation
			if !errors.As(err, &violation) {
				t.Errorf("oversized member envelope = %v", err)
			}
			return coreteam.MemberPage{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Team member exceeds the encoded page limit.", Cause: err}
		}
		var cursor *string
		if index == 0 {
			cursor = &next
		}
		if err := measure(items[index:index+1], cursor); err != nil {
			t.Errorf("single maximum profile: %v", err)
		}
		if index == 0 {
			var violation *limit.Violation
			if err := measure(items, nil); !errors.As(err, &violation) {
				t.Errorf("combined profile envelope = %v", err)
			}
		}
		return coreteam.MemberPage{Items: items[index : index+1], NextCursor: cursor}, nil
	}
	client := f.client(t, "2025-11-25", "alice")
	var cursor string
	for i := range items {
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
		if len(env.Data.Items) != 1 || env.Data.Items[0].UserID != items[i].Membership.UserID {
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
