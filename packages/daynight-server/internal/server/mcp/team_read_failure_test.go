package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type validTeamAuth struct{}

func (validTeamAuth) Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error) {
	return model.Principal{Kind: model.PATCredential, UserID: unknownActor, CredentialID: "44444444-4444-4444-8444-444444444444"}, nil
}

func TestTeamReadSnapshotFailureHasNoWriteOutcome(t *testing.T) {
	mocks := newTeamToolMocks(t)
	f := registerTeamToolMocks(t, mocks)
	c := f.client(t, "2025-11-25", "alice")
	cases := []struct {
		name string
		args map[string]any
	}{
		{"team_list", map[string]any{}},
		{"team_show", map[string]any{"team": unknownTeam}},
		{"team_projects", map[string]any{"team": unknownTeam}},
		{"team_member_list", map[string]any{"team": unknownTeam}},
	}
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted, store.TransactionCommitted} {
		for _, tc := range cases {
			t.Run(string(outcome)+"/"+tc.name, func(t *testing.T) {
				failure := &store.TransactionError{Phase: "commit", Outcome: outcome, CommitAttempted: true, Cause: errors.New("snapshot completion failure")}
				switch tc.name {
				case "team_list":
					mocks.expect("Teams.ListAdmitted")
					mocks.teams.ListAdmittedFunc = func(_ context.Context, _ model.Principal, request model.PageRequest, _ func([]model.Team, *string) error) (coreteam.TeamPage, error) {
						if request.Limit != 50 || request.Cursor != nil {
							t.Errorf("page = %+v", request)
						}
						return coreteam.TeamPage{}, failure
					}
				case "team_show":
					mocks.expect("Teams.GetBounded")
					mocks.teams.GetBoundedFunc = func(_ context.Context, _ model.Principal, id string, limit int) (model.Team, error) {
						if id != unknownTeam || limit != 1<<20 {
							t.Errorf("GetBounded(%s, %d)", id, limit)
						}
						return model.Team{}, failure
					}
				case "team_projects":
					mocks.expect("Projects.ListAdmitted")
					mocks.projects.ListAdmittedFunc = func(_ context.Context, _ model.Principal, request coreproject.ProjectListRequest, _ func([]model.Project, *string) error) (coreproject.ProjectPage, error) {
						if request.TeamID == nil || *request.TeamID != unknownTeam || request.Page.Limit != 50 || request.Page.Cursor != nil {
							t.Errorf("scope = %+v", request)
						}
						return coreproject.ProjectPage{}, failure
					}
				case "team_member_list":
					mocks.expect("Teams.MembersAdmitted")
					mocks.teams.MembersAdmittedFunc = func(_ context.Context, _ model.Principal, id string, request model.PageRequest, _ func([]model.TeamMemberProfile, *string) error) (coreteam.MemberPage, error) {
						if id != unknownTeam || request.Limit != 50 || request.Cursor != nil {
							t.Errorf("member page %s %+v", id, request)
						}
						return coreteam.MemberPage{}, failure
					}
				}

				result, err := c.CallTool(context.Background(), &sdk.CallToolParams{Name: tc.name, Arguments: tc.args})
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
				if _, exists := env.Error["writeOutcome"]; exists || env.Error["code"] != "internal_error" || env.Error["phase"] != "commit" || len(env.Data) != 0 {
					t.Fatalf("invalid read failure: %s", raw)
				}
				mocks.verify()
			})
		}
	}
}
