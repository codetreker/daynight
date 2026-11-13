package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type queryStub struct {
	items        []store.TaskPriorityItem
	request      taskcore.MCPListRequest
	readyRequest taskcore.MCPReadyRequest
	principal    model.Principal
	err          error
	graphErr     error
	graph        model.TaskGraph
}

func (s *queryStub) Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error) {
	return s.graph, s.graphErr
}
func (s *queryStub) MCPList(_ context.Context, principal model.Principal, _ string, request taskcore.MCPListRequest, visit func(store.TaskPriorityItem, string, bool) bool) error {
	s.request, s.principal = request, principal
	if s.err != nil {
		return s.err
	}
	for i, item := range s.items[:min(len(s.items), request.Limit)] {
		if !visit(item, fmt.Sprintf("cursor-%d", i), i+1 < len(s.items)) {
			break
		}
	}
	return nil
}

func (s *queryStub) MCPReady(_ context.Context, principal model.Principal, _ string, request taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	s.readyRequest, s.principal = request, principal
	if s.err != nil {
		return nil, s.err
	}
	return s.items[:min(len(s.items), request.Limit)], nil
}

func TestTaskListProjectionAndCountContinuation(t *testing.T) {
	s := &queryStub{}
	for i := 0; i < 70; i++ {
		task := model.Task{ID: fmt.Sprint(i), ProjectID: "project", Title: strings.Repeat("a", 512), Description: "private description", Version: 1, CreatedAt: time.Now(), Properties: model.TaskProperties{}}
		s.items = append(s.items, store.TaskPriorityItem{Task: task, BlockedByCount: 3, TitleTruncated: true})
	}
	actor := RequestActor{Principal: model.Principal{UserID: "caller"}, RequestID: "request"}
	result, err := listTool(context.Background(), actor, listInput{ProjectID: "project", Limit: 70}, s)
	if err != nil {
		t.Fatal(err)
	}
	data := result.Data.(listData)
	if len(data.Items) != len(s.items) || data.NextCursor != nil {
		t.Fatalf("continuation: %#v", data)
	}
	encoded, err := json.Marshal(envelope{Data: data, Meta: &envelopeMeta{RequestID: actor.RequestID}})
	if err != nil || len(encoded) <= 16<<10 {
		t.Fatalf("complete page=%d err=%v", len(encoded), err)
	}
	var item map[string]any
	if err := json.Unmarshal(data.Items[0], &item); err != nil {
		t.Fatal(err)
	}
	if item["blockedByCount"] != float64(3) || item["titleTruncated"] != true || item["projection"] != "summary" || item["description"] != nil {
		t.Fatalf("summary: %#v", item)
	}
	s.items = s.items[:1]
	result, err = listTool(context.Background(), actor, listInput{ProjectID: "project", View: "full"}, s)
	if err != nil {
		t.Fatal(err)
	}
	data = result.Data.(listData)
	item = nil
	if err := json.Unmarshal(data.Items[0], &item); err != nil {
		t.Fatal(err)
	}
	if _, ok := item["description"]; ok {
		t.Fatalf("list full includes description: %#v", item)
	}
}

func TestTaskGraphCancellationTimeAndDependencyProjection(t *testing.T) {
	stamp := time.Date(2026, 11, 7, 1, 2, 3, 456789123, time.FixedZone("test", 3*60*60))
	stub := &queryStub{graph: model.TaskGraph{
		Summary: model.TaskGraphSummary{Total: 1, Cancelled: 1},
		Tasks:   []model.GraphTask{{ID: "cancelled", Status: model.TaskCancelled, CancelledAt: &stamp, DependsOn: []string{"prerequisite"}}},
	}}
	result, err := graphTool(t.Context(), RequestActor{RequestID: "request"}, graphInput{View: "full"}, stub)
	if err != nil {
		t.Fatal(err)
	}
	data := result.Data.(graphData)
	node := data.Tasks[0].(graphNode)
	if data.Summary.Cancelled != 1 || data.Summary.Done != 0 || node.CancelledAt == nil || !node.CancelledAt.Equal(stamp) || node.CancelledAt.Location() != time.UTC || stamp.Location() == time.UTC {
		t.Fatalf("cancellation graph projection: %#v %#v", data.Summary, node)
	}
	result, err = graphTool(t.Context(), RequestActor{RequestID: "request"}, graphInput{View: "full", DependsOnly: true}, stub)
	if err != nil {
		t.Fatal(err)
	}
	data = result.Data.(graphData)
	encoded, err := json.Marshal(data.Tasks[0])
	if err != nil || strings.Contains(string(encoded), "cancelledAt") || strings.Contains(string(encoded), "status") {
		t.Fatalf("dependency projection contains unrelated fields: %s, %v", encoded, err)
	}
}

func TestTaskQueryRegistrationAndProtocolValidation(t *testing.T) {
	f := newEntryFixture(t)
	stub := &queryStub{items: []store.TaskPriorityItem{{Task: model.Task{ID: "id", ProjectID: "project", Title: "title", Version: 7, CreatedAt: time.Now(), Properties: model.TaskProperties{}}, BlockedByCount: 2}}}
	if err := registerTaskQueryTools(f.entry, stub); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	discovered, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, tool := range discovered.Tools {
		found[tool.Name] = true
	}
	for _, name := range []string{"task_list", "task_ready", "task_graph"} {
		if !found[name] {
			t.Fatalf("missing %s", name)
		}
	}
	for _, name := range []string{"task_list", "task_ready", "task_graph"} {
		args := map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a"}
		if name == "task_graph" {
			args["taskId"] = "f8836e8f-a543-4d43-b4a2-65a8243baa54"
		}
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("%s: %#v %v", name, result, err)
		}
		if object(t, structured(t, result)["meta"])["requestId"] != "test-request" {
			t.Fatalf("%s missing request ID", name)
		}
	}
	filtered, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_list", Arguments: map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a", "status": "cancelled"}})
	if err != nil || filtered.IsError || stub.request.Status == nil || *stub.request.Status != model.TaskCancelled {
		t.Fatalf("cancelled status schema or query: %#v %v", filtered, err)
	}
	stub.err = &model.Fault{Code: "list_changed", Message: "Tasks changed during this list; restart the list."}
	changed, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_list", Arguments: map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a"}})
	if err != nil || !changed.IsError || object(t, structured(t, changed)["error"])["code"] != "list_changed" {
		t.Fatalf("list_changed: %#v %v", changed, err)
	}
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_list", Arguments: map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a", "all": true, "status": "done"}})
	if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
		t.Fatalf("invalid filters: %#v %v", result, err)
	}
}

func TestTaskQueryBudgetMatchesMaterialization(t *testing.T) {
	f := newEntryFixture(t)
	stub := &queryStub{}
	if err := registerTaskQueryTools(f.entry, stub); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	release, err := f.entry.budget.Acquire(ctx, BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, name := range []string{"task_list", "task_ready"} {
		args := map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a", "tagIds": []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("%s summary: %#v %v", name, result, err)
		}
		args["view"] = "full"
		result, err = client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "resource_busy" {
			t.Fatalf("%s full: %#v %v", name, result, err)
		}
	}
}

func TestTaskReadyCountLimitAndCompleteViews(t *testing.T) {
	f := newEntryFixture(t)
	stub := &queryStub{}
	for i := 0; i < 21; i++ {
		stub.items = append(stub.items, store.TaskPriorityItem{Task: model.Task{
			ID: fmt.Sprint(i), ProjectID: "project", Title: strings.Repeat("\\", 512), Description: strings.Repeat("d", 16<<10),
			Status: model.TaskTodo, Ready: true, Version: 7, CreatedAt: time.Now(), Properties: model.TaskProperties{},
		}, TitleTruncated: true})
	}
	if err := registerTaskQueryTools(f.entry, stub); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, tc := range []struct {
		name  string
		limit int
		view  string
		want  int
	}{
		{"default", 0, "", 5}, {"minimum", 1, "summary", 1},
		{"maximum summary", 20, "summary", 20}, {"maximum full", 20, "full", 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a", "allowAgents": true, "compatiblePlatform": "linux"}
			if tc.limit != 0 {
				args["limit"] = tc.limit
			}
			if tc.view != "" {
				args["view"] = tc.view
			}
			result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_ready", Arguments: args})
			if err != nil || result.IsError {
				t.Fatalf("ready: %#v %v", result, err)
			}
			data := object(t, structured(t, result)["data"])
			items := data["items"].([]any)
			view := tc.view
			if view == "" {
				view = "summary"
			}
			if len(items) != tc.want || len(data) != 2 || data["projection"] != view {
				t.Fatalf("single candidate result: %#v", data)
			}
			if stub.readyRequest.Limit != tc.want || stub.readyRequest.AllowAgents == nil || !*stub.readyRequest.AllowAgents || stub.readyRequest.CompatiblePlatform == nil || *stub.readyRequest.CompatiblePlatform != model.PlatformLinux {
				t.Fatalf("ready filters: %#v", stub.readyRequest)
			}
			for i, value := range items {
				item := object(t, value)
				if item["id"] != fmt.Sprint(i) || item["projection"] != view || item["version"] != "7" {
					t.Fatalf("item: %#v", item)
				}
				if view == "full" {
					if item["description"] != stub.items[i].Task.Description || item["title"] != stub.items[i].Task.Title {
						t.Fatalf("full content lost: %#v", item)
					}
				} else if item["titleTruncated"] != true || item["description"] != nil || item["titlePreview"] != stub.items[i].Task.Title {
					t.Fatalf("summary: %#v", item)
				}
			}
			if tc.limit == 20 && view == "summary" {
				encoded, err := json.Marshal(structured(t, result))
				if err != nil || len(encoded) <= 16<<10 {
					t.Fatalf("fixture did not exceed former summary budget: %d %v", len(encoded), err)
				}
			}
		})
	}
	for _, args := range []map[string]any{{"limit": 0}, {"limit": 21}, {"cursor": "any"}} {
		args["projectId"] = "c450e1ca-60a7-42d7-a17a-a112bc71fd8a"
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_ready", Arguments: args})
		if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
			t.Fatalf("invalid ready input: %#v %v", result, err)
		}
	}
	stub.items = nil
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_ready", Arguments: map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a"}})
	if err != nil || result.IsError {
		t.Fatalf("empty: %#v %v", result, err)
	}
	data := object(t, structured(t, result)["data"])
	if len(data["items"].([]any)) != 0 || len(data) != 2 {
		t.Fatalf("empty: %#v", data)
	}
}

func TestTaskListFullProjectionPreservesCountCursorAndEncodingErrors(t *testing.T) {
	stub := &queryStub{}
	for i := 0; i < 3; i++ {
		stub.items = append(stub.items, store.TaskPriorityItem{Task: model.Task{ID: fmt.Sprint(i), ProjectID: "project", Title: strings.Repeat("t", 600), Description: "omitted", Version: 1, CreatedAt: time.Now(), Properties: model.TaskProperties{}}})
	}
	actor := RequestActor{RequestID: "request"}
	result, err := listTool(context.Background(), actor, listInput{ProjectID: "project", View: "full", Limit: 2}, stub)
	if err != nil {
		t.Fatal(err)
	}
	data := result.Data.(listData)
	if len(data.Items) != 2 || data.NextCursor == nil || *data.NextCursor != "cursor-1" {
		t.Fatalf("complete page: %#v", data)
	}
	stub.items[0].Task.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`not JSON`)}
	result, err = listTool(context.Background(), actor, listInput{ProjectID: "project", View: "full", Limit: 2}, stub)
	var marshaler *json.MarshalerError
	if !errors.As(err, &marshaler) || result.Data != nil {
		t.Fatalf("encoding cause lost: %#v, %v", result, err)
	}
}

func TestTaskQueriesDoNotReportSnapshotFailureAsWrite(t *testing.T) {
	f := newEntryFixture(t)
	failure := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("snapshot failed")}
	stub := &queryStub{err: failure, graphErr: failure}
	if err := registerTaskQueryTools(f.entry, stub); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, name := range []string{"task_list", "task_ready", "task_graph"} {
		args := map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a"}
		if name == "task_graph" {
			args["taskId"] = "f8836e8f-a543-4d43-b4a2-65a8243baa54"
		}
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || !result.IsError {
			t.Fatalf("%s: %#v %v", name, result, err)
		}
		failure := object(t, structured(t, result)["error"])
		if _, present := failure["writeOutcome"]; present {
			t.Fatalf("%s reported a write: %#v", name, failure)
		}
	}
}

func TestTaskQueryRegistrationRejectsInvalidDefinitions(t *testing.T) {
	original := taskQueryToolDefinitions
	t.Cleanup(func() { taskQueryToolDefinitions = original })
	var definitions []map[string]any
	if err := json.Unmarshal(original, &definitions); err != nil {
		t.Fatal(err)
	}
	invalidName := make([]map[string]any, len(definitions))
	invalidSchema := make([]map[string]any, len(definitions))
	for i, definition := range definitions {
		invalidName[i] = make(map[string]any, len(definition))
		invalidSchema[i] = make(map[string]any, len(definition))
		for key, value := range definition {
			invalidName[i][key] = value
			invalidSchema[i][key] = value
		}
	}
	invalidName[0]["name"] = "unexpected_tool"
	invalidSchema[0]["inputSchema"] = map[string]any{"type": "string"}
	encode := func(value any) []byte {
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, tc := range []struct {
		name    string
		bytes   []byte
		message string
	}{
		{"malformed", []byte("{"), "unexpected end"},
		{"missing tool", []byte("[]"), "invalid task tool definitions"},
		{"unknown tool", encode(invalidName), "unexpected task tool"},
		{"invalid schema", encode(invalidSchema), "register task_list"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newEntryFixture(t)
			taskQueryToolDefinitions = tc.bytes
			err := registerTaskQueryTools(fixture.entry, &queryStub{})
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("got %v; want error containing %q", err, tc.message)
			}
		})
	}
}

func (s *queryStub) ObservedMCPList(ctx context.Context, principal model.Principal, project string, request taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	page := taskservice.ObservedMCPPage{Items: []taskservice.ObservedMCPItem{}, ObservedAt: time.Now().UTC()}
	err := s.MCPList(ctx, principal, project, request, func(item store.TaskPriorityItem, cursor string, more bool) bool {
		page.Items = append(page.Items, taskservice.ObservedMCPItem{Item: item, Session: observationFixture()})
		if more {
			page.NextCursor = &cursor
		} else {
			page.NextCursor = nil
		}
		return true
	})
	return page, err
}
func (s *queryStub) ObserveGraph(ctx context.Context, p model.Principal, project, id string) (taskservice.ObservedGraph, error) {
	graph, err := s.Graph(ctx, p, project, id)
	return observedGraphFixture(graph), err
}
