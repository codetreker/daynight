package mcp

import (
	"context"
	"encoding/hex"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestInvitationInspectionOmitsMissingAccess(t *testing.T) {
	if optionalGrant(nil) != nil || optionalAccess(nil) != nil {
		t.Fatal("an absent grant or access must remain absent in an inspection")
	}
}

func TestPublicTaskQueryRegistrationPublishesQueryTools(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterTaskQueryTools(f.entry, nil); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	listed, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make(map[string]bool)
	for _, tool := range listed.Tools {
		got[tool.Name] = true
	}
	want := map[string]bool{"task_list": true, "task_ready": true, "task_graph": true, "test_only": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("query tools = %#v; want %#v", got, want)
	}
}

func TestStepAddAllocatesCanonicalIDAndForwardsOptionalFields(t *testing.T) {
	ops := stepWriteFixture()
	writer := stepWriter{steps: ops}
	status := model.TaskStepDone
	result, err := writer.add(t.Context(), projectActor(), stepAddInput{
		stepWriteBase: stepWriteBase{ProjectID: testProjectID, TaskID: testTargetID},
		Title:         "Generated", Description: ptr("Details"), Status: &status, After: ptr("12345678"),
	})
	if err != nil || result.WriteOutcome != "confirmed" {
		t.Fatalf("add = %+v, %v", result, err)
	}
	id, err := hex.DecodeString(ops.addInput.ID)
	if err != nil || len(id) != 4 || ops.addInput.Title != "Generated" || ops.addInput.Description != "Details" || ops.addInput.Status == nil || *ops.addInput.Status != status || ops.addInput.After == nil || *ops.addInput.After != "12345678" || ops.addInput.Version != ops.page.Header.Version || ops.reads != 1 || ops.writes != 1 {
		t.Fatalf("incorrect generated-ID request: %+v, decode = %v", ops.addInput, err)
	}
	if result.Refs["stepId"] != ops.addInput.ID {
		t.Fatalf("generated ID missing from receipt: %+v", result)
	}
}

type confirmedTeamDB struct{ unknownTeamDB }

type confirmedTeamSnapshot struct{ unknownSnapshot }

type confirmedTeamReader struct{ unknownReader }

func (d *confirmedTeamDB) CreateTeam(_ context.Context, _ string, operation func(store.TeamCreationDAO) error) (store.Completion, error) {
	d.writes++
	if err := operation(unknownCreator{db: &d.unknownTeamDB}); err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func (d *confirmedTeamDB) WriteTeam(_ context.Context, _ string, operation func(store.TeamWriteDAO) error) (store.Completion, error) {
	d.writes++
	if err := operation(unknownWriter{}); err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func (*confirmedTeamDB) ReadSnapshot(_ context.Context, operation func(store.SnapshotScope) error) error {
	return operation(confirmedTeamSnapshot{})
}

func (confirmedTeamSnapshot) TeamDAO() store.TeamReader { return confirmedTeamReader{} }

func (confirmedTeamReader) TeamMembersPage(context.Context, string, store.Page) (store.TeamMemberPage, error) {
	name := "Member"
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.FixedZone("local", 7200))
	return store.TeamMemberPage{Items: []model.TeamMemberProfile{{Membership: model.TeamMember{TeamID: unknownTeam, UserID: unknownTarget, Role: model.ProjectMemberRole, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}, Profile: model.ProjectParticipantProfile{Name: &name}}}}, nil
}

func TestTeamToolsReturnConfirmedReceiptsAndMemberProfiles(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	database := &confirmedTeamDB{}
	if err := RegisterTeamTools(f.entry, teamservice.NewTeams(database), projectservice.NewProjects(&failedTeamReadDB{}), identity.New(nil, nil, "")); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	cases := []struct {
		name    string
		args    map[string]any
		outcome string
	}{
		{"team_create", map[string]any{"name": "Created", "confirm": true}, "changed"},
		{"team_rename", map[string]any{"team": unknownTeam, "name": "Changed", "confirm": true}, "changed"},
		{"team_rename", map[string]any{"team": unknownTeam, "name": "Original", "confirm": true}, "unchanged"},
		{"team_delete", map[string]any{"team": unknownTeam, "expectedName": "Original", "confirm": true}, "changed"},
		{"team_leave", map[string]any{"team": unknownTeam, "confirm": true}, "changed"},
		{"team_member_set_role", map[string]any{"team": unknownTeam, "userId": unknownTarget, "role": "admin", "confirm": true}, "changed"},
		{"team_member_set_role", map[string]any{"team": unknownTeam, "userId": unknownTarget, "role": "member", "confirm": true}, "unchanged"},
		{"team_member_remove", map[string]any{"team": unknownTeam, "userId": unknownTarget, "confirm": true}, "changed"},
	}
	for _, tc := range cases {
		t.Run(tc.name+"/"+tc.outcome, func(t *testing.T) {
			before := database.writes
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: tc.name, Arguments: tc.args})
			if err != nil || result.IsError {
				t.Fatalf("%s: %+v, %v", tc.name, result, err)
			}
			env := structured(t, result)
			meta := object(t, env["meta"])
			if meta["outcome"] != tc.outcome || database.writes != before+1 {
				t.Fatalf("incorrect receipt: %#v; writes = %d", env, database.writes-before)
			}
			data := object(t, env["data"])
			switch tc.name {
			case "team_create":
				if data["id"] != database.created || data["name"] != "Created" {
					t.Fatalf("created team: %#v", data)
				}
			case "team_rename":
				if data["id"] != unknownTeam || data["name"] != tc.args["name"] {
					t.Fatalf("renamed team: %#v", data)
				}
			case "team_delete":
				if data["teamId"] != unknownTeam || data["deleted"] != true {
					t.Fatalf("deleted team: %#v", data)
				}
			case "team_member_set_role":
				member := object(t, data["membership"])
				if member["userId"] != unknownTarget || member["role"] != tc.args["role"] || data["actorRole"] != "admin" {
					t.Fatalf("membership: %#v", data)
				}
			default:
				target := unknownTarget
				if tc.name == "team_leave" {
					target = unknownActor
				}
				if data["teamId"] != unknownTeam || data["userId"] != target || data["removed"] != true {
					t.Fatalf("removed membership: %#v", data)
				}
			}
		})
	}
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_member_list", Arguments: map[string]any{"team": unknownTeam}})
	if err != nil || result.IsError {
		t.Fatalf("members: %+v, %v", result, err)
	}
	data := object(t, structured(t, result)["data"])
	items := data["items"].([]any)
	if len(items) != 1 || data["nextCursor"] != nil {
		t.Fatalf("members page: %#v", data)
	}
	member := object(t, items[0])
	if member["teamId"] != unknownTeam || member["userId"] != unknownTarget || member["version"] != "9007199254740993" || member["createdAt"] != "2026-08-01T10:00:00Z" || object(t, member["profile"])["name"] != "Member" {
		t.Fatalf("member profile mapping: %#v", member)
	}
}
