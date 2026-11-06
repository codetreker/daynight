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
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type queryStub struct {
	items     []store.TaskPriorityItem
	request   taskcore.MCPListRequest
	principal model.Principal
	err       error
}

func (s *queryStub) Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error) {
	return model.TaskGraph{}, nil
}
func (s *queryStub) MCPList(_ context.Context, principal model.Principal, _ string, request taskcore.MCPListRequest, visit func(store.TaskPriorityItem, string, bool) bool) error {
	s.request, s.principal = request, principal
	if s.err != nil {
		return s.err
	}
	for i, item := range s.items {
		if !visit(item, fmt.Sprintf("cursor-%d", i), i+1 < len(s.items)) {
			break
		}
	}
	return nil
}

func TestTaskListProjectionAndReadyContinuationBudget(t *testing.T) {
	s := &queryStub{}
	for i := 0; i < 70; i++ {
		task := model.Task{ID: fmt.Sprint(i), ProjectID: "project", Title: strings.Repeat("a", 512), Description: "private description", Version: 1, CreatedAt: time.Now(), Properties: model.TaskProperties{}}
		s.items = append(s.items, store.TaskPriorityItem{Task: task, BlockedByCount: 3, TitleTruncated: true})
	}
	actor := RequestActor{Principal: model.Principal{UserID: "caller"}, RequestID: "request"}
	result, err := listTool(context.Background(), actor, listInput{ProjectID: "project", Limit: 70}, s, true)
	if err != nil {
		t.Fatal(err)
	}
	data := result.Data.(listData)
	if len(data.Items) == 0 || len(data.Items) == len(s.items) || data.Next == nil || data.NextCursor == nil {
		t.Fatalf("continuation: %#v", data)
	}
	if data.Next.Tool != "task_list" || data.Next.Arguments["cursor"] != *data.NextCursor || *data.NextCursor != fmt.Sprintf("cursor-%d", len(data.Items)-1) {
		t.Fatalf("invalid continuation: %#v", data.Next)
	}
	encoded, err := json.Marshal(envelope{Data: data, Meta: &envelopeMeta{RequestID: actor.RequestID}})
	if err != nil || len(encoded) > 16<<10 {
		t.Fatalf("budget=%d err=%v", len(encoded), err)
	}
	var item map[string]any
	if err := json.Unmarshal(data.Items[0], &item); err != nil {
		t.Fatal(err)
	}
	if item["blockedByCount"] != float64(3) || item["titleTruncated"] != true || item["projection"] != "summary" || item["description"] != nil {
		t.Fatalf("summary: %#v", item)
	}
	s.items = s.items[:1]
	result, err = listTool(context.Background(), actor, listInput{ProjectID: "project", View: "full"}, s, false)
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
	result, err = listTool(context.Background(), actor, listInput{ProjectID: "project", View: "full"}, s, true)
	if err != nil {
		t.Fatal(err)
	}
	item = nil
	if err := json.Unmarshal(result.Data.(listData).Items[0], &item); err != nil {
		t.Fatal(err)
	}
	if item["description"] != "private description" || s.request.Limit != 10 || s.principal.UserID != "caller" {
		t.Fatalf("ready full: %#v", item)
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
		args := map[string]any{"projectId": "c450e1ca-60a7-42d7-a17a-a112bc71fd8a"}
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

func TestReadyFullBudgetContinuationDisclosesDescriptionLimit(t *testing.T) {
	stub := &queryStub{}
	for i := 0; i < 3; i++ {
		stub.items = append(stub.items, store.TaskPriorityItem{Task: model.Task{
			ID: fmt.Sprint(i), ProjectID: "project", Title: "title", Description: strings.Repeat("d", 600),
			Version: 1, CreatedAt: time.Now(), Properties: model.TaskProperties{},
		}})
	}
	actor := RequestActor{RequestID: "request"}
	const budget = 1900
	result, err := listToolWithBudget(context.Background(), actor, listInput{ProjectID: "project", View: "full", Limit: 3}, stub, true, budget)
	if err != nil {
		t.Fatal(err)
	}
	data := result.Data.(listData)
	if len(data.Items) == 0 || len(data.Items) >= len(stub.items) || data.Next == nil || data.NextCursor == nil {
		t.Fatalf("expected bounded continuation: %#v", data)
	}
	if data.Next.FullItemsNotice != "task_list full omits descriptions; use task_show with view full for each complete Task." || data.Next.Arguments["cursor"] != *data.NextCursor || *data.NextCursor != fmt.Sprintf("cursor-%d", len(data.Items)-1) {
		t.Fatalf("continuation does not explain the limitation: %#v", data.Next)
	}
	encoded, err := json.Marshal(envelope{Data: data, Meta: &envelopeMeta{RequestID: actor.RequestID}})
	if err != nil || len(encoded) > budget {
		t.Fatalf("encoded length=%d, err=%v", len(encoded), err)
	}
	var item map[string]any
	if err := json.Unmarshal(data.Items[0], &item); err != nil || item["description"] != strings.Repeat("d", 600) {
		t.Fatalf("ready full lost description: %#v, %v", item, err)
	}
	failure, err := listToolWithBudget(context.Background(), actor, listInput{ProjectID: "project", View: "full", Limit: 3}, stub, true, 200)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "payload_too_large" || failure.Refs["taskId"] != "0" || failure.Refs["readWith"] != "task_show" {
		t.Fatalf("first item failure: %#v, %v", failure, err)
	}
}
