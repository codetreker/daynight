package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const unknownActor = "11111111-1111-4111-8111-111111111111"
const unknownTeam = "22222222-2222-4222-8222-222222222222"
const unknownTarget = "33333333-3333-4333-8333-333333333333"

const createdTeamID = "55555555-5555-4555-8555-555555555555"

func testUnknownTeam() model.Team {
	name := "Original"
	return model.Team{TeamRef: model.TeamRef{ID: unknownTeam, Kind: "ordinary", Name: &name}, Version: 1, Membership: model.TeamMember{TeamID: unknownTeam, UserID: unknownActor, Role: model.ProjectAdmin, Version: 1}}
}
func unknownCommit() error {
	return &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost commit")}
}

func TestTeamUnknownWritesRetainReferencesInMCPEnvelope(t *testing.T) {
	mocks := newTeamToolMocks(t)
	f := registerTeamToolMocks(t, mocks)
	c := f.client(t, "2025-11-25", "alice")
	cases := []struct {
		name string
		args map[string]any
		user string
	}{
		{"team_create", map[string]any{"name": "New", "confirm": true}, ""},
		{"team_rename", map[string]any{"team": unknownTeam, "name": "Changed", "confirm": true}, ""},
		{"team_delete", map[string]any{"team": unknownTeam, "confirm": true}, ""},
		{"team_leave", map[string]any{"team": unknownTeam, "confirm": true}, unknownActor},
		{"team_member_set_role", map[string]any{"team": unknownTeam, "userId": unknownTarget, "role": "admin", "confirm": true}, unknownTarget},
		{"team_member_remove", map[string]any{"team": unknownTeam, "userId": unknownTarget, "confirm": true}, unknownTarget},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			failure := unknownCommit()
			if tc.name == "team_create" {
				failure = &teamservice.CreationError{TeamID: createdTeamID, Cause: failure}
			}
			configureTeamMutation(t, mocks, tc.name, tc.args, failure)
			result, err := c.CallTool(context.Background(), &sdk.CallToolParams{Name: tc.name, Arguments: tc.args})
			if err != nil || !result.IsError {
				t.Fatalf("result=%#v error=%v", result, err)
			}
			raw, err := json.Marshal(result.StructuredContent)
			if err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				Data  json.RawMessage `json:"data"`
				Error struct {
					WriteOutcome string         `json:"writeOutcome"`
					Refs         map[string]any `json:"refs"`
				} `json:"error"`
			}
			if err := json.Unmarshal(raw, &envelope); err != nil {
				t.Fatal(err)
			}
			expected := unknownTeam
			if tc.name == "team_create" {
				expected = createdTeamID
			}
			if len(envelope.Data) != 0 || envelope.Error.WriteOutcome != "unknown" || envelope.Error.Refs["teamId"] != expected || (tc.user != "" && envelope.Error.Refs["userId"] != tc.user) {
				t.Fatalf("unexpected unknown receipt %s", raw)
			}
			mocks.verify()
		})
	}
}
