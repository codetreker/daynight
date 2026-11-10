package server

import (
	"context"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

const taskHTTPEpoch = "88888888-8888-4888-8888-888888888888"

func copyTaskHTTPPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func copyTaskHTTPSlice[T any](values []T) []T {
	if values == nil {
		return nil
	}
	result := make([]T, len(values))
	copy(result, values)
	return result
}

func copyTaskHTTPProperties(values model.TaskProperties) model.TaskProperties {
	if values == nil {
		return nil
	}
	result := make(model.TaskProperties, len(values))
	for name, raw := range values {
		result[name] = copyTaskHTTPSlice(raw)
	}
	return result
}

func copyTaskHTTPTask(row model.Task) model.Task {
	row.Properties = copyTaskHTTPProperties(row.Properties)
	row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
	row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
	row.BlockedBy = copyTaskHTTPSlice(row.BlockedBy)
	row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
	row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
	row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
	row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
	row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	return row
}

func copyTaskHTTPRows(rows []model.Task) []model.Task {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		result[index] = copyTaskHTTPTask(rows[index])
	}
	return result
}

func copyTaskHTTPGraphRows(rows []model.GraphTask) []model.GraphTask {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
		row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
		row.BlockedBy = copyTaskHTTPSlice(row.BlockedBy)
		row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
		row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
		row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
		row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
		row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	}
	return result
}

func copyTaskHTTPSyncRows(rows []model.TaskViewRecord) []model.TaskViewRecord {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.Properties = copyTaskHTTPProperties(row.Properties)
		row.Properties = copyTaskHTTPProperties(row.Properties)
		row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
		row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
		row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
		row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
		row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
		row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
		row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	}
	return result
}

type taskHTTPFixture struct {
	t            *testing.T
	tasks        *taskHTTPOperations
	projects     *projectHTTPOperations
	memberships  *projectHTTPMembershipOperations
	observations *taskHTTPObservationOperations
	steps        *taskHTTPStepOperations
	threads      *taskHTTPThreadOperations
	handler      *resourceTestHandler
	project      model.Project
	target       model.Task
	principal    model.Principal
	observed     time.Time
	syncCall     func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error)
}

const taskHTTPAdminProfileVersion = "c554c9691e1e5ad076b8c86c361ac25469470abf9bae8fc7d540c2e41bf60dee"

func newTaskHTTPFixture(t *testing.T) *taskHTTPFixture {
	return newTaskHTTPFixtureForPrincipal(t, defaultHTTPPrincipal())
}

func newTaskHTTPFixtureForPrincipal(t *testing.T, principal model.Principal) *taskHTTPFixture {
	t.Helper()
	project, target, _ := taskHTTPMockModels()
	f := &taskHTTPFixture{t: t, tasks: &taskHTTPOperations{t: t}, projects: &projectHTTPOperations{t: t}, memberships: &projectHTTPMembershipOperations{t: t}, observations: &taskHTTPObservationOperations{t: t}, steps: &taskHTTPStepOperations{t: t}, threads: &taskHTTPThreadOperations{t: t}, project: project, target: target, principal: principal, observed: project.UpdatedAt.Add(time.Minute)}
	f.handler = newOperationHTTPServer(t, func(deps *httpDependencies) {
		deps.Tasks, deps.TaskObservations, deps.TaskSteps, deps.TaskThreads = f.tasks, f.observations, f.steps, f.threads
		deps.Projects, deps.Memberships = f.projects, f.memberships
		deps.TaskSync = func(ctx context.Context, p model.Principal, pid string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
			if f.syncCall == nil {
				unexpectedHTTPCall(t, "TaskSync")
			}
			return f.syncCall(ctx, p, pid, input)
		}
	}, io.Discard, principal)
	return f
}

func (f *taskHTTPFixture) requireOperation(ctx context.Context, principal model.Principal, projectID string) {
	f.t.Helper()
	requireOperationHTTPContext(f.t, ctx)
	if principal != f.principal || projectID != f.project.ID {
		f.t.Errorf("Task operation changed principal or project: principal=%#v project=%q", principal, projectID)
		panic("invalid Task HTTP operation")
	}
}

func (f *taskHTTPFixture) expectRead(target model.Task) {
	f.t.Helper()
	target = copyTaskHTTPTask(target)
	calls := projectHTTPCount(f.t, 1)
	f.tasks.ObserveCall = func(ctx context.Context, principal model.Principal, pid, id string) (taskservice.TaskObservation, error) {
		calls()
		f.requireOperation(ctx, principal, pid)
		projectHTTPCheck(f.t, id, target.ID)
		return taskservice.TaskObservation{Task: copyTaskHTTPTask(target), Epoch: taskHTTPEpoch}, nil
	}
}

func cloneTaskHTTPListRequest(input taskservice.TaskListRequest) taskservice.TaskListRequest {
	input.AssignedTo = copyTaskHTTPPointer(input.AssignedTo)
	input.Cursor = copyTaskHTTPPointer(input.Cursor)
	input.Status = copyTaskHTTPPointer(input.Status)
	input.Ready = copyTaskHTTPPointer(input.Ready)
	input.AllowAgents = copyTaskHTTPPointer(input.AllowAgents)
	input.CompatiblePlatform = copyTaskHTTPPointer(input.CompatiblePlatform)
	input.PlatformSpecific = copyTaskHTTPPointer(input.PlatformSpecific)
	input.WorkerID = copyTaskHTTPPointer(input.WorkerID)
	return input
}

func (f *taskHTTPFixture) expectListRequest(want taskservice.TaskListRequest, result taskservice.TaskPage, err error) {
	f.t.Helper()
	want = cloneTaskHTTPListRequest(want)
	result.Items = copyTaskHTTPRows(result.Items)
	result.NextCursor = copyTaskHTTPPointer(result.NextCursor)
	calls := projectHTTPCount(f.t, 1)
	f.tasks.ListCall = func(ctx context.Context, principal model.Principal, pid string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		calls()
		f.requireOperation(ctx, principal, pid)
		projectHTTPCheck(f.t, input, want)
		return taskservice.TaskPage{Items: copyTaskHTTPRows(result.Items), NextCursor: copyTaskHTTPPointer(result.NextCursor)}, err
	}
}

func (f *taskHTTPFixture) expectGraph(root string, rows []model.GraphTask, summary model.TaskGraphSummary) {
	f.t.Helper()
	rows = copyTaskHTTPGraphRows(rows)
	project, observed := f.project, f.observed
	calls := projectHTTPCount(f.t, 1)
	f.tasks.GraphCall = func(ctx context.Context, principal model.Principal, pid, id string) (model.TaskGraph, error) {
		calls()
		f.requireOperation(ctx, principal, pid)
		projectHTTPCheck(f.t, id, root)
		return model.TaskGraph{Project: project, ObservedAt: observed, Tasks: copyTaskHTTPGraphRows(rows), Summary: summary}, nil
	}
}

func cloneTaskHTTPSync(result model.TaskSync) model.TaskSync {
	result.Tasks = copyTaskHTTPSyncRows(result.Tasks)
	for i := range result.Tasks {
		result.Tasks[i].Properties = copyTaskHTTPProperties(result.Tasks[i].Properties)
	}
	result.ActorAccess = projectHTTPCopyAccess(result.ActorAccess)
	result.AssigneeVersions = copyTaskHTTPSlice(result.AssigneeVersions)
	if result.Sessions != nil {
		sessions := make(map[string]model.SessionListState, len(result.Sessions))
		for id, state := range result.Sessions {
			sessions[id] = state
		}
		result.Sessions = sessions
	}
	return result
}

func (f *taskHTTPFixture) expectSync(rows []model.TaskViewRecord, versions []model.TaskAssigneeVersion, lower *time.Time) {
	f.t.Helper()
	want := taskservice.TaskSyncRequest{}
	mode := "snapshot"
	if lower != nil {
		since := lower.Add(10 * time.Second)
		want = taskservice.TaskSyncRequest{Epoch: taskHTTPEpoch, Since: &since}
		mode = "delta"
	}
	result := cloneTaskHTTPSync(model.TaskSync{Mode: mode, Epoch: taskHTTPEpoch, Project: f.project, ActorAccess: taskHTTPMockAccess(f.project, f.principal), ObservedAt: f.observed, Tasks: rows, AssigneeVersions: versions, Sessions: map[string]model.SessionListState{}})
	f.expectSyncRequest(want, result, nil)
}

func (f *taskHTTPFixture) expectSyncRequest(want taskservice.TaskSyncRequest, result model.TaskSync, err error) {
	f.t.Helper()
	want.Since = copyTaskHTTPPointer(want.Since)
	result = cloneTaskHTTPSync(result)
	calls := projectHTTPCount(f.t, 1)
	f.syncCall = func(ctx context.Context, principal model.Principal, pid string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
		calls()
		f.requireOperation(ctx, principal, pid)
		if !reflect.DeepEqual(input, want) {
			f.t.Errorf("TaskSync input=%#v want=%#v", input, want)
			panic("unexpected TaskSync input")
		}
		return cloneTaskHTTPSync(result), err
	}
}
