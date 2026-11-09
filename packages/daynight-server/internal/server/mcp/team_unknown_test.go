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

const unknownActor = "11111111-1111-4111-8111-111111111111"
const unknownTeam = "22222222-2222-4222-8222-222222222222"
const unknownTarget = "33333333-3333-4333-8333-333333333333"

type unknownTeamDB struct {
	store.TeamWriter
	store.SnapshotReader
	created string
	writes  int
}
type unknownSnapshot struct{ store.SnapshotScope }
type unknownReader struct{ store.TeamReader }
type unknownWriter struct{ store.TeamWriteDAO }
type unknownTeamScope struct{}
type emptyTeamEligibility struct{ store.WebhookEligibilityDAO }

func (unknownTeamScope) TeamDAO() store.TeamWriteDAO                 { return unknownWriter{} }
func (unknownTeamScope) EligibilityDAO() store.WebhookEligibilityDAO { return emptyTeamEligibility{} }
func (emptyTeamEligibility) LockAffected(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	return nil, nil
}

type unknownCreator struct {
	store.TeamCreationDAO
	db *unknownTeamDB
}

func (d *unknownTeamDB) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	return f(unknownSnapshot{})
}
func (unknownSnapshot) TeamDAO() store.TeamReader { return unknownReader{} }
func testUnknownTeam() model.Team {
	name := "Original"
	return model.Team{TeamRef: model.TeamRef{ID: unknownTeam, Kind: "ordinary", Name: &name}, Version: 1, Membership: model.TeamMember{TeamID: unknownTeam, UserID: unknownActor, Role: model.ProjectAdmin, Version: 1}}
}
func (unknownReader) Team(context.Context, string, string) (model.Team, error) {
	return testUnknownTeam(), nil
}
func (unknownReader) TeamAccess(context.Context, string, string) error { return nil }
func (unknownReader) InvitationTeamMember(_ context.Context, _, user string) (model.TeamMember, error) {
	return model.TeamMember{TeamID: unknownTeam, UserID: user, Role: model.ProjectMemberRole, Version: 1}, nil
}
func (unknownWriter) Team(context.Context, string) (model.Team, error) {
	return testUnknownTeam(), nil
}
func (unknownWriter) Member(_ context.Context, user string) (model.TeamMember, error) {
	return model.TeamMember{TeamID: unknownTeam, UserID: user, Role: model.ProjectMemberRole, Version: 1}, nil
}
func (unknownWriter) AdminCount(context.Context) (int64, error) { return 2, nil }
func (unknownWriter) Rename(_ context.Context, _ string, name string) (model.Team, error) {
	team := testUnknownTeam()
	team.Name = &name
	return team, nil
}
func (unknownWriter) HasProjects(context.Context) (bool, error) { return false, nil }
func (unknownWriter) Delete(context.Context) error              { return nil }
func (unknownWriter) SetMemberRole(_ context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
	return model.TeamMember{TeamID: unknownTeam, UserID: user, Role: role, Version: 2}, nil
}
func (unknownWriter) RemoveMember(context.Context, string) error { return nil }
func (c unknownCreator) InsertTeam(_ context.Context, id, name string) (model.Team, error) {
	c.db.created = id
	return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1}, nil
}
func unknownCommit() error {
	return &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost commit")}
}
func (d *unknownTeamDB) CreateTeam(_ context.Context, _ string, f func(store.TeamCreationDAO) error) (store.Completion, error) {
	d.writes++
	if err := f(unknownCreator{db: d}); err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionUnknown}, unknownCommit()
}
func (d *unknownTeamDB) WriteTeam(_ context.Context, _ string, f func(store.TeamWriteScope) error) (store.Completion, error) {
	d.writes++
	if err := f(unknownTeamScope{}); err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionUnknown}, unknownCommit()
}

func TestTeamUnknownWritesRetainReferencesInMCPEnvelope(t *testing.T) {
	f := newEntryFixture(t)
	db := &unknownTeamDB{}
	teams := teamservice.NewTeams(db)
	f.entry.auth = validTeamAuth{}
	if err := RegisterTeamTools(f.entry, teams, projectservice.NewProjects(&failedTeamReadDB{}), identity.New(nil, nil, "")); err != nil {
		t.Fatal(err)
	}
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
			before := db.writes
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
				expected = db.created
				if expected == "" {
					t.Fatal("missing allocated Team ID")
				}
			}
			if len(envelope.Data) != 0 || envelope.Error.WriteOutcome != "unknown" || envelope.Error.Refs["teamId"] != expected || (tc.user != "" && envelope.Error.Refs["userId"] != tc.user) || db.writes != before+1 {
				t.Fatalf("unexpected unknown receipt %s writes=%d", raw, db.writes-before)
			}
		})
	}
}
