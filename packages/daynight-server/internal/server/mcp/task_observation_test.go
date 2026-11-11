package mcp

import (
	"context"
	"encoding/json"
	"errors"
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

func TestTaskObservationSchemasMatchActualProtocolResults(t *testing.T) {
	f := newEntryFixture(t)
	task := taskFixtureTask()
	project := model.Project{ID: testProjectID}
	project.Ownership.TeamID = testUserID
	graph := model.TaskGraph{Project: project, ObservedAt: task.CreatedAt, Tasks: []model.GraphTask{{ID: task.ID, Type: task.Type, TitlePreview: task.Title, Status: task.Status, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}}}
	stub := &queryStub{items: []store.TaskPriorityItem{{Task: task}}, graph: graph}
	if err := registerTaskQueryTools(f.entry, stub); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
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
			validateDiscoveredResult(t, client, name, result)
			if name == "task_graph" {
				args["dependsOnly"] = true
				result, err = client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil || result.IsError {
					t.Fatal(err)
				}
				validateDiscoveredResult(t, client, name, result)
			}
		}
	}
	resource := newTaskResourceFixture(t)
	for _, view := range []string{"summary", "full"} {
		expectTaskGet(t, resource, task, nil)
		result, err := resource.client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_show", Arguments: map[string]any{"projectId": testProjectID, "taskId": task.ID, "view": view}})
		if err != nil || result.IsError {
			t.Fatalf("show: %+v %v", result, err)
		}
		validateDiscoveredResult(t, resource.client, "task_show", result)
	}
}
