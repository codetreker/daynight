package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakeStepWriter struct {
	page          taskservice.StepsPage
	readErr       error
	result        taskservice.StepsWriteResult
	err           error
	reads, writes int
	version       int64
	id            string
	addInput      taskservice.AddTaskStep
	updateInput   taskservice.UpdateTaskStep
	statusInput   taskservice.SetTaskStepStatus
	moveInput     taskservice.MoveTaskStep
}

func (f *fakeStepWriter) ListPage(_ context.Context, _ model.Principal, _, _ string, after int64, limit int, expected *int64, summary bool) (taskservice.StepsPage, error) {
	f.reads++
	if after != -1 || limit != 1 || expected != nil || !summary {
		panic("unexpected version read")
	}
	return f.page, f.readErr
}
func (f *fakeStepWriter) Add(_ context.Context, _ model.Principal, _, _ string, in taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	f.writes++
	f.addInput = in
	f.version = in.Version
	f.id = in.ID
	return f.result, f.err
}
func (f *fakeStepWriter) Update(_ context.Context, _ model.Principal, _, _, id string, in taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	f.writes++
	f.id = id
	f.updateInput = in
	f.version = in.Version
	return f.result, f.err
}
func (f *fakeStepWriter) SetStatus(_ context.Context, _ model.Principal, _, _, id string, in taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	f.writes++
	f.id = id
	f.statusInput = in
	f.version = in.Version
	return f.result, f.err
}
func (f *fakeStepWriter) Move(_ context.Context, _ model.Principal, _, _, id string, in taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	f.writes++
	f.id = id
	f.moveInput = in
	f.version = in.Version
	return f.result, f.err
}
func (f *fakeStepWriter) Delete(_ context.Context, _ model.Principal, _, _, id string, in taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	f.writes++
	f.id = id
	f.version = in.Version
	return f.result, f.err
}

func stepWriteFixture() *fakeStepWriter {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return &fakeStepWriter{page: taskservice.StepsPage{Header: model.TaskHeader{Version: 9007199254740993}}, result: taskservice.StepsWriteResult{StepsDocument: taskservice.StepsDocument{Resource: taskcodec.StepsResource{ProjectID: testProjectID, TaskID: testTargetID, Version: 9007199254740994, Steps: []taskcodec.Step{{ID: "abcdef12", Title: "Hello", Description: "full text", Status: model.TaskStepDone, CreatedAt: now, UpdatedAt: now}}}}, Changed: true, TransactionOutcome: store.TransactionCommitted}}
}
func TestStepWriteVersionAndReceipts(t *testing.T) {
	f := stepWriteFixture()
	h := stepWriter{steps: f}
	base := stepWriteBase{ProjectID: testProjectID, TaskID: testTargetID}
	result, err := h.add(context.Background(), projectActor(), stepAddInput{stepWriteBase: base, ID: ptr("ABCDEF12"), Title: "Hello"})
	if err != nil || f.reads != 1 || f.writes != 1 || f.version != 9007199254740993 || f.id != "abcdef12" {
		t.Fatalf("add %+v %v, fake %+v", result, err, f)
	}
	data := result.Data.(map[string]any)
	if data["version"] != "9007199254740994" || data["stepId"] != "abcdef12" || data["changed"] != true || data["projection"] != "summary" || data["step"].(map[string]any)["position"] != 0 || result.Outcome != "changed" || result.WriteOutcome != "confirmed" {
		t.Fatalf("receipt %+v", result)
	}
	base.IfVersion = ptr("9007199254740992")
	base.ReturnView = "full"
	f.result.Changed = false
	result, err = h.update(context.Background(), projectActor(), stepUpdateInput{stepWriteBase: base, StepID: "abcdef12", Title: ptr("Hello")})
	if err != nil || f.reads != 1 || f.version != 9007199254740992 || result.Outcome != "unchanged" || result.Data.(map[string]any)["projection"] != "full" {
		t.Fatalf("update %+v %v", result, err)
	}
	base.IfVersion = ptr("9223372036854775808")
	_, err = h.delete(context.Background(), projectActor(), stepDeleteInput{stepWriteBase: base, StepID: "abcdef12"})
	if err == nil || f.writes != 2 {
		t.Fatalf("overflow: %v writes %d", err, f.writes)
	}
}
func TestStepWriteUnknownAndMissing(t *testing.T) {
	f := stepWriteFixture()
	h := stepWriter{steps: f}
	base := stepWriteBase{ProjectID: testProjectID, TaskID: testTargetID, IfVersion: ptr("4")}
	f.result = taskservice.StepsWriteResult{Phase: "commit", TransactionOutcome: store.TransactionUnknown, CleanupFailed: true}
	f.err = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("lost")}
	result, err := h.move(context.Background(), projectActor(), stepMoveInput{stepWriteBase: base, StepID: "abcdef12", Position: ptr("last")})
	if err == nil || result.WriteOutcome != "unknown" || result.Phase != "commit" || result.Refs["stepId"] != "abcdef12" {
		t.Fatalf("result %+v %v", result, err)
	}
	f.result = taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	f.err = tasksteps.NotFound(9007199254740993, model.ErrNotFound)
	result, err = h.delete(context.Background(), projectActor(), stepDeleteInput{stepWriteBase: base, StepID: "abcdef12"})
	if err == nil || result.Refs["version"] != "9007199254740993" || result.WriteOutcome != "not_committed" {
		t.Fatalf("absence %+v %v", result, err)
	}
	f.err = nil
	f.result = stepWriteFixture().result
	f.result.Resource.Steps = []taskcodec.Step{}
	result, err = h.delete(context.Background(), projectActor(), stepDeleteInput{stepWriteBase: stepWriteBase{ProjectID: testProjectID, TaskID: testTargetID, IfVersion: ptr("4"), ReturnView: "full"}, StepID: "abcdef12"})
	if err != nil || len(result.Data.(map[string]any)["steps"].([]taskcodec.Step)) != 0 {
		t.Fatalf("empty %+v %v", result, err)
	}
	result, err = h.delete(context.Background(), projectActor(), stepDeleteInput{stepWriteBase: base, StepID: "abcdef12"})
	if err != nil || len(result.Data.(map[string]any)["steps"].([]taskcodec.Step)) != 0 {
		t.Fatalf("empty summary %+v %v", result, err)
	}
}

func TestStepWriteSummaryIsBoundedAndMarksTruncation(t *testing.T) {
	f := stepWriteFixture()
	f.result.Resource.Steps[0].Title = strings.Repeat("\n", 10000)
	f.result.Resource.Steps[0].Description = strings.Repeat("x", 100000)
	result, err := stepWriteResponse(stepWriteBase{}, "abcdef12", f.result, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(envelope{Data: result.Data, Meta: &envelopeMeta{RequestID: "test-request", Outcome: result.Outcome}})
	step := result.Data.(map[string]any)["step"].(map[string]any)
	if err != nil || len(encoded) > 16<<10 || step["titleTruncated"] != true || len(step["titlePreview"].(string)) != titlePreviewBytes {
		t.Fatalf("summary size=%d step=%+v err=%v", len(encoded), step, err)
	}
}

func TestStepWriteCapacityErrorDetailsAndCleanupFailure(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := stepWriteFixture()
	if err := RegisterStepWriteTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	limit := &model.Fault{Code: "steps_limit_exceeded", Message: "Task steps exceed the encoded resource limit.", StepsLimit: &model.StepsLimitDetails{EncodedBytes: 9007199254740993, MaxEncodedBytes: taskcodec.MaxEncodedBytes}}
	ops.result = taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "stepId": "abcdef12", "title": "new", "ifVersion": "4"}
	call := func() map[string]any {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "task_step_update", Arguments: args})
		if err != nil || !result.IsError {
			t.Fatalf("expected error: %+v %v", result, err)
		}
		return object(t, structured(t, result)["error"])
	}
	ops.err = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: limit}
	failure := call()
	refs := object(t, failure["refs"])
	if failure["code"] != "steps_limit_exceeded" || failure["writeOutcome"] != "not_committed" || refs["encodedBytes"] != "9007199254740993" || refs["maxEncodedBytes"] != "67108864" {
		t.Fatalf("capacity rejection: %+v", failure)
	}
	ops.result.CleanupFailed = true
	ops.err = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: limit}
	failure = call()
	refs = object(t, failure["refs"])
	if failure["code"] != "internal_error" || refs["encodedBytes"] != nil || refs["maxEncodedBytes"] != nil {
		t.Fatalf("unsafe cleanup details leaked: %+v", failure)
	}
}

func TestStepBusinessBodyLimit(t *testing.T) {
	fields := map[string]string{"id": "abcdef12", "title": "<>&\u2028\n\x01"}
	if got := stepBusinessBodySize(1, fields); got != len(`{"version":1,"id":"abcdef12","title":"<>&`)+3+len(`\n\u0001"}`) {
		t.Fatalf("size %d", got)
	}
	fields["title"] = ""
	overhead := stepBusinessBodySize(1, fields)
	fields["title"] = strings.Repeat("a", httpx.MaxJSONBody-overhead)
	if err := stepCheckBody(1, fields); err != nil {
		t.Fatalf("boundary %v", err)
	}
	fields["title"] += "a"
	if err := stepCheckBody(1, fields); err == nil {
		t.Fatal("over limit accepted")
	}
}
func TestStepWriteToolDiscoveryAndValidation(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := stepWriteFixture()
	if err := RegisterStepWriteTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := client.ListTools(ctx, nil)
	if err != nil || len(list.Tools) != 6 {
		t.Fatalf("listing %+v %v", list, err)
	}
	call := func(name string, args map[string]any) *sdk.CallToolResult {
		t.Helper()
		r, e := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	base := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "stepId": "abcdef12", "ifVersion": "4"}
	for _, status := range []string{"todo", "in_progress", "done", "skipped"} {
		args := map[string]any{}
		for k, v := range base {
			args[k] = v
		}
		args["status"] = status
		r := call("task_step_set_status", args)
		if r.IsError || string(ops.statusInput.Status) != status {
			t.Fatalf("status %s %+v", status, r)
		}
	}
	for _, args := range []map[string]any{{"projectId": testProjectID, "taskId": testTargetID, "stepId": "abcdef12"}, {"projectId": testProjectID, "taskId": testTargetID, "stepId": "abcdef12", "before": "abcdef12", "position": "last"}} {
		r := call("task_step_move", args)
		if !r.IsError {
			t.Fatalf("invalid move %+v", r)
		}
	}
	r := call("task_step_update", base)
	if !r.IsError {
		t.Fatalf("empty update %+v", r)
	}
	r = call("task_step_add", map[string]any{"projectId": testProjectID, "taskId": testTargetID, "title": "x", "ifVersion": "4"})
	if r.IsError || len(ops.id) != 8 {
		t.Fatalf("generated id %q %+v", ops.id, r)
	}
}

func TestStepWriteRegistrationRejectsCorruptOrIncompleteDefinitions(t *testing.T) {
	original := stepWriteToolsJSON
	t.Cleanup(func() { stepWriteToolsJSON = original })
	fixture := newEntryFixture(t)
	stepWriteToolsJSON = []byte("[")
	if err := RegisterStepWriteTools(fixture.entry, stepWriteFixture()); err == nil {
		t.Fatal("corrupt tool definitions accepted")
	}
	var definitions []map[string]any
	if err := json.Unmarshal(original, &definitions); err != nil {
		t.Fatal(err)
	}
	for _, missing := range []string{"task_step_add", "task_step_update", "task_step_set_status", "task_step_move", "task_step_delete"} {
		t.Run(missing, func(t *testing.T) {
			filtered := make([]map[string]any, 0, len(definitions)-1)
			for _, definition := range definitions {
				if definition["name"] != missing {
					filtered = append(filtered, definition)
				}
			}
			var err error
			stepWriteToolsJSON, err = json.Marshal(filtered)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newEntryFixture(t)
			if err := RegisterStepWriteTools(fixture.entry, stepWriteFixture()); err == nil {
				t.Fatalf("missing %s accepted", missing)
			}
		})
	}
}

func TestStepStatusDoesNotWriteWhenVersionReadFails(t *testing.T) {
	failed := &model.Fault{Code: "not_found", Message: "Task was not found."}
	ops := stepWriteFixture()
	ops.readErr = failed
	h := stepWriter{steps: ops}
	result, err := h.status(context.Background(), projectActor(), stepStatusInput{stepWriteBase: stepWriteBase{ProjectID: testProjectID, TaskID: testTargetID}, StepID: "abcdef12", Status: model.TaskStepDone})
	if !errors.Is(err, failed) || ops.reads != 1 || ops.writes != 0 || result.WriteOutcome != "not_committed" || result.Phase != "prepare" || result.Refs["stepId"] != "abcdef12" {
		t.Fatalf("version read: %+v %v, reads=%d writes=%d", result, err, ops.reads, ops.writes)
	}
}
