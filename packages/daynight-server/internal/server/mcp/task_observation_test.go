package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type observedQueryMock struct {
	queryStub
	t                     *testing.T
	listCalls, graphCalls int
	page                  taskservice.ObservedMCPPage
	observedGraph         taskservice.ObservedGraph
}

func (m *observedQueryMock) ObservedMCPList(_ context.Context, p model.Principal, project string, req taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	m.listCalls++
	if p.UserID != "actor" || project != testProjectID || req.View != "summary" || req.Limit != 50 {
		m.t.Errorf("observation request changed: %v %s %+v", p, project, req)
	}
	return m.page, nil
}
func (m *observedQueryMock) ObserveGraph(_ context.Context, p model.Principal, project, id string) (taskservice.ObservedGraph, error) {
	m.graphCalls++
	if p.UserID != "actor" || project != testProjectID || id != testTargetID {
		m.t.Errorf("graph observation changed identity: %v %s %s", p, project, id)
	}
	return m.observedGraph, nil
}
func observationFixture() sp.TaskSessionObservation {
	stamp := time.Date(2026, 11, 10, 1, 2, 3, 0, time.UTC)
	allowed := true
	indicator, mode, id := "warning", "start", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	return sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "registered", SessionID: &id, Indicator: &indicator, Reason: "idle", Send: sp.TaskSessionSend{Allowed: &allowed, Mode: &mode, Reason: "allowed"}, ObservedAt: &stamp}
}
func TestTaskReadAdaptersUseSharedObservationAndKeepDependencyReadsPlain(t *testing.T) {
	stamp := time.Date(2026, 11, 10, 1, 2, 3, 0, time.UTC)
	observation := observationFixture()
	node := model.GraphTask{ID: testTargetID, Status: model.TaskInProgress}
	mock := &observedQueryMock{t: t, page: taskservice.ObservedMCPPage{Items: []taskservice.ObservedMCPItem{{Item: store.TaskPriorityItem{Task: taskFixtureTask()}, Session: observation}}, ObservedAt: stamp, Partial: true}, observedGraph: taskservice.ObservedGraph{Graph: model.TaskGraph{Tasks: []model.GraphTask{node}}, Sessions: map[string]sp.TaskSessionObservation{testTargetID: observation}, Relations: map[string]string{testTargetID: "member"}, ObservedAt: stamp, Partial: true}}
	mock.graph = model.TaskGraph{Tasks: []model.GraphTask{node}}
	mock.err = errors.New("plain list must not be invoked")
	actor := RequestActor{Principal: model.Principal{UserID: "actor"}, RequestID: "r"}
	result, err := listTool(t.Context(), actor, listInput{ProjectID: testProjectID}, mock)
	if err != nil {
		t.Fatal(err)
	}
	if mock.listCalls != 1 || result.Observation == nil || !result.Observation.Partial || result.Observation.ObservedAt != stamp {
		t.Fatalf("observation was lost: %+v", result)
	}
	var item map[string]any
	if err := json.Unmarshal(result.Data.(listData).Items[0], &item); err != nil {
		t.Fatal(err)
	}
	if object(t, item["session"])["reason"] != "idle" || object(t, object(t, item["session"])["send"])["allowed"] != true {
		t.Fatalf("status/send were recomputed or missing: %#v", item)
	}
	result, err = graphTool(t.Context(), actor, graphInput{ProjectID: testProjectID, TaskID: testTargetID}, mock)
	if err != nil || mock.graphCalls != 1 || result.Observation == nil {
		t.Fatalf("graph: %+v %v", result, err)
	}
	data, _ := json.Marshal(result.Data)
	var graph map[string]any
	_ = json.Unmarshal(data, &graph)
	got := object(t, graph["tasks"].([]any)[0])
	if got["relation"] != "member" || object(t, got["session"])["reason"] != "idle" {
		t.Fatalf("graph observation absent: %#v", got)
	}
	result, err = graphTool(t.Context(), actor, graphInput{ProjectID: testProjectID, TaskID: testTargetID, DependsOnly: true}, mock)
	if err != nil || mock.graphCalls != 1 || result.Observation != nil {
		t.Fatalf("dependsOnly performed observation: %+v %v", result, err)
	}
	data, _ = json.Marshal(result.Data.(graphData).Tasks[0])
	var dependency map[string]any
	_ = json.Unmarshal(data, &dependency)
	if len(dependency) != 3 {
		t.Fatalf("dependsOnly changed fields: %s", data)
	}
}

func observedGraphFixture(graph model.TaskGraph) taskservice.ObservedGraph {
	value := taskservice.ObservedGraph{Graph: graph, Sessions: map[string]sp.TaskSessionObservation{}, Relations: map[string]string{}, ObservedAt: time.Now().UTC()}
	value.Aggregation.ObservedAt = value.ObservedAt
	value.Aggregation.Complete = true
	for _, node := range graph.Tasks {
		value.Sessions[node.ID] = observationFixture()
		value.Relations[node.ID] = "member"
	}
	return value
}

func TestTaskObservationActualProtocolResults(t *testing.T) {
	f := newEntryFixture(t)
	task := taskFixtureTask()
	project := model.Project{ID: testProjectID}
	project.Ownership.TeamID = testUserID
	graph := model.TaskGraph{Project: project, ObservedAt: task.CreatedAt, Tasks: []model.GraphTask{{ID: task.ID, Type: task.Type, TitlePreview: task.Title, Status: task.Status, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}}}
	stub := &queryStub{items: []store.TaskPriorityItem{{Task: task}}, graph: graph}
	observationJSON, err := json.Marshal(observationFixture())
	if err != nil {
		t.Fatal(err)
	}
	var observation map[string]any
	if err := json.Unmarshal(observationJSON, &observation); err != nil {
		t.Fatal(err)
	}
	expectedTask := func(view string, list bool) map[string]any {
		m := map[string]any{"projection": view, "id": testTargetID, "projectId": testProjectID, "type": "task", "parentId": nil, "status": "todo", "version": "1", "ready": true, "requiredPlatform": nil, "assignedTo": testUserID, "allowAgents": false, "tags": []any{}, "session": observation}
		if view == "summary" {
			m["titlePreview"] = "Test task"
			m["titleTruncated"] = false
			m["blockedByCount"] = float64(0)
		} else {
			m["title"] = "Test task"
			if !list {
				m["description"] = ""
			}
			m["properties"] = map[string]any{}
			m["createdAt"] = "2026-11-01T02:03:04.567Z"
			m["updatedAt"] = "2026-11-01T02:03:04.567Z"
			m["startedAt"] = nil
			m["completedAt"] = nil
			m["cancelledAt"] = nil
			m["dependsOn"] = []any{}
			m["externalDependsOn"] = []any{}
			m["blockedBy"] = []any{}
		}
		return m
	}
	if err := registerTaskQueryTools(f.entry, stub); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	assertNoDiscoveredOutputSchemas(t, client, "task_list", "task_graph")
	for _, name := range []string{"task_list", "task_graph"} {
		for _, view := range []string{"summary", "full"} {
			args := map[string]any{"projectId": testProjectID, "view": view}
			if name == "task_graph" {
				args["taskId"] = task.ID
			}
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
			if err != nil || result.IsError {
				t.Fatalf("%s: %+v %v", name, result, err)
			}
			env := structured(t, result)
			data := object(t, env["data"])
			meta := object(t, env["meta"])
			if meta["requestId"] != "test-request" || meta["partial"] != false || object(t, meta["refs"])["projectId"] != testProjectID {
				t.Fatalf("%s metadata: %#v", name, meta)
			}
			if _, ok := meta["observedAt"].(string); !ok {
				t.Fatalf("%s observation timestamp: %#v", name, meta)
			}
			if name == "task_list" {
				items, ok := data["items"].([]any)
				if !ok || len(items) != 1 || data["projection"] != view || data["nextCursor"] != nil || len(data) != 3 {
					t.Fatalf("list page: %#v", data)
				}
				if _, ok := data["nextCursor"]; !ok {
					t.Fatal("list omitted null cursor")
				}
				if !reflect.DeepEqual(items[0], expectedTask(view, true)) {
					t.Fatalf("list item: %#v", items[0])
				}
			} else {
				nodes, ok := data["tasks"].([]any)
				if !ok || len(nodes) != 1 || data["projection"] != view || data["returnedNodes"] != float64(1) || data["totalNodes"] != float64(1) || data["partial"] != false || data["observedAt"] != "2026-11-01T02:03:04.567Z" {
					t.Fatalf("graph: %#v", data)
				}
				node := object(t, nodes[0])
				expectedNode := map[string]any{"id": testTargetID, "type": "task", "parentId": nil, "titlePreview": "Test task", "titleTruncated": false, "status": "todo", "dependsOn": []any{}, "externalDependsOn": []any{}, "blockedBy": []any{}, "requiredPlatform": nil, "assignedTo": nil, "allowAgents": false, "ready": false, "createdAt": "2026-11-01T02:03:04.567Z", "updatedAt": "2026-11-01T02:03:04.567Z", "startedAt": nil, "completedAt": nil, "cancelledAt": nil, "session": observation, "relation": "member"}
				if !reflect.DeepEqual(node, expectedNode) {
					t.Fatalf("graph node: %#v", node)
				}
				if object(t, data["project"])["id"] != testProjectID || object(t, data["sessionSummary"])["complete"] != true {
					t.Fatalf("graph observation: %#v", data)
				}
			}
			if name == "task_graph" {
				args["dependsOnly"] = true
				result, err = client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil || result.IsError {
					t.Fatal(err)
				}
				plain := object(t, structured(t, result)["data"])
				nodes := plain["tasks"].([]any)
				if len(nodes) != 1 || !reflect.DeepEqual(nodes[0], map[string]any{"id": testTargetID, "dependsOn": []any{}, "externalDependsOn": []any{}}) {
					t.Fatalf("dependency projection: %#v", plain)
				}
				if _, ok := plain["sessionSummary"]; ok {
					t.Fatalf("dependency read has observation: %#v", plain)
				}
			}
		}
	}
	resource := newTaskResourceFixture(t)
	assertNoDiscoveredOutputSchemas(t, resource.client, "task_show")
	for _, view := range []string{"summary", "full"} {
		expectTaskGet(t, resource, task, nil)
		result, err := resource.client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_show", Arguments: map[string]any{"projectId": testProjectID, "taskId": task.ID, "view": view}})
		if err != nil || result.IsError {
			t.Fatalf("show: %+v %v", result, err)
		}
		env := structured(t, result)
		if !reflect.DeepEqual(env["data"], expectedTask(view, false)) {
			t.Fatalf("show %s: %#v", view, env["data"])
		}
		meta := object(t, env["meta"])
		if meta["requestId"] != "test-request" || meta["partial"] != false || object(t, meta["refs"])["taskId"] != testTargetID {
			t.Fatalf("show metadata: %#v", meta)
		}
	}
}
