package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakeStepReads struct {
	version int64
	items   []store.TaskStepProjection
	calls   int
}

func (f *fakeStepReads) header() model.TaskHeader {
	return model.TaskHeader{ProjectID: testProjectID, ID: testTargetID, Version: f.version}
}
func (f *fakeStepReads) ListPage(_ context.Context, _ model.Principal, _, _ string, after int64, limit int, version *int64, summary bool) (taskservice.StepsPage, error) {
	f.calls++
	if version != nil && *version != f.version {
		return taskservice.StepsPage{}, &model.Fault{Code: "version_conflict", Message: "Task version does not match."}
	}
	result := taskservice.StepsPage{Header: f.header(), Items: make([]store.TaskStepProjection, 0)}
	for _, item := range f.items {
		if item.Step.Position <= after {
			continue
		}
		if len(result.Items) == limit {
			result.HasMore = true
			break
		}
		if summary {
			item.Step.Description = ""
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}
func (f *fakeStepReads) GetSummary(_ context.Context, _ model.Principal, _, _, id string) (taskservice.StepSummary, error) {
	for _, item := range f.items {
		if item.Step.ID == id {
			item.Step.Description = ""
			return taskservice.StepSummary{Header: f.header(), Item: item}, nil
		}
	}
	return taskservice.StepSummary{}, tasksteps.NotFound(f.version, model.ErrNotFound)
}
func (f *fakeStepReads) Get(_ context.Context, _ model.Principal, _, _, id string) (taskservice.StepDocument, error) {
	for _, item := range f.items {
		if item.Step.ID == id {
			resource := taskcodec.ProjectItem(f.header(), item.Step)
			return taskservice.StepDocument{Resource: resource}, nil
		}
	}
	return taskservice.StepDocument{}, tasksteps.NotFound(f.version, model.ErrNotFound)
}
func sampleStepReads(count int, title string) *fakeStepReads {
	f := &fakeStepReads{version: 9007199254740993}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < count; i++ {
		f.items = append(f.items, store.TaskStepProjection{Step: model.TaskStep{ID: fmt.Sprintf("%08x", i), Position: int64(i), Title: title, Description: "content", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}, TitleTruncated: len(title) > 512})
	}
	return f
}
func readCall(t *testing.T, client *sdk.ClientSession, name string, args map[string]any) *sdk.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func readArgs() map[string]any {
	return map[string]any{"projectId": testProjectID, "taskId": testTargetID}
}

func TestStepReadDiscoveryAndVersionedTraversal(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			fixture := newEntryFixture(t)
			ops := sampleStepReads(3, strings.Repeat("界", 200))
			if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
				t.Fatal(err)
			}
			client := fixture.client(t, version, "alice")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			listing, err := client.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			found := map[string]bool{}
			for _, tool := range listing.Tools {
				if strings.HasPrefix(tool.Name, "task_step_") {
					if tool.InputSchema == nil || tool.OutputSchema == nil {
						t.Fatalf("missing schemas: %+v", tool)
					}
					found[tool.Name] = true
				}
			}
			if len(found) != 2 || !found["task_step_list"] || !found["task_step_show"] {
				t.Fatalf("discovery: %+v", found)
			}
			args := readArgs()
			args["limit"] = 2
			result := readCall(t, client, "task_step_list", args)
			if result.IsError {
				t.Fatalf("first page: %+v", structured(t, result))
			}
			data := object(t, structured(t, result)["data"])
			items := data["items"].([]any)
			if data["version"] != "9007199254740993" || data["projection"] != "summary" || len(items) != 2 {
				t.Fatalf("page: %+v", data)
			}
			first := object(t, items[0])
			preview := first["titlePreview"].(string)
			if len(preview) > 512 || !utf8.ValidString(preview) || first["titleTruncated"] != true {
				t.Fatalf("preview: %+v", first)
			}
			cursor := data["nextCursor"].(string)
			args["cursor"] = cursor
			result = readCall(t, client, "task_step_list", args)
			data = object(t, structured(t, result)["data"])
			if result.IsError || len(data["items"].([]any)) != 1 || object(t, data["items"].([]any)[0])["id"] != "00000002" || data["nextCursor"] != nil {
				t.Fatalf("last page: %+v", data)
			}
			ops.version++
			result = readCall(t, client, "task_step_list", args)
			failure := object(t, structured(t, result)["error"])
			if !result.IsError || failure["code"] != "version_conflict" {
				t.Fatalf("version fence: %+v", failure)
			}
			args["view"] = "full"
			calls := ops.calls
			result = readCall(t, client, "task_step_list", args)
			failure = object(t, structured(t, result)["error"])
			if !result.IsError || failure["code"] != "invalid_input" || ops.calls != calls {
				t.Fatalf("cursor scope: %+v", failure)
			}
			show := readArgs()
			show["stepId"] = "ffffffff"
			result = readCall(t, client, "task_step_show", show)
			failure = object(t, structured(t, result)["error"])
			refs := object(t, failure["refs"])
			if !result.IsError || failure["code"] != "not_found" || refs["version"] != "9007199254740994" || refs["stepId"] != "ffffffff" {
				t.Fatalf("absence: %+v", failure)
			}
		})
	}
}

func TestStepReadAdmissionFollowsMaterialization(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := sampleStepReads(1, "step")
	if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	release, err := fixture.entry.budget.Acquire(context.Background(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(release)
	for _, name := range []string{"task_step_list", "task_step_show"} {
		args := readArgs()
		if name == "task_step_show" {
			args["stepId"] = "00000000"
		}
		if r := readCall(t, client, name, args); r.IsError {
			t.Fatalf("summary blocked: %+v", structured(t, r))
		}
		args["view"] = "full"
		r := readCall(t, client, name, args)
		failure := object(t, structured(t, r)["error"])
		if !r.IsError || failure["code"] != "resource_busy" {
			t.Fatalf("full admission: %+v", failure)
		}
	}
	release()
	var releases []func()
	for range 16 {
		r, e := fixture.entry.budget.Acquire(context.Background(), BudgetControl)
		if e != nil {
			t.Fatal(e)
		}
		releases = append(releases, r)
	}
	defer func() {
		for _, r := range releases {
			r()
		}
	}()
	args := readArgs()
	r := readCall(t, client, "task_step_list", args)
	failure := object(t, structured(t, r)["error"])
	if !r.IsError || failure["code"] != "resource_busy" {
		t.Fatalf("control admission: %+v", failure)
	}
	args["view"] = "full"
	r = readCall(t, client, "task_step_list", args)
	if r.IsError {
		t.Fatalf("full blocked: %+v", structured(t, r))
	}
}

func TestStepReadCursorRejectsMalformedScope(t *testing.T) {
	expected := stepCursor{UserID: testUserID, ProjectID: testProjectID, TaskID: testTargetID, View: "summary"}
	for _, raw := range []string{"!", strings.Repeat("a", 2049), encodeStepCursor(stepCursor{Schema: 1, Kind: "task-steps", UserID: testUserID, ProjectID: testProjectID, TaskID: testTargetID, View: "summary", Version: "9223372036854775808", Position: 0})} {
		_, _, err := decodeStepCursor(raw, expected)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("cursor error: %v", err)
		}
	}
}

func TestStepReadSnapshotFailureDoesNotClaimWriteOutcome(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := &failingStepReads{fakeStepReads: sampleStepReads(1, "step")}
	if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2025-11-25", "alice")
	args := readArgs()
	args["stepId"] = "00000000"
	result := readCall(t, client, "task_step_show", args)
	failure := object(t, structured(t, result)["error"])
	if !result.IsError || failure["code"] != "internal_error" {
		t.Fatalf("read failure: %+v", failure)
	}
	if _, present := failure["writeOutcome"]; present {
		t.Fatalf("read claimed a write result: %+v", failure)
	}
}

type failingStepReads struct{ *fakeStepReads }

func (*failingStepReads) GetSummary(context.Context, model.Principal, string, string, string) (taskservice.StepSummary, error) {
	return taskservice.StepSummary{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("snapshot commit failed")}
}

func TestRegisterToolRejectsInvalidBudgetClass(t *testing.T) {
	fixture := newEntryFixture(t)
	err := fixture.entry.RegisterTool(simpleTestTool("bad_budget", testObjectSchema(), testObjectSchema()), BudgetClass(255), func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		t.Fatal("invalid registration invoked handler")
		return ToolResult{}, nil
	})
	if err == nil {
		t.Fatal("invalid budget class was accepted")
	}
}
