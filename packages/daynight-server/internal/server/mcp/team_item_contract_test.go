package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTeamItemInspectionPreservesEachFixedHeader(t *testing.T) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 123456000, time.FixedZone("source", 3600))
	secret := "variable content belongs in chunks"
	member := model.TeamMember{TeamID: unknownTeam, UserID: unknownTarget, Role: model.ProjectMemberRole, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}
	team := model.Team{TeamRef: model.TeamRef{ID: unknownTeam, Kind: "ordinary", Name: &secret}, Version: 9007199254740994, CreatedAt: now, UpdatedAt: now, Membership: member}
	project := model.Project{ID: testProjectID, Name: secret, RepoURL: secret, CreatedAt: now, UpdatedAt: now, Settings: model.ProjectSettings{Version: 9007199254740995, ExecutionWarningMinutes: 17}, Ownership: model.ProjectOwnership{TeamID: unknownTeam, Version: 9007199254740996, UpdatedAt: now}}
	for _, tc := range []struct {
		kind string
		meta teamitem.Metadata
	}{
		{"team", teamitem.Metadata{Team: &team, Revision: "time", Fields: []teamitem.Field{{Name: "name", SizeBytes: int64(len(secret))}}}},
		{"member", teamitem.Metadata{Member: &member, Revision: "time", Fields: []teamitem.Field{{Name: "profile.name", SizeBytes: int64(len(secret))}, {Name: "profile.email", IsNull: true}, {Name: "profile.avatarUrl"}}}},
		{"project", teamitem.Metadata{Project: &project, Revision: "time", Fields: []teamitem.Field{{Name: "name", SizeBytes: int64(len(secret))}, {Name: "repoUrl", SizeBytes: int64(len(secret))}}}},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			f := newEntryFixture(t)
			if err := RegisterTeamItemTool(f.entry, teamItemReaderFunc(func(context.Context, teamitem.Authority, teamitem.Input) (teamitem.Result, error) {
				return teamitem.Result{Metadata: tc.meta}, nil
			})); err != nil {
				t.Fatal(err)
			}
			args := map[string]any{"kind": tc.kind, "team": unknownTeam}
			if tc.kind == "member" {
				args["userId"] = unknownTarget
			}
			if tc.kind == "project" {
				args["projectId"] = testProjectID
			}
			result, err := f.client(t, "2026-07-28", "alice").CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: args})
			if err != nil || result.IsError {
				t.Fatalf("inspect: %+v %v", result, err)
			}
			env := mirroredEnvelope(t, result)
			header := object(t, object(t, env["data"])["header"])
			encoded, _ := json.Marshal(env)
			if strings.Contains(string(encoded), secret) || header["name"] != nil || header["repoUrl"] != nil || header["profile"] != nil || header["updatedAt"] != "2026-11-06T11:00:00.123456Z" {
				t.Fatalf("header inlined content or lost exact timestamp: %#v", header)
			}
			switch tc.kind {
			case "team":
				if header["version"] != "9007199254740994" || object(t, header["membership"])["version"] != "9007199254740993" || header["kind"] != "ordinary" {
					t.Fatalf("Team header: %#v", header)
				}
			case "member":
				if header["userId"] != unknownTarget || header["role"] != "member" || header["version"] != "9007199254740993" {
					t.Fatalf("member header: %#v", header)
				}
			case "project":
				if object(t, header["settings"])["version"] != "9007199254740995" || object(t, header["settings"])["executionWarningMinutes"] != float64(17) || object(t, header["ownership"])["version"] != "9007199254740996" {
					t.Fatalf("Project header: %#v", header)
				}
			}
		})
	}
}

func TestTeamItemReadRejectsMalformedProducerMetadata(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		mutate     func(*teamitem.Metadata)
	}{
		{"missing Team", "team", func(m *teamitem.Metadata) { m.Team = nil }},
		{"missing member", "member", func(m *teamitem.Metadata) { m.Member = nil }},
		{"missing Project", "project", func(m *teamitem.Metadata) { m.Project = nil }},
		{"missing revision", "member", func(m *teamitem.Metadata) { m.Revision = "" }},
		{"unbounded revision", "member", func(m *teamitem.Metadata) { m.Revision = strings.Repeat("r", 513) }},
		{"negative size", "member", func(m *teamitem.Metadata) { m.Fields[0].SizeBytes = -1 }},
		{"unencodable time", "member", func(m *teamitem.Metadata) { m.Member.UpdatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC) }},
		{"unbounded fixed header", "member", func(m *teamitem.Metadata) { m.Member.UserID = strings.Repeat("private", 1000) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			metadata := itemMemberMetadata("small")
			tc.mutate(&metadata)
			f := newEntryFixture(t)
			if err := RegisterTeamItemTool(f.entry, teamItemReaderFunc(func(context.Context, teamitem.Authority, teamitem.Input) (teamitem.Result, error) {
				return teamitem.Result{Metadata: metadata}, nil
			})); err != nil {
				t.Fatal(err)
			}
			args := map[string]any{"kind": tc.kind, "team": unknownTeam}
			if tc.kind == "member" {
				args["userId"] = unknownTarget
			}
			if tc.kind == "project" {
				args["projectId"] = testProjectID
			}
			result, err := f.client(t, "2026-07-28", "alice").CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: args})
			if err != nil || !result.IsError {
				t.Fatalf("malformed producer returned success: %+v %v", result, err)
			}
			env := mirroredEnvelope(t, result)
			if object(t, env["error"])["code"] != "internal_error" || env["data"] != nil || strings.Contains(result.Content[0].(*sdk.TextContent).Text, "private") {
				t.Fatalf("partial metadata escaped: %#v", env)
			}
		})
	}
}

func teamReadDefinition(t *testing.T, name string) *sdk.Tool {
	t.Helper()
	var definitions []*sdk.Tool
	if err := json.Unmarshal(teamToolsJSON, &definitions); err != nil {
		t.Fatal(err)
	}
	for _, definition := range definitions {
		if definition.Name == name {
			return definition
		}
	}
	t.Fatalf("missing tool %s", name)
	return nil
}

func TestTeamReadOutputFailuresRemainBoundedAndUnrecoverable(t *testing.T) {
	cases := []struct {
		name  string
		build func(RequestActor) (ToolResult, error)
	}{
		{"unsupported page value", func(actor RequestActor) (ToolResult, error) {
			_, result, err := fitTeamPage(actor, []any{make(chan int)}, nil, func(int) (string, error) { return "after", nil }, func(int, string) map[string]any { return nil })
			return result, err
		}},
		{"unencodable error references", func(RequestActor) (ToolResult, error) {
			return ToolResult{WriteOutcome: "unsupported", Refs: map[string]any{"private": make(chan int)}}, &model.Fault{Code: "invalid_input", Message: "rejected"}
		}},
		{"error references exceed budget", func(RequestActor) (ToolResult, error) {
			return ToolResult{Refs: map[string]any{"private": strings.Repeat("x", teamListBudget)}}, &model.Fault{Code: "invalid_input", Message: "rejected"}
		}},
		{"missing mandatory reference", func(RequestActor) (ToolResult, error) {
			return oversizedTeamItem(map[string]any{"teamId": unknownTeam})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newEntryFixture(t)
			if err := f.entry.registerReadTool(teamReadDefinition(t, "team_list"), func(json.RawMessage) BudgetClass { return BudgetLarge }, func(_ context.Context, actor RequestActor, _ json.RawMessage) (ToolResult, error) {
				return tc.build(actor)
			}); err != nil {
				t.Fatal(err)
			}
			result, err := f.client(t, "2026-07-28", "alice").CallTool(t.Context(), &sdk.CallToolParams{Name: "team_list", Arguments: map[string]any{}})
			if err != nil || !result.IsError {
				t.Fatalf("construction failure: %+v %v", result, err)
			}
			env := mirroredEnvelope(t, result)
			failure := object(t, env["error"])
			wire, _ := json.Marshal(result)
			if failure["code"] != "internal_error" || failure["refs"] != nil || failure["writeOutcome"] != nil || env["data"] != nil || len(wire) > teamListBudget || strings.Contains(result.Content[0].(*sdk.TextContent).Text, "private") {
				t.Fatalf("unsafe output failure: %#v", env)
			}
		})
	}
}

func TestTeamReadBoundaryRejectsInconsistentReferences(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missing selected Team", func(refs map[string]any) { delete(refs["readArguments"].(map[string]any), "team") }},
		{"invalid selected Team", func(refs map[string]any) { refs["readArguments"].(map[string]any)["team"] = "private name" }},
		{"mismatched selected Team", func(refs map[string]any) { refs["teamId"] = unknownTarget }},
		{"missing member", func(refs map[string]any) { delete(refs["readArguments"].(map[string]any), "userId") }},
		{"invalid member", func(refs map[string]any) { refs["readArguments"].(map[string]any)["userId"] = "private name" }},
		{"empty continuation", func(refs map[string]any) { refs["cursorAfterItem"] = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			refs := teamItemReadReference("member", unknownTeam, unknownTarget, "", "after")
			tc.mutate(refs)
			f := newEntryFixture(t)
			if err := f.entry.registerReadTool(teamReadDefinition(t, "team_member_list"), func(json.RawMessage) BudgetClass { return BudgetLarge }, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
				return oversizedTeamItem(refs)
			}); err != nil {
				t.Fatal(err)
			}
			result, err := f.client(t, "2026-07-28", "alice").CallTool(t.Context(), &sdk.CallToolParams{Name: "team_member_list", Arguments: map[string]any{"team": unknownTeam}})
			if err != nil || !result.IsError {
				t.Fatalf("bad reference: %+v %v", result, err)
			}
			failure := object(t, mirroredEnvelope(t, result)["error"])
			if failure["code"] != "internal_error" || failure["refs"] != nil {
				t.Fatalf("incomplete reference advertised as recoverable: %#v", failure)
			}
		})
	}
}

func TestTeamReadEncoderEnforcesWholeResultBoundaries(t *testing.T) {
	const body = `{"data":{"text":"x"},"meta":{"requestId":"request"}}`
	golden := fmt.Sprintf(`{"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"daynight","version":"1"}},"content":[{"type":"text","text":%q}],"structuredContent":%s,"resultType":"complete"}`, body, body)
	var complete sdk.CallToolResult
	if err := json.Unmarshal([]byte(golden), &complete); err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(&complete)
	if err != nil {
		t.Fatal(err)
	}
	policy := toolResultPolicy{name: "team_list", mirrorText: true, maxBytes: len(wire)}
	if _, err := policy.encodeJSON(json.RawMessage(body), false); err != nil {
		t.Fatalf("exact legal boundary rejected: %v", err)
	}
	policy.maxBytes--
	if _, err := policy.encodeJSON(json.RawMessage(body), false); err == nil {
		t.Fatal("one-byte oversized complete result accepted")
	}
	if _, err := policy.encodeJSON(json.RawMessage(`{`), false); err == nil {
		t.Fatal("malformed encoded producer result accepted")
	}
	legacy := toolResultPolicy{maxBytes: len(body)}
	if _, err := legacy.encodeJSON(json.RawMessage(body), false); err != nil {
		t.Fatal(err)
	}
	legacy.maxBytes--
	if _, err := legacy.encodeJSON(json.RawMessage(body), false); err == nil {
		t.Fatal("legacy envelope limit was lost")
	}
}

type itemBoundaryDB struct {
	store.TeamWriter
	store.ProjectWriter
	store.ProjectCreationWriter
	team    model.Team
	member  model.TeamMember
	project model.Project
}

func (d *itemBoundaryDB) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	return f(itemBoundaryScope{db: d})
}

type itemBoundaryScope struct {
	store.SnapshotScope
	db *itemBoundaryDB
}

func (s itemBoundaryScope) TeamDAO() store.TeamReader {
	return itemBoundaryTeamReader{unknownReader: unknownReader{}, db: s.db}
}
func (s itemBoundaryScope) ProjectDAO() store.ProjectReader {
	return itemBoundaryProjectReader{db: s.db}
}

type itemBoundaryTeamReader struct {
	unknownReader
	db *itemBoundaryDB
}

func (r itemBoundaryTeamReader) TeamsBounded(context.Context, string, store.Page, int) (store.TeamPage, error) {
	return store.TeamPage{Oversized: &r.db.team}, nil
}
func (r itemBoundaryTeamReader) TeamMembersPage(context.Context, string, store.Page) (store.TeamMemberPage, error) {
	return store.TeamMemberPage{Oversized: &r.db.member}, nil
}

type itemBoundaryProjectReader struct {
	store.ProjectReader
	db *itemBoundaryDB
}

func (r itemBoundaryProjectReader) ScopedProjects(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error) {
	return store.ProjectPage{Oversized: &r.db.project}, nil
}

func TestTeamListsExposeExactOversizedItemContinuation(t *testing.T) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 123456000, time.UTC)
	db := &itemBoundaryDB{team: testUnknownTeam(), member: model.TeamMember{TeamID: unknownTeam, UserID: unknownTarget, CreatedAt: now}, project: model.Project{ID: testProjectID, CreatedAt: now}}
	db.team.CreatedAt = now
	f := newEntryFixture(t)
	f.entry.auth = validTeamAuth{}
	if err := RegisterTeamTools(f.entry, teamservice.NewTeams(db), projectservice.NewProjects(db), identity.New(nil, nil, "")); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, tc := range []struct{ name, kind, id string }{{"team_list", "teams", unknownTeam}, {"team_member_list", "team_members", unknownTarget}, {"team_projects", "projects", testProjectID}} {
		t.Run(tc.name, func(t *testing.T) {
			args := map[string]any{}
			if tc.name != "team_list" {
				args["team"] = unknownTeam
			}
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: tc.name, Arguments: args})
			if err != nil || !result.IsError {
				t.Fatalf("boundary: %+v %v", result, err)
			}
			failure := object(t, mirroredEnvelope(t, result)["error"])
			refs := object(t, failure["refs"])
			if failure["code"] != "payload_too_large" || refs["readTool"] != "team_item_read" {
				t.Fatalf("boundary reference: %#v", failure)
			}
			cursor := refs["cursorAfterItem"].(string)
			request := model.PageRequest{Limit: 1, Cursor: &cursor}
			var page store.Page
			if tc.kind == "projects" {
				page, err = query.ProjectListPage(request, unknownActor, store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: unknownTeam})
			} else {
				scope := query.ListScope{Kind: tc.kind, UserID: unknownActor}
				if tc.kind == "team_members" {
					scope.TeamID = unknownTeam
				}
				page, err = query.ListPage(request, scope)
			}
			if err != nil || page.After == nil || page.After.ID != tc.id || !page.After.CreatedAt.Equal(now) {
				t.Fatalf("continuation skipped the wrong item: %+v %v", page, err)
			}
		})
	}
}
