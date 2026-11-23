//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func serverAPIOrdinarySubtaskNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	project := createProject(t, f, "Ordinary subtasks")
	parent := createTask(t, f, project, "Review", map[string]any{"status": "todo"})
	headers := http.Header{"Daynight-Task-Relations": {"task-parent-v1"}}
	child := requestJSON[api.Task](t, f, http.MethodPost, taskCollection(project.ID), map[string]any{
		"title": "Correction", "status": "todo", "parentTaskId": parent.ID,
	}, http.StatusCreated, headers)
	if child.ID == "" || child.ProjectID != project.ID || child.Title != "Correction" || child.ParentID != nil || child.ParentTaskID == nil || *child.ParentTaskID == nil || **child.ParentTaskID != parent.ID {
		t.Fatalf("created ordinary child differs: %+v", child)
	}
	legacy := requestJSON[map[string]any](t, f, http.MethodGet, taskPath(child), nil, http.StatusOK)
	if legacy["id"] != child.ID || legacy["parentId"] != nil {
		t.Fatalf("default child identity differs: %+v", legacy)
	}
	if _, present := legacy["parentTaskId"]; present {
		t.Fatalf("default child exposed extended relation: %+v", legacy)
	}
	page := requestJSON[api.TaskPage](t, f, http.MethodGet, taskCollection(project.ID)+"?parentTaskId="+parent.ID, nil, http.StatusOK, headers)
	if len(page.Items) != 1 || page.Items[0].ID != child.ID || page.Items[0].ParentTaskID == nil || *page.Items[0].ParentTaskID == nil || **page.Items[0].ParentTaskID != parent.ID {
		t.Fatalf("direct ordinary children differ: %+v", page)
	}
	child = setStatus(t, f, child, "done", nil)
	parent = setStatus(t, f, parent, "done", nil)
	for _, expected := range []api.Task{parent, child} {
		actual := requestJSON[api.Task](t, f, http.MethodGet, taskPath(expected), nil, http.StatusOK, headers)
		assertTaskContent(t, actual, expected)
		if expected.ID == child.ID && (actual.ParentTaskID == nil || *actual.ParentTaskID == nil || **actual.ParentTaskID != parent.ID) {
			t.Fatalf("completion lost ordinary relation: %+v", actual)
		}
	}

	client := sdk.NewClient(&sdk.Implementation{Name: "daynight-subtask-integration", Version: "1"}, nil)
	session, err := client.Connect(f.context, &sdk.StreamableClientTransport{Endpoint: f.origin + "/mcp", HTTPClient: f.client, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	call := func(name string, args map[string]any) taskprotocol.MCPFull {
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
			Data taskprotocol.MCPFull `json:"data"`
		}
		if err := json.Unmarshal(encoded, &envelope); err != nil {
			t.Fatalf("%s response: %s (%v)", name, encoded, err)
		}
		return envelope.Data
	}
	root := createTask(t, f, project, "Cancel review", map[string]any{"status": "todo"})
	mcpChild := call("task_create", map[string]any{"projectId": project.ID, "title": "Cancel correction", "status": "todo", "parentTaskId": root.ID, "returnView": "full", "taskParentView": "v1"})
	if mcpChild.ID == "" || mcpChild.ProjectID != project.ID || mcpChild.Title != "Cancel correction" || mcpChild.ParentID != nil || mcpChild.ParentTaskID == nil || *mcpChild.ParentTaskID == nil || **mcpChild.ParentTaskID != root.ID {
		t.Fatalf("MCP child differs: %+v", mcpChild)
	}
	before := requestJSON[api.Task](t, f, http.MethodGet, taskCollection(project.ID)+"/"+mcpChild.ID, nil, http.StatusOK, headers)
	if before.Version < 1 || strconv.FormatInt(before.Version, 10) != mcpChild.Version || before.Status != "todo" || before.Title != mcpChild.Title {
		t.Fatalf("MCP creation REST readback differs: MCP=%+v REST=%+v", mcpChild, before)
	}
	cancelled := call("task_set_status", map[string]any{"projectId": project.ID, "taskId": root.ID, "ifVersion": strconv.FormatInt(root.Version, 10), "status": "cancelled", "cancelDescendants": true, "returnView": "full", "taskParentView": "v1"})
	if cancelled.ID != root.ID || cancelled.Status != "cancelled" || cancelled.Version != strconv.FormatInt(root.Version+1, 10) {
		t.Fatalf("MCP confirmation receipt differs: %+v", cancelled)
	}
	for _, prior := range []api.Task{root, before} {
		actual := requestJSON[api.Task](t, f, http.MethodGet, taskPath(prior), nil, http.StatusOK, headers)
		if actual.ID != prior.ID || actual.ProjectID != prior.ProjectID || actual.Title != prior.Title || actual.Status != "cancelled" || actual.Version != prior.Version+1 || actual.CancelledAt == nil {
			t.Fatalf("confirmed cancellation readback differs: before=%+v after=%+v", prior, actual)
		}
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
}
