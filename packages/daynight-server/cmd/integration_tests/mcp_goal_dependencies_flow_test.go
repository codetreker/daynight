//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/goaldependencies"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Exercise the published tools over the real Server, sharing persisted data
// with REST and following a successor cursor across Project boundaries.
func serverAPIMCPGoalDependenciesNormalFlow(t *testing.T, f *fixture, project api.Project, upstream, downstream api.Task, revision string) {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "daynight-goal-dependencies-integration", Version: "1"}, nil)
	session, err := client.Connect(f.context, &sdk.StreamableClientTransport{Endpoint: f.origin + "/mcp", HTTPClient: f.client, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	listed, err := session.ListTools(f.context, nil)
	if err != nil || listed == nil {
		t.Fatalf("list tools: %+v %v", listed, err)
	}
	wanted := map[string][]string{
		"goal_dependencies_show": {"projectId", "goalId", "limit", "cursor"},
		"goal_dependencies_edit": {"projectId", "goalId", "ifRevision", "mode", "add", "remove", "prerequisites"},
	}
	for _, tool := range listed.Tools {
		fields, ok := wanted[tool.Name]
		if !ok {
			continue
		}
		encoded, err := json.Marshal(tool.InputSchema)
		var schema struct {
			Type       string                     `json:"type"`
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		}
		if err != nil || json.Unmarshal(encoded, &schema) != nil || schema.Type != "object" {
			t.Fatalf("invalid %s schema: %s (%v)", tool.Name, encoded, err)
		}
		for _, field := range fields {
			if _, present := schema.Properties[field]; !present {
				t.Fatalf("%s omits %s: %s", tool.Name, field, encoded)
			}
		}
		required := map[string]bool{}
		for _, field := range schema.Required {
			required[field] = true
		}
		if !required["projectId"] || !required["goalId"] || tool.Name == "goal_dependencies_edit" && (!required["ifRevision"] || !required["mode"]) {
			t.Fatalf("%s missing required identity or edit fields: %s", tool.Name, encoded)
		}
		delete(wanted, tool.Name)
	}
	if len(wanted) != 0 {
		t.Fatalf("missing Goal dependency tools: %v", wanted)
	}

	call := func(name string, args map[string]any, out any) {
		t.Helper()
		result, err := session.CallTool(f.context, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result == nil || result.IsError {
			t.Fatalf("%s: result=%+v error=%v", name, result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(encoded, &envelope); err != nil || len(envelope.Data) == 0 {
			t.Fatalf("%s envelope: %s (%v)", name, encoded, err)
		}
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			t.Fatalf("%s data: %s (%v)", name, envelope.Data, err)
		}
	}
	show := func(projectID, goalID string, limit int, cursor *string) protocol.Relationships {
		t.Helper()
		args := map[string]any{"projectId": projectID, "goalId": goalID, "limit": limit}
		if cursor != nil {
			args["cursor"] = *cursor
		}
		var page protocol.Relationships
		call("goal_dependencies_show", args, &page)
		return page
	}
	edit := func(projectID, goalID, expected string, prerequisite api.Task) protocol.Receipt {
		t.Helper()
		var receipt protocol.Receipt
		call("goal_dependencies_edit", map[string]any{"projectId": projectID, "goalId": goalID, "ifRevision": expected, "mode": "edit", "add": []map[string]string{{"projectId": prerequisite.ProjectID, "goalId": prerequisite.ID}}}, &receipt)
		return receipt
	}
	initial := show(project.ID, downstream.ID, 20, nil)
	if initial.Revision == nil || *initial.Revision != revision || len(initial.Prerequisites) != 0 {
		t.Fatalf("initial MCP relationships: %+v", initial)
	}
	added := edit(project.ID, downstream.ID, *initial.Revision, upstream)
	if !added.Changed || added.Revision != "4" || added.GoalID != downstream.ID {
		t.Fatalf("MCP edit receipt: %+v", added)
	}
	read := requestJSON[protocol.Relationships](t, f, http.MethodGet, taskPath(downstream)+"/goal-dependencies", nil, http.StatusOK)
	if read.Revision == nil || *read.Revision != added.Revision || len(read.Prerequisites) != 1 || read.Prerequisites[0].EdgeID == nil || read.Prerequisites[0].Target == nil || read.Prerequisites[0].Target.GoalID != upstream.ID {
		t.Fatalf("REST readback of MCP edit: %+v", read)
	}
	var retained protocol.Receipt
	call("goal_dependencies_edit", map[string]any{"projectId": project.ID, "goalId": downstream.ID, "ifRevision": added.Revision, "mode": "replace", "prerequisites": []map[string]string{{"edgeId": *read.Prerequisites[0].EdgeID}}}, &retained)
	if retained.Changed || retained.Revision != added.Revision {
		t.Fatalf("retained edge receipt: %+v", retained)
	}
	otherProject := createProject(t, f, "MCP Goal relationships second Project")
	other := createTask(t, f, otherProject, "Second successor", map[string]any{"type": "goal"})
	otherAdded := edit(otherProject.ID, other.ID, "1", upstream)
	if !otherAdded.Changed || otherAdded.Revision != "2" {
		t.Fatalf("cross-Project edit: %+v", otherAdded)
	}
	seen := map[string]bool{}
	var cursor *string
	for pageNumber := 0; pageNumber < 2; pageNumber++ {
		page := show(project.ID, upstream.ID, 1, cursor)
		if len(page.Successors) != 1 || seen[page.Successors[0].GoalID] {
			t.Fatalf("successor page: %+v", page)
		}
		seen[page.Successors[0].GoalID] = true
		cursor = page.NextCursor
		if (pageNumber == 0) != (cursor != nil) {
			t.Fatalf("successor cursor on page %d: %+v", pageNumber, page)
		}
	}
	if !seen[downstream.ID] || !seen[other.ID] {
		t.Fatalf("successor identities: %v", seen)
	}
}
