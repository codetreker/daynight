package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTeamWritePreflightFailuresAreNotCommitted(t *testing.T) {
	mocks := newTeamToolMocks(t)
	f := registerTeamToolMocks(t, mocks)
	c := f.client(t, "2025-11-25", "alice")
	cases := []struct {
		name string
		args map[string]any
	}{
		{"team_rename", map[string]any{"name": "new", "confirm": true}},
		{"team_delete", map[string]any{"confirm": true}},
		{"team_leave", map[string]any{"confirm": true}},
		{"team_member_set_role", map[string]any{"userId": unknownTarget, "role": "admin", "confirm": true}},
		{"team_member_remove", map[string]any{"userId": unknownTarget, "confirm": true}},
	}
	for _, selection := range []string{unknownTeam, "personal"} {
		for _, tc := range cases {
			t.Run(selection+"/"+tc.name, func(t *testing.T) {
				failure := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("read completion failed")}
				if selection == "personal" {
					mocks.expect("Identity.PersonalTeamID")
					mocks.identities.PersonalTeamIDFunc = func(context.Context, model.Principal) (string, error) { return "", failure }
				} else if tc.name == "team_rename" || tc.name == "team_delete" {
					mocks.expect("Teams.Get")
					mocks.teams.GetFunc = func(_ context.Context, _ model.Principal, id string) (model.Team, error) {
						if id != unknownTeam {
							t.Errorf("Get(%s)", id)
						}
						return model.Team{}, failure
					}
				} else {
					mocks.expect("Teams.Member")
					mocks.teams.MemberFunc = func(_ context.Context, _ model.Principal, id, user string) (model.TeamMember, error) {
						target := unknownTarget
						if tc.name == "team_leave" {
							target = unknownActor
						}
						if id != unknownTeam || user != target {
							t.Errorf("Member(%s, %s)", id, user)
						}
						return model.TeamMember{}, failure
					}
				}

				args := make(map[string]any, len(tc.args)+1)
				for k, v := range tc.args {
					args[k] = v
				}
				args["team"] = selection
				result, err := c.CallTool(context.Background(), &sdk.CallToolParams{Name: tc.name, Arguments: args})
				if err != nil || !result.IsError {
					t.Fatalf("result=%#v err=%v", result, err)
				}
				raw, err := json.Marshal(result.StructuredContent)
				if err != nil {
					t.Fatal(err)
				}
				var env struct {
					Error map[string]any  `json:"error"`
					Data  json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(raw, &env); err != nil {
					t.Fatal(err)
				}
				if env.Error["writeOutcome"] != "not_committed" || env.Error["phase"] != "commit" || len(env.Data) != 0 {
					t.Fatalf("invalid preflight failure: %s", raw)
				}
				mocks.verify()
			})
		}
	}
}
