package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type queryObservationPortMock struct {
	t         *testing.T
	mu        sync.Mutex
	operation string
	calls     int
	request   taskcore.MCPListRequest
	page      taskservice.ObservedMCPPage
	graph     taskservice.ObservedGraph
	err       error
}

func newQueryObservationPortMock(t *testing.T, operation string) *queryObservationPortMock {
	t.Helper()
	m := &queryObservationPortMock{t: t, operation: operation}
	t.Cleanup(func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.calls != 1 {
			t.Errorf("%s calls = %d, want 1", m.operation, m.calls)
		}
	})
	return m
}

func (m *queryObservationPortMock) called(ctx context.Context, operation string, principal model.Principal, project string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if operation != m.operation || m.calls != 0 {
		m.t.Errorf("unconfigured or extra %s call (expected %s, calls %d)", operation, m.operation, m.calls)
		return false
	}
	m.calls++
	want := model.Principal{Kind: model.PATCredential, UserID: "alice", CredentialID: "credential-alice"}
	if ctx == nil || ctx.Err() != nil || httpx.RequestID(ctx) != "test-request" {
		m.t.Errorf("%s context: %v", operation, ctx)
	}
	if principal != want || project != testProjectID {
		m.t.Errorf("%s actor/project = %+v / %q, want %+v / %q", operation, principal, project, want, testProjectID)
	}
	return true
}

func (m *queryObservationPortMock) ObservedMCPList(ctx context.Context, p model.Principal, project string, request taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	if !m.called(ctx, "list", p, project) {
		return taskservice.ObservedMCPPage{}, errors.New("unexpected list")
	}
	if !reflect.DeepEqual(request, m.request) {
		m.t.Errorf("list request = %+v, want %+v", request, m.request)
	}
	return m.page, m.err
}
func (m *queryObservationPortMock) ObserveGraph(ctx context.Context, p model.Principal, project, id string) (taskservice.ObservedGraph, error) {
	if !m.called(ctx, "graph", p, project) {
		return taskservice.ObservedGraph{}, errors.New("unexpected graph")
	}
	if id != testTargetID {
		m.t.Errorf("graph task = %q, want %q", id, testTargetID)
	}
	return m.graph, m.err
}

func TestTaskQueryObservationPortThroughMCP(t *testing.T) {
	stamp := time.Date(2026, 11, 10, 1, 2, 3, 0, time.UTC)
	status, assigned, ready, allow, platform, cursor := model.TaskInProgress, "me", true, false, model.PlatformLinux, "input-cursor"
	next := "supplied-next-cursor"
	assignee := testUserID
	graphStamp := stamp.Add(time.Hour)
	request := taskcore.MCPListRequest{All: false, Status: &status, AssignedTo: &assigned, Ready: &ready, AllowAgents: &allow, CompatiblePlatform: &platform, Limit: 7, Cursor: &cursor, View: "summary"}
	args := map[string]any{"projectId": testProjectID, "all": false, "status": "in_progress", "assignedTo": "me", "ready": true, "allowAgents": false, "compatiblePlatform": "linux", "limit": 7, "cursor": "input-cursor", "view": "summary"}
	task := model.Task{ID: testTargetID, ProjectID: testProjectID, Title: "Supplied title", Description: "supplied description", Status: model.TaskInProgress, Version: 42, CreatedAt: stamp, UpdatedAt: stamp, DependsOn: []string{"dependency"}, ExternalDependsOn: []string{"external"}, BlockedBy: []string{"blocker"}, RequiredPlatform: &platform, AssignedTo: &assignee, AllowAgents: true, Ready: false, StartedAt: &stamp, Properties: model.TaskProperties{"sample": json.RawMessage(`{"value":7}`)}}
	observation := observationFixture()
	page := taskservice.ObservedMCPPage{Items: []taskservice.ObservedMCPItem{{Item: store.TaskPriorityItem{Task: task, BlockedByCount: 9, TitleTruncated: true}, Session: observation}}, NextCursor: &next, ObservedAt: stamp, Partial: true}
	indicator := "warning"
	graph := taskservice.ObservedGraph{Graph: model.TaskGraph{Project: model.Project{ID: testProjectID, Name: "Supplied project", CreatedAt: stamp, UpdatedAt: stamp}, ObservedAt: graphStamp, Summary: model.TaskGraphSummary{Total: 7, InProgress: 3}, Tasks: []model.GraphTask{{ID: testTargetID, TitlePreview: "Supplied node", TitleTruncated: true, Status: model.TaskInProgress, DependsOn: []string{"dependency"}, ExternalDependsOn: []string{"external"}, BlockedBy: []string{"blocker"}, RequiredPlatform: &platform, AssignedTo: &assignee, AllowAgents: true, Ready: false, CreatedAt: stamp, UpdatedAt: stamp}}}, Sessions: map[string]sp.TaskSessionObservation{testTargetID: observation}, Relations: map[string]string{testTargetID: "member"}, Aggregation: taskwork.Aggregation{Indicator: &indicator, WorkingCount: 2, WarningCount: 3, UnknownCount: 4, Complete: false, ObservedAt: stamp}, ObservedAt: stamp, Partial: true}
	sentinel := errors.New("private sentinel failure")
	refusal := &model.Fault{Code: "forbidden", Message: "Observation denied."}
	for _, operation := range []string{"list", "list-full", "list-all", "graph"} {
		for _, tc := range []struct {
			name          string
			err           error
			code, message string
		}{{"success", nil, "", ""}, {"refusal", refusal, "forbidden", "Observation denied."}, {"sentinel", sentinel, "internal_error", ""}} {
			t.Run(operation+"/"+tc.name, func(t *testing.T) {
				mockOperation := operation
				if operation == "list-full" || operation == "list-all" {
					mockOperation = "list"
				}
				mock := newQueryObservationPortMock(t, mockOperation)
				mock.request, mock.page, mock.graph, mock.err = request, page, graph, tc.err
				if operation == "list-full" {
					mock.request.View = "full"
				}
				if operation == "list-all" {
					mock.request.All = true
					mock.request.Status = nil
				}
				f := newEntryFixture(t)
				if err := RegisterTaskQueryTools(f.entry, nil, mock); err != nil {
					t.Fatal(err)
				}
				client := f.client(t, "2026-07-28", "alice")
				catalog, err := client.ListTools(t.Context(), nil)
				if err != nil {
					t.Fatal(err)
				}
				counts := map[string]int{}
				for _, tool := range catalog.Tools {
					counts[tool.Name]++
				}
				for _, name := range []string{"task_list", "task_ready", "task_graph"} {
					if counts[name] != 1 {
						t.Errorf("%s discovery count = %d", name, counts[name])
					}
				}
				name, input := "task_list", args
				if operation == "list-full" || operation == "list-all" {
					input = make(map[string]any, len(args))
					for k, v := range args {
						input[k] = v
					}
					if operation == "list-full" {
						input["view"] = "full"
					} else {
						input["all"] = true
						delete(input, "status")
					}
				}
				if operation == "graph" {
					name, input = "task_graph", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "view": "full"}
				}
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: input})
				if err != nil {
					t.Fatal(err)
				}
				env := structured(t, result)
				if tc.err != nil {
					if !result.IsError {
						t.Fatalf("expected read error: %#v", env)
					}
					failure := object(t, env["error"])
					if failure["code"] != tc.code || (tc.message != "" && failure["message"] != tc.message) || failure["requestId"] != "test-request" || failure["writeOutcome"] != nil || failure["phase"] != nil || env["data"] != nil || env["meta"] != nil {
						t.Fatalf("read failure = %#v", env)
					}
					return
				}
				if result.IsError {
					t.Fatalf("read error: %#v", env)
				}
				meta := object(t, env["meta"])
				if meta["requestId"] != "test-request" || meta["observedAt"] != "2026-11-10T01:02:03Z" || meta["partial"] != true || meta["writeOutcome"] != nil || meta["phase"] != nil {
					t.Fatalf("read metadata = %#v", meta)
				}
				refs := object(t, meta["refs"])
				if refs["projectId"] != testProjectID || (operation == "graph" && refs["taskId"] != testTargetID) {
					t.Fatalf("read refs = %#v", refs)
				}
				data := object(t, env["data"])
				items := data["items"]
				if operation == "graph" {
					items = data["tasks"]
				}
				values, ok := items.([]any)
				if !ok || len(values) != 1 {
					t.Fatalf("items = %#v", items)
				}
				item := object(t, values[0])
				session := object(t, item["session"])
				send := object(t, session["send"])
				var expectedSession map[string]any
				encodedSession, err := json.Marshal(observation)
				if err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(encodedSession, &expectedSession); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(session, expectedSession) {
					t.Fatalf("session = %#v, want %#v", session, expectedSession)
				}
				if item["id"] != testTargetID || session["observation"] != "observed" || session["reason"] != "idle" || session["sessionId"] != *observation.SessionID || send["allowed"] != true || send["mode"] != "start" || send["reason"] != "allowed" {
					t.Fatalf("observation = %#v", item)
				}
				if operation == "list" || operation == "list-all" {
					if data["projection"] != "summary" || data["nextCursor"] != next || item["projectId"] != testProjectID || item["titlePreview"] != "Supplied title" || item["titleTruncated"] != true || item["status"] != "in_progress" || item["version"] != "42" || item["ready"] != false || item["blockedByCount"] != float64(9) || item["requiredPlatform"] != "linux" || item["assignedTo"] != testUserID || item["allowAgents"] != true {
						t.Fatalf("list data = %#v", data)
					}
				} else if operation == "list-full" {
					if data["projection"] != "full" || data["nextCursor"] != next || item["projectId"] != testProjectID || item["title"] != "Supplied title" || item["description"] != nil || item["status"] != "in_progress" || item["version"] != "42" || item["createdAt"] != "2026-11-10T01:02:03Z" || item["updatedAt"] != "2026-11-10T01:02:03Z" || item["startedAt"] != "2026-11-10T01:02:03Z" || item["completedAt"] != nil || item["cancelledAt"] != nil || object(t, object(t, item["properties"])["sample"])["value"] != float64(7) || !reflect.DeepEqual(item["dependsOn"], []any{"dependency"}) || !reflect.DeepEqual(item["externalDependsOn"], []any{"external"}) || !reflect.DeepEqual(item["blockedBy"], []any{"blocker"}) || item["requiredPlatform"] != "linux" || item["assignedTo"] != testUserID || item["allowAgents"] != true || item["ready"] != false {
						t.Fatalf("full list data = %#v", data)
					}
				} else {
					summary := object(t, data["sessionSummary"])
					if data["projection"] != "full" || data["observedAt"] != "2026-11-10T02:02:03Z" || data["partial"] != true || data["returnedNodes"] != float64(1) || data["totalNodes"] != float64(1) || object(t, data["project"])["name"] != "Supplied project" || object(t, data["summary"])["total"] != float64(7) || item["titlePreview"] != "Supplied node" || item["titleTruncated"] != true || item["relation"] != "member" || !reflect.DeepEqual(item["dependsOn"], []any{"dependency"}) || !reflect.DeepEqual(item["externalDependsOn"], []any{"external"}) || !reflect.DeepEqual(item["blockedBy"], []any{"blocker"}) || summary["indicator"] != "warning" || summary["workingCount"] != float64(2) || summary["warningCount"] != float64(3) || summary["unknownCount"] != float64(4) || summary["complete"] != false || summary["observedAt"] != "2026-11-10T01:02:03Z" {
						t.Fatalf("graph data = %#v", data)
					}
				}
			})
		}
	}
}
