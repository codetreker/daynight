package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type failedTeamPreflightDB struct {
	*failedTeamReadDB
	writes int
}

func (d *failedTeamPreflightDB) WriteTeam(context.Context, string, func(store.TeamWriteScope) error) (store.Completion, error) {
	d.writes++
	return store.Completion{}, errors.New("unexpected write")
}

type failedPersonalRead struct{}

func (failedPersonalRead) WriteIdentity(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("read completion failed")}
}

func TestTeamWritePreflightFailuresAreNotCommitted(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	db := &failedTeamPreflightDB{failedTeamReadDB: &failedTeamReadDB{outcome: store.TransactionUnknown}}
	if err := RegisterTeamTools(f.entry, teamservice.NewTeams(db), projectservice.NewProjects(db), identity.New(failedPersonalRead{}, nil, "")); err != nil {
		t.Fatal(err)
	}
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
				if env.Error["writeOutcome"] != "not_committed" || env.Error["phase"] != "commit" || len(env.Data) != 0 || db.writes != 0 {
					t.Fatalf("invalid preflight failure: %s writes=%d", raw, db.writes)
				}
			})
		}
	}
}
