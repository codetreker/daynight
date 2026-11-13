package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPTaskTagsInputAndReceipts(t *testing.T) {
	const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, kind := range []model.TaskType{model.TaskTypeTask, model.TaskTypeGoal} {
		for _, view := range []string{"summary", "full"} {
			t.Run(string(kind)+"/"+view, func(t *testing.T) {
				f := newTaskResourceFixture(t)
				current := taskFixtureTask()
				current.Type = kind
				if kind == model.TaskTypeGoal {
					current.Ready = false
					current.Progress = &model.GoalProgress{}
				}
				current.Tags = []model.TagReference{{ID: a, Name: "Alpha &"}, {ID: b, Name: "Beta"}}
				requested := []string{strings.ToUpper(b), a, b}
				input := taskcore.CreateTask{Type: kind, Title: current.Title, TagIDs: &requested}
				if kind == model.TaskTypeTask {
					input.AssignedTo = &f.principal.UserID
				}
				expectTaskCreate(t, f, input, current, nil)
				created := taskData(t, f.client, "task_create", map[string]any{"projectId": f.project, "type": kind, "title": current.Title, "tagIds": requested, "returnView": view})
				want := []any{map[string]any{"id": a, "name": "Alpha &"}, map[string]any{"id": b, "name": "Beta"}}
				if !reflect.DeepEqual(created["tags"], want) {
					t.Fatalf("create tags: %#v", created)
				}
				ids, err := taskcore.NormalizeTagIDs(requested)
				if err != nil || !taskcore.MatchesTagIDs(current.Tags, ids) {
					t.Fatalf("receipt IDs: %v %v", ids, err)
				}

				f.operations.wantCalls["ReplaceTags"]++
				f.operations.ReplaceTagsFunc = func(_ context.Context, _ model.Principal, _, id string, version int64, got *[]string) (model.Task, error) {
					if id != current.ID || version != 9223372036854775807 || got == nil || !reflect.DeepEqual(*got, []string{}) {
						t.Errorf("clear input: %s %d %#v", id, version, got)
					}
					cleared := current
					cleared.Tags = nil
					cleared.Version = version
					return cleared, nil
				}
				cleared := taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "9223372036854775807", "tagIds": []string{}, "returnView": view})
				if !reflect.DeepEqual(cleared["tags"], []any{}) || cleared["version"] != "9223372036854775807" {
					t.Fatalf("clear receipt: %#v", cleared)
				}
			})
		}
	}
}

func TestMCPTaskTagsMixedUpdateAndFailures(t *testing.T) {
	f := newTaskResourceFixture(t)
	current := taskFixtureTask()
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	ids := []string{id}
	title := "Changed"
	current.Title, current.Version = title, 2
	current.Tags = []model.TagReference{{ID: id, Name: "Backend"}}
	deps := []string{"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1, Title: &title, TagIDs: &ids}, &deps, nil, current, nil)
	data := taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "1", "title": title, "tagIds": ids, "dependsOn": deps})
	if !reflect.DeepEqual(data["tags"], []any{map[string]any{"id": id, "name": "Backend"}}) || data["version"] != "2" {
		t.Fatalf("mixed receipt: %#v", data)
	}

	for _, code := range []string{"tag_not_found", "forbidden", "version_conflict", "resource_limit_exceeded"} {
		f.operations.wantCalls["ReplaceTags"]++
		f.operations.ReplaceTagsFunc = func(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error) {
			return model.Task{}, taskResourceFault(code)
		}
		taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "1", "tagIds": ids}, code)
	}
	f.operations.wantCalls["ReplaceTags"]++
	f.operations.ReplaceTagsFunc = func(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error) {
		return model.Task{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost confirmation")}
	}
	result, env := callTaskResource(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "1", "tagIds": ids})
	if !result.IsError || object(t, env["error"])["writeOutcome"] != "unknown" {
		t.Fatalf("unknown outcome: %#v", env)
	}
	for _, invalid := range []any{nil, "bad", []any{nil}, []any{1}, []string{"not-uuid"}} {
		taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "1", "tagIds": invalid}, "invalid_input")
	}
}

func TestMCPTaskTagBusinessLimit(t *testing.T) {
	fields := map[string]json.RawMessage{"title": json.RawMessage(`"x"`), "tagIds": json.RawMessage(`[]`)}
	base, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	fields["description"] = json.RawMessage(`"` + strings.Repeat("x", httpx.MaxJSONBody-len(base)-len(`,"description":""`)) + `"`)
	if err := taskBusinessLimit("task_create", fields, 0, nil, nil); err != nil {
		t.Fatalf("exact: %v", err)
	}
	fields["tagIds"] = json.RawMessage(`["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]`)
	if err := taskBusinessLimit("task_create", fields, 0, nil, nil); err == nil {
		t.Fatal("tag IDs bypassed business limit")
	}
}

func TestMCPTagWriteCancellationReachesService(t *testing.T) {
	f := newTaskResourceFixture(t)
	started, stopped := make(chan struct{}), make(chan struct{})
	f.operations.wantCalls["ReplaceTags"]++
	f.operations.ReplaceTagsFunc = func(ctx context.Context, _ model.Principal, _, _ string, version int64, tags *[]string) (model.Task, error) {
		if version != 1 || tags == nil || !reflect.DeepEqual(*tags, []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}) {
			t.Error("cancellation input changed")
		}
		close(started)
		<-ctx.Done()
		close(stopped)
		return model.Task{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = f.client.CallTool(ctx, &sdk.CallToolParams{Name: "task_update", Arguments: map[string]any{"projectId": f.project, "taskId": testTargetID, "ifVersion": "1", "tagIds": []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}})
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("operation did not start")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not reach service")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("client did not stop")
	}
}

func TestMCPTagIDsCountTowardBusinessLimitOnWire(t *testing.T) {
	f := newTaskResourceFixture(t)
	ids := make([]string, 28000)
	for i := range ids {
		ids[i] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	}
	taskError(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": "Large", "tagIds": ids}, "invalid_input")
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": testTargetID, "ifVersion": "1", "tagIds": ids}, "invalid_input")
}
