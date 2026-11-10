package server

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/google/uuid"
)

func platformHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("Task HTTP operation value: got %#v, want %#v", actual, expected)
		panic("Task HTTP operation contract violated")
	}
}

func platformHTTPAPI(task model.Task) api.Task {
	task = copyTaskHTTPTask(task)
	var platform *string
	if task.RequiredPlatform != nil {
		value := string(*task.RequiredPlatform)
		platform = &value
	}
	return api.Task{ID: task.ID, ProjectID: task.ProjectID, Title: task.Title, Description: task.Description,
		Status: string(task.Status), Properties: api.TaskProperties(task.Properties), Version: task.Version,
		CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt, StartedAt: task.StartedAt, CompletedAt: task.CompletedAt, CancelledAt: task.CancelledAt,
		DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn, BlockedBy: task.BlockedBy,
		RequiredPlatform: platform, AssignedTo: task.AssignedTo, AllowAgents: task.AllowAgents, Ready: task.Ready}
}

func platformHTTPResult(before model.Task, after model.Task) model.Task {
	after = copyTaskHTTPTask(after)
	after.Version = before.Version + 1
	after.UpdatedAt = before.UpdatedAt.Add(time.Microsecond)
	after.Ready = after.Status == model.TaskTodo
	return after
}

func copyMutationHTTPCreate(input taskcore.CreateTask) taskcore.CreateTask {
	input.Status = copyTaskHTTPPointer(input.Status)
	input.AssignedTo = copyTaskHTTPPointer(input.AssignedTo)
	input.RequiredPlatform = copyTaskHTTPPointer(input.RequiredPlatform)
	input.DependsOn = copyTaskHTTPSlice(input.DependsOn)
	input.ExternalDependsOn = copyTaskHTTPSlice(input.ExternalDependsOn)
	input.Properties = copyTaskHTTPProperties(input.Properties)
	return input
}
func copyMutationHTTPUpdate(input taskcore.UpdateTask) taskcore.UpdateTask {
	if input.AssignedTo != nil {
		value := copyTaskHTTPPointer(*input.AssignedTo)
		input.AssignedTo = &value
	}
	if input.RequiredPlatform != nil {
		value := copyTaskHTTPPointer(*input.RequiredPlatform)
		input.RequiredPlatform = &value
	}
	if input.DependsOn != nil {
		value := copyTaskHTTPSlice(*input.DependsOn)
		input.DependsOn = &value
	}
	if input.ExternalDependsOn != nil {
		value := copyTaskHTTPSlice(*input.ExternalDependsOn)
		input.ExternalDependsOn = &value
	}
	input.AllowAgents = copyTaskHTTPPointer(input.AllowAgents)
	input.Title = copyTaskHTTPPointer(input.Title)
	input.Description = copyTaskHTTPPointer(input.Description)
	if input.Properties != nil {
		properties := make(model.TaskPropertiesPatch, len(input.Properties))
		for key, raw := range input.Properties {
			properties[key] = copyTaskHTTPSlice(raw)
		}
		input.Properties = properties
	}
	return input
}
func expectMutationHTTPCreate(f *taskHTTPFixture, input taskcore.CreateTask, result model.Task, resultError error) *model.Task {
	f.t.Helper()
	want := copyMutationHTTPCreate(input)
	supplied := copyTaskHTTPTask(result)
	if resultError == nil {
		supplied.ID = uuid.NewString()
	}
	expected := copyTaskHTTPTask(supplied)
	called := projectHTTPCount(f.t, 1)
	f.tasks.CreateCall = func(ctx context.Context, actor model.Principal, project string, actual taskcore.CreateTask) (model.Task, error) {
		called()
		f.requireOperation(ctx, actor, project)
		platformHTTPCheck(f.t, actual, want)
		return copyTaskHTTPTask(supplied), resultError
	}
	return &expected
}
func expectMutationHTTPUpdate(f *taskHTTPFixture, id string, input taskcore.UpdateTask, result model.Task, resultError error) {
	f.t.Helper()
	want, supplied := copyMutationHTTPUpdate(input), copyTaskHTTPTask(result)
	called := projectHTTPCount(f.t, 1)
	f.tasks.UpdateCall = func(ctx context.Context, actor model.Principal, project, target string, actual taskcore.UpdateTask) (model.Task, error) {
		called()
		f.requireOperation(ctx, actor, project)
		platformHTTPCheck(f.t, target, id)
		platformHTTPCheck(f.t, actual, want)
		return copyTaskHTTPTask(supplied), resultError
	}
}
func expectMutationHTTPStatus(f *taskHTTPFixture, id string, input taskcore.SetTaskStatus, result model.Task, resultError error) {
	f.t.Helper()
	want := input
	want.ClaimID = copyTaskHTTPPointer(input.ClaimID)
	supplied := copyTaskHTTPTask(result)
	called := projectHTTPCount(f.t, 1)
	f.tasks.SetStatusCall = func(ctx context.Context, actor model.Principal, project, target string, actual taskcore.SetTaskStatus) (model.Task, error) {
		called()
		f.requireOperation(ctx, actor, project)
		platformHTTPCheck(f.t, target, id)
		platformHTTPCheck(f.t, actual, want)
		return copyTaskHTTPTask(supplied), resultError
	}
}
func mutationHTTPFault(code string) error {
	return &model.Fault{Code: code, Message: "Task operation refused."}
}
func clearMutationHTTPOperations(f *taskHTTPFixture) {
	f.tasks.CreateCall, f.tasks.UpdateCall, f.tasks.SetStatusCall, f.tasks.ListCall = nil, nil, nil, nil
}

func platformHTTPStatus(f *taskHTTPFixture, before model.Task, to model.TaskStatus) model.Task {
	f.t.Helper()
	before = copyTaskHTTPTask(before)
	after := copyTaskHTTPTask(before)
	if before.Status != to {
		after.Status = to
		after = platformHTTPResult(before, after)
		switch to {
		case model.TaskTodo:
			after.StartedAt, after.CompletedAt = nil, nil
		case model.TaskInProgress:
			after.StartedAt, after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt), nil
		case model.TaskDone:
			after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt)
		}
	}
	expectMutationHTTPStatus(f, before.ID, taskcore.SetTaskStatus{Version: before.Version, Status: to}, after, nil)
	got := setHTTPTask(f.t, f.handler, platformHTTPAPI(before), string(to))
	platformHTTPCheck(f.t, got, platformHTTPAPI(after))
	return after
}
func platformHTTPProjection(row model.Task) model.GraphTask {
	row = copyTaskHTTPTask(row)
	return model.GraphTask{ID: row.ID, TitlePreview: row.Title, Status: row.Status, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy,
		AllowAgents: row.AllowAgents, RequiredPlatform: row.RequiredPlatform, AssignedTo: row.AssignedTo, Ready: row.Ready,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt}
}
