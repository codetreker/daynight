package server

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (f *taskCredentialFixture) expectLifecycleUpdate(input taskcore.UpdateTask, result model.Task, finalError error) {
	input = copyTaskCredentialUpdate(input)
	result = copyTaskHTTPTask(result)
	f.tasks.UpdateCall = func(ctx context.Context, actor model.Principal, project, task string, actual taskcore.UpdateTask) (model.Task, error) {
		f.plan.Called("task-update")
		f.requireOperation(ctx, actor, project, task)
		if !reflect.DeepEqual(actual, input) {
			f.fail("Task PATCH input=%#v, want=%#v", actual, input)
		}
		return copyTaskHTTPTask(result), finalError
	}
}

func (f *taskCredentialFixture) expectLifecycleStatus(input taskcore.SetTaskStatus, result model.Task, finalError error) {
	input.ClaimID = copyTaskHTTPPointer(input.ClaimID)
	result = copyTaskHTTPTask(result)
	f.tasks.SetStatusCall = func(ctx context.Context, actor model.Principal, project, task string, actual taskcore.SetTaskStatus) (model.Task, error) {
		f.plan.Called("task-status")
		f.requireOperation(ctx, actor, project, task)
		if !reflect.DeepEqual(actual, input) {
			f.fail("Task status input=%#v, want=%#v", actual, input)
		}
		return copyTaskHTTPTask(result), finalError
	}
}

func copyTaskCredentialUpdate(input taskcore.UpdateTask) taskcore.UpdateTask {
	input.AssignedTo = copyTaskHTTPPointer(input.AssignedTo)
	if input.AssignedTo != nil {
		*input.AssignedTo = copyTaskHTTPPointer(*input.AssignedTo)
	}
	input.RequiredPlatform = copyTaskHTTPPointer(input.RequiredPlatform)
	if input.RequiredPlatform != nil {
		*input.RequiredPlatform = copyTaskHTTPPointer(*input.RequiredPlatform)
	}
	input.ExternalDependsOn = copyTaskHTTPPointer(input.ExternalDependsOn)
	if input.ExternalDependsOn != nil {
		*input.ExternalDependsOn = copyTaskHTTPSlice(*input.ExternalDependsOn)
	}
	input.DependsOn = copyTaskHTTPPointer(input.DependsOn)
	if input.DependsOn != nil {
		*input.DependsOn = copyTaskHTTPSlice(*input.DependsOn)
	}
	input.AllowAgents = copyTaskHTTPPointer(input.AllowAgents)
	input.Title, input.Description = copyTaskHTTPPointer(input.Title), copyTaskHTTPPointer(input.Description)
	input.Properties = copyTaskHTTPProperties(input.Properties)
	return input
}

func assertLifecycleTask(t *testing.T, actual api.Task, expected model.Task) {
	t.Helper()
	expected = copyTaskHTTPTask(expected)
	resource := api.Task{ID: expected.ID, ProjectID: expected.ProjectID, Title: expected.Title, Description: expected.Description, Properties: api.TaskProperties(expected.Properties), Status: string(expected.Status), Version: expected.Version, CreatedAt: expected.CreatedAt, UpdatedAt: expected.UpdatedAt, StartedAt: expected.StartedAt, CompletedAt: expected.CompletedAt, CancelledAt: expected.CancelledAt, DependsOn: expected.DependsOn, ExternalDependsOn: expected.ExternalDependsOn, BlockedBy: expected.BlockedBy, AssignedTo: expected.AssignedTo, AllowAgents: expected.AllowAgents, Ready: expected.Ready}
	if !reflect.DeepEqual(actual, resource) {
		t.Fatalf("lifecycle result=%#v want=%#v", actual, resource)
	}
}
