package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTaskQueryTagFiltersThroughMCP(t *testing.T) {
	const tagA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const tagB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, name := range []string{"task_list", "task_ready"} {
		for _, tc := range []struct {
			name string
			args map[string]any
			want store.TagFilter
		}{
			{"omitted", nil, store.TagFilter{}},
			{"single", map[string]any{"tagIds": []string{tagA}}, store.TagFilter{TagIDs: []string{tagA}}},
			{"all", map[string]any{"tagIds": []string{tagB, tagA, tagA}, "tagMatch": "all"}, store.TagFilter{TagIDs: []string{tagB, tagA, tagA}, TagMatch: "all"}},
			{"any", map[string]any{"tagIds": []string{tagB, tagA}, "tagMatch": "any"}, store.TagFilter{TagIDs: []string{tagB, tagA}, TagMatch: "any"}},
			{"untagged", map[string]any{"untagged": true}, store.TagFilter{Untagged: true}},
		} {
			t.Run(name+"/"+tc.name, func(t *testing.T) {
				item := taskFixtureTask()
				item.Tags = []model.TagReference{{ID: tagA, Name: "bug"}}
				stub := &queryStub{items: []store.TaskPriorityItem{{Task: item}}}
				f := newEntryFixture(t)
				if err := registerTaskQueryTools(f.entry, stub); err != nil {
					t.Fatal(err)
				}
				client := f.client(t, "2026-07-28", "alice")
				args := map[string]any{"projectId": testProjectID, "parentId": testTargetID, "limit": 1, "allowAgents": true, "compatiblePlatform": "linux"}
				for k, v := range tc.args {
					args[k] = v
				}
				if name == "task_list" {
					args["cursor"] = "cursor"
					args["ready"] = true
					args["assignedTo"] = "me"
				}
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil || result.IsError {
					t.Fatalf("result=%+v error=%v", result, err)
				}
				var got store.TagFilter
				if name == "task_list" {
					got = stub.request.TagFilter
					if stub.request.Cursor == nil || *stub.request.Cursor != "cursor" || stub.request.Ready == nil || !*stub.request.Ready || stub.request.AssignedTo == nil || *stub.request.AssignedTo != "me" {
						t.Fatalf("list filters: %+v", stub.request)
					}
				} else {
					got = stub.readyRequest.TagFilter
					if stub.readyRequest.Parent == nil || *stub.readyRequest.Parent != testTargetID || stub.readyRequest.Limit != 1 || stub.readyRequest.AllowAgents == nil || !*stub.readyRequest.AllowAgents || stub.readyRequest.CompatiblePlatform == nil || *stub.readyRequest.CompatiblePlatform != model.PlatformLinux {
						t.Fatalf("ready filters: %+v", stub.readyRequest)
					}
				}
				if !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("filter = %+v, want %+v", got, tc.want)
				}
				data := object(t, structured(t, result)["data"])
				tags := object(t, data["items"].([]any)[0])["tags"].([]any)
				if len(tags) != 1 || object(t, tags[0])["id"] != tagA || object(t, tags[0])["name"] != "bug" {
					t.Fatalf("tags = %#v", tags)
				}
				if name == "task_ready" && len(data) != 2 {
					t.Fatalf("ready should not paginate: %#v", data)
				}
			})
		}
	}
}

type selectingQueryStub struct {
	queryStub
	calls int
}

func (s *selectingQueryStub) ObservedMCPList(ctx context.Context, principal model.Principal, project string, request taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	s.calls++
	if _, err := taskcore.SelectMCPList(project, testUserID, request); err != nil {
		return taskservice.ObservedMCPPage{}, err
	}
	return s.queryStub.ObservedMCPList(ctx, principal, project, request)
}

func (s *selectingQueryStub) MCPReady(ctx context.Context, principal model.Principal, project string, request taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	s.calls++
	if _, err := taskcore.SelectMCPReady(request); err != nil {
		return nil, err
	}
	return s.queryStub.MCPReady(ctx, principal, project, request)
}

func TestTaskQueryTagFilterErrorsThroughMCP(t *testing.T) {
	for _, name := range []string{"task_list", "task_ready"} {
		t.Run(name, func(t *testing.T) {
			stub := &selectingQueryStub{queryStub: queryStub{err: &model.Fault{Code: "invalid_tag_filter", Message: "Invalid tag filter."}}}
			f := newEntryFixture(t)
			if err := registerTaskQueryTools(f.entry, stub); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			for _, args := range []map[string]any{
				{"tagIds": []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, "untagged": true},
				{"tagIds": []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}},
			} {
				args["projectId"] = testProjectID
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_tag_filter" || structured(t, result)["data"] != nil {
					t.Fatalf("refusal=%+v err=%v", result, err)
				}
			}
			before := stub.calls
			for _, args := range []map[string]any{{"tagIds": []string{"bad"}}, {"tagMatch": "neither"}, {"untagged": "yes"}} {
				args["projectId"] = testProjectID
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
					t.Fatalf("schema refusal=%+v err=%v", result, err)
				}
			}
			if stub.calls != before {
				t.Fatalf("invalid schema reached service: %d -> %d", before, stub.calls)
			}
		})
	}
}

type cancelledQueryStub struct {
	queryStub
	started, stopped chan struct{}
	t                *testing.T
}

func (s *cancelledQueryStub) wait(ctx context.Context, filter store.TagFilter) error {
	if !reflect.DeepEqual(filter, store.TagFilter{TagIDs: []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, TagMatch: "any"}) {
		s.t.Errorf("filter = %+v", filter)
	}
	close(s.started)
	<-ctx.Done()
	close(s.stopped)
	return ctx.Err()
}

func (s *cancelledQueryStub) ObservedMCPList(ctx context.Context, _ model.Principal, _ string, request taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	return taskservice.ObservedMCPPage{}, s.wait(ctx, request.TagFilter)
}

func (s *cancelledQueryStub) MCPReady(ctx context.Context, _ model.Principal, _ string, request taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	return nil, s.wait(ctx, request.TagFilter)
}

func TestTaskQueryTagFilterCancellation(t *testing.T) {
	for _, name := range []string{"task_list", "task_ready"} {
		t.Run(name, func(t *testing.T) {
			stub := &cancelledQueryStub{started: make(chan struct{}), stopped: make(chan struct{}), t: t}
			f := newEntryFixture(t)
			if err := registerTaskQueryTools(f.entry, stub); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			go func() {
				defer close(done)
				_, _ = client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: map[string]any{"projectId": testProjectID, "tagIds": []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, "tagMatch": "any"}})
			}()
			select {
			case <-stub.started:
			case <-time.After(5 * time.Second):
				t.Fatal("operation did not start")
			}
			cancel()
			select {
			case <-stub.stopped:
			case <-time.After(5 * time.Second):
				t.Fatal("cancellation did not reach service")
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("client did not stop")
			}
		})
	}
}

func TestTaskQueryBusinessLimit(t *testing.T) {
	const overhead = len(`{"cursor":""}`)
	for _, extra := range []int{0, 1} {
		input, err := json.Marshal(map[string]any{"projectId": testProjectID, "view": "summary", "cursor": strings.Repeat("x", httpx.MaxJSONBody-overhead+extra)})
		if err != nil {
			t.Fatal(err)
		}
		err = queryBusinessLimit(input)
		if (err != nil) != (extra != 0) {
			t.Fatalf("extra %d: %v", extra, err)
		}
	}
	for _, name := range []string{"task_list", "task_ready"} {
		t.Run(name, func(t *testing.T) {
			stub := &queryStub{}
			f := newEntryFixture(t)
			if err := registerTaskQueryTools(f.entry, stub); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			ids := make([]string, 27000)
			for i := range ids {
				ids[i] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			}
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: map[string]any{"projectId": testProjectID, "tagIds": ids}})
			if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
				t.Fatalf("oversize: %+v, %v", result, err)
			}
			if stub.request.Limit != 0 || stub.readyRequest.Limit != 0 {
				t.Fatal("oversized input reached service")
			}
		})
	}
}
