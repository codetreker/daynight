package mcp

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTaskSearchDiscoveryAndProtocol(t *testing.T) {
	for _, protocol := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(protocol, func(t *testing.T) {
			f := newEntryFixture(t)
			cursor, snippet, parent := "opaque-next", "matching text", testTargetID
			status, platform, yes := model.TaskStatus("todo"), model.PlatformLinux, true
			assigned := "me"
			calls := 0
			err := RegisterTaskSearchTool(f.entry, func(ctx context.Context, principal model.Principal, project string, in tasksearch.Request) (tasksearch.Page, error) {
				calls++
				tagTestActor(t, ctx, principal, project)
				want := tasksearch.Request{Query: "title:cache OR id:abc", Type: model.TaskTypeTask, Parent: &parent, AssignedTo: &assigned, Status: &status, Ready: &yes, AllowAgents: &yes, CompatiblePlatform: &platform, TagFilter: store.TagFilter{TagIDs: []string{testTargetID}, TagMatch: "any"}, Limit: 1}
				if calls == 2 {
					want.Cursor = &cursor
				}
				if !reflect.DeepEqual(in, want) {
					t.Errorf("request: %+v, want %+v", in, want)
				}
				item := tasksearch.Item{ID: testTargetID, Type: model.TaskTypeTask, ParentID: &parent, ProjectID: project, Title: "cache", Status: status, Tags: []model.TagReference{{ID: testTargetID, Name: "backend"}}, Context: &tasksearch.Context{TaskID: parent, Title: "Goal"}, Match: tasksearch.Match{Fields: []string{"title", "description"}, DescriptionSnippet: &snippet}}
				if calls == 2 {
					item.ID = testProjectID
					item.Tags = nil
					item.Context = nil
					item.ParentID = nil
				}
				page := tasksearch.Page{ProjectID: project, Total: 2, Items: []tasksearch.Item{item}}
				if calls == 1 {
					page.NextCursor = &cursor
				}
				return page, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			client := f.client(t, protocol, "alice")
			listing, err := client.ListTools(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			var found *sdk.Tool
			for _, tool := range listing.Tools {
				if tool.Name == "task_search" {
					found = tool
				}
			}
			if found == nil || found.Description == "" || found.InputSchema == nil || found.OutputSchema == nil || found.Annotations == nil || !found.Annotations.ReadOnlyHint || found.Annotations.DestructiveHint == nil || *found.Annotations.DestructiveHint || found.Annotations.OpenWorldHint == nil || *found.Annotations.OpenWorldHint {
				t.Fatalf("discovery: %+v", found)
			}
			args := map[string]any{"projectId": testProjectID, "query": "title:cache OR id:abc", "type": "task", "parentId": parent, "assignedTo": "me", "status": "todo", "ready": true, "allowAgents": true, "compatiblePlatform": "linux", "tagIds": []string{testTargetID}, "tagMatch": "any", "limit": 1}
			for page := 0; page < 2; page++ {
				result := tagTestCall(t, client, "task_search", args)
				if result.IsError {
					t.Fatalf("search: %+v", structured(t, result))
				}
				validateDiscoveredResult(t, client, "task_search", result)
				data := object(t, structured(t, result)["data"])
				if data["projectId"] != testProjectID || data["total"] != float64(2) {
					t.Fatalf("page: %+v", data)
				}
				items := data["items"].([]any)
				if len(items) != 1 {
					t.Fatalf("items: %+v", items)
				}
				item := object(t, items[0])
				if len(item) != 9 || item["title"] != "cache" || item["type"] != "task" || item["status"] != "todo" || item["projectId"] != testProjectID {
					t.Fatalf("lean item: %+v", item)
				}
				if _, present := item["description"]; present {
					t.Fatalf("full description leaked: %+v", item)
				}
				match := object(t, item["match"])
				if match["descriptionSnippet"] != snippet || !reflect.DeepEqual(match["fields"], []any{"title", "description"}) {
					t.Fatalf("match: %+v", match)
				}
				tags := item["tags"].([]any)
				if page == 0 {
					if item["id"] != testTargetID || item["parentId"] != parent || object(t, item["context"])["taskId"] != parent || len(tags) != 1 || object(t, tags[0])["name"] != "backend" || object(t, tags[0])["id"] != testTargetID || data["nextCursor"] != cursor {
						t.Fatalf("first page: %+v", data)
					}
					args["cursor"] = cursor
				} else if item["id"] != testProjectID || item["parentId"] != nil || item["context"] != nil || len(tags) != 0 || data["nextCursor"] != nil {
					t.Fatalf("second page: %+v", data)
				}
			}
			if calls != 2 {
				t.Fatalf("calls=%d", calls)
			}
		})
	}
}

func TestTaskSearchRefusalsAndDefaults(t *testing.T) {
	f := newEntryFixture(t)
	calls := 0
	err := RegisterTaskSearchTool(f.entry, func(_ context.Context, _ model.Principal, _ string, in tasksearch.Request) (tasksearch.Page, error) {
		calls++
		if in.Limit != 50 || in.Parent == nil || *in.Parent != "none" {
			t.Errorf("defaults: %+v", in)
		}
		return tasksearch.Page{}, &model.Fault{Code: in.Query, Message: "Search refused."}
	})
	if err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, code := range []string{"search_changed", "invalid_tag_filter", "invalid_search_expression", "forbidden", "resource_busy"} {
		result := tagTestCall(t, client, "task_search", map[string]any{"projectId": testProjectID, "query": code, "parentId": nil})
		if !result.IsError || object(t, structured(t, result)["error"])["code"] != code || structured(t, result)["data"] != nil {
			t.Fatalf("error %s: %+v", code, structured(t, result))
		}
	}
	before := calls
	for _, args := range []map[string]any{
		{"projectId": testProjectID}, {"projectId": testProjectID, "query": 17}, {"projectId": testProjectID, "query": "x", "tagIds": []string{"bad"}}, {"projectId": testProjectID, "query": "x", "tagMatch": "neither"}, {"projectId": testProjectID, "query": "x", "limit": 0}, {"projectId": testProjectID, "query": "x", "unknown": true},
	} {
		result := tagTestCall(t, client, "task_search", args)
		if !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
			t.Fatalf("invalid args %v: %+v", args, structured(t, result))
		}
	}
	if calls != before {
		t.Fatalf("invalid input reached search: %d -> %d", before, calls)
	}
}

func TestTaskSearchCancellation(t *testing.T) {
	f := newEntryFixture(t)
	started, stopped := make(chan struct{}), make(chan struct{})
	err := RegisterTaskSearchTool(f.entry, func(ctx context.Context, _ model.Principal, _ string, _ tasksearch.Request) (tasksearch.Page, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return tasksearch.Page{}, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = client.CallTool(ctx, &sdk.CallToolParams{Name: "task_search", Arguments: map[string]any{"projectId": testProjectID, "query": "x"}})
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("search did not start")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not reach search")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("client did not stop")
	}
}

func TestTaskSearchEmptyQueryUsesSearchParser(t *testing.T) {
	f := newEntryFixture(t)
	err := RegisterTaskSearchTool(f.entry, func(ctx context.Context, _ model.Principal, project string, input tasksearch.Request) (tasksearch.Page, error) {
		principal := model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTargetID}
		return tasksearch.Search(ctx, nil, principal, project, input)
	})
	if err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, query := range []string{"", "  "} {
		result := tagTestCall(t, client, "task_search", map[string]any{"projectId": testProjectID, "query": query})
		if !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_search_expression" {
			t.Fatalf("empty query %q: %+v", query, structured(t, result))
		}
	}
}

func TestTaskSearchCompletionError(t *testing.T) {
	caller := context.Background()
	operation, cancel := context.WithDeadline(caller, time.Now().Add(-time.Second))
	defer cancel()
	if fault, ok := searchCompletionError(caller, operation, context.DeadlineExceeded).(*model.Fault); !ok || fault.Code != "search_timeout" {
		t.Fatalf("timeout=%+v", fault)
	}
	failed := &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}
	if got := searchCompletionError(caller, operation, failed); got != failed {
		t.Fatalf("completion failure masked: %v", got)
	}
	cancelled, stop := context.WithCancel(caller)
	stop()
	if got := searchCompletionError(cancelled, operation, context.DeadlineExceeded); got != context.DeadlineExceeded {
		t.Fatalf("caller cancellation masked: %v", got)
	}
}

func TestTaskSearchRegistrationRequiresDependencies(t *testing.T) {
	f := newEntryFixture(t)
	search := func(context.Context, model.Principal, string, tasksearch.Request) (tasksearch.Page, error) {
		t.Error("search called while registering")
		return tasksearch.Page{}, nil
	}
	if err := RegisterTaskSearchTool(nil, search); err == nil {
		t.Fatal("registered without an entry")
	}
	if err := RegisterTaskSearchTool(f.entry, nil); err == nil {
		t.Fatal("registered without a search capability")
	}
	listing, err := f.client(t, "2026-07-28", "alice").ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listing.Tools {
		if tool.Name == "task_search" {
			t.Fatal("failed registration published the tool")
		}
	}
}

func TestTaskSearchBusinessInputLimit(t *testing.T) {
	f := newEntryFixture(t)
	calls := 0
	err := RegisterTaskSearchTool(f.entry, func(context.Context, model.Principal, string, tasksearch.Request) (tasksearch.Page, error) {
		calls++
		return tasksearch.Page{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	result := tagTestCall(t, client, "task_search", map[string]any{"projectId": testProjectID, "query": strings.Repeat("x", httpx.MaxJSONBody)})
	if !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" || calls != 0 {
		t.Fatalf("oversized search reached service or was not refused: result=%+v calls=%d", structured(t, result), calls)
	}
}
