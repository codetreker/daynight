package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type validTeamAuth struct{}

func (validTeamAuth) Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error) {
	return model.Principal{Kind: model.PATCredential, UserID: unknownActor, CredentialID: "44444444-4444-4444-8444-444444444444"}, nil
}

type failedTeamReadDB struct {
	store.TeamWriter
	store.ProjectWriter
	store.ProjectCreationWriter
	outcome store.TransactionOutcome
}

func (d *failedTeamReadDB) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	if err := f(failedTeamReadScope{}); err != nil {
		return err
	}
	return &store.TransactionError{Phase: "commit", Outcome: d.outcome, CommitAttempted: true, Cause: errors.New("snapshot completion failure")}
}

type failedTeamReadScope struct{ store.SnapshotScope }

func (failedTeamReadScope) TeamDAO() store.TeamReader       { return failedTeamReadTeam{} }
func (failedTeamReadScope) ProjectDAO() store.ProjectReader { return failedTeamReadProject{} }

type failedTeamReadTeam struct{ unknownReader }

func (failedTeamReadTeam) TeamsBounded(context.Context, string, store.Page, int) (store.TeamPage, error) {
	return store.TeamPage{}, nil
}
func (failedTeamReadTeam) TeamMembersPage(context.Context, string, store.Page) (store.TeamMemberPage, error) {
	return store.TeamMemberPage{}, nil
}

type failedTeamReadProject struct{ store.ProjectReader }

func (failedTeamReadProject) ScopedProjects(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error) {
	return store.ProjectPage{}, nil
}

func TestTeamReadSnapshotFailureHasNoWriteOutcome(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	db := &failedTeamReadDB{}
	if err := RegisterTeamTools(f.entry, teamservice.NewTeams(db), projectservice.NewProjects(db), identity.New(nil, nil, "")); err != nil {
		t.Fatal(err)
	}
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
		db.outcome = outcome
		for _, tc := range cases {
			t.Run(string(outcome)+"/"+tc.name, func(t *testing.T) {
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
			})
		}
	}
}
