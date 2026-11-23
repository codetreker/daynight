package mcp

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type inputTaskOperations struct {
	t      *testing.T
	update func(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error)
}

func (operations *inputTaskOperations) Create(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 taskcore.CreateTask) (model.Task, error) {
	operations.t.Error("unexpected Task Create")
	var zero model.Task
	return zero, errors.New("unexpected Task Create")
}

func (operations *inputTaskOperations) Update(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.UpdateTask) (model.Task, error) {
	return operations.update(arg0, arg1, arg2, arg3, arg4)
}

func (operations *inputTaskOperations) ReplaceTags(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error) {
	operations.t.Error("unexpected Task ReplaceTags")
	return model.Task{}, errors.New("unexpected Task ReplaceTags")
}

func (operations *inputTaskOperations) Delete(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.DeleteTask) error {
	operations.t.Error("unexpected Task Delete")
	return errors.New("unexpected Task Delete")
}

func (operations *inputTaskOperations) SetStatus(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.SetTaskStatus) (model.Task, error) {
	operations.t.Error("unexpected Task SetStatus")
	var zero model.Task
	return zero, errors.New("unexpected Task SetStatus")
}

func (operations *inputTaskOperations) Get(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string) (model.Task, error) {
	operations.t.Error("unexpected Task Get")
	var zero model.Task
	return zero, errors.New("unexpected Task Get")
}

func (operations *inputTaskOperations) Observe(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string) (taskservice.TaskObservation, error) {
	operations.t.Error("unexpected Task Observe")
	var zero taskservice.TaskObservation
	return zero, errors.New("unexpected Task Observe")
}

func (operations *inputTaskOperations) List(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 taskservice.TaskListRequest) (taskservice.TaskPage, error) {
	operations.t.Error("unexpected Task List")
	var zero taskservice.TaskPage
	return zero, errors.New("unexpected Task List")
}

func (operations *inputTaskOperations) Graph(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string) (model.TaskGraph, error) {
	operations.t.Error("unexpected Task Graph")
	var zero model.TaskGraph
	return zero, errors.New("unexpected Task Graph")
}

func (operations *inputTaskOperations) Assignees(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
	operations.t.Error("unexpected Task Assignees")
	var zero model.TaskAssignees
	return zero, errors.New("unexpected Task Assignees")
}

func (operations *inputTaskOperations) SetProperty(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 string, arg6 int64) (model.Task, error) {
	operations.t.Error("unexpected Task SetProperty")
	var zero model.Task
	return zero, errors.New("unexpected Task SetProperty")
}

func (operations *inputTaskOperations) RemoveProperty(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 int64) (model.Task, error) {
	operations.t.Error("unexpected Task RemoveProperty")
	var zero model.Task
	return zero, errors.New("unexpected Task RemoveProperty")
}

func (operations *inputTaskOperations) ClaimWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.ClaimWorker) (model.Task, error) {
	operations.t.Error("unexpected Task ClaimWorker")
	var zero model.Task
	return zero, errors.New("unexpected Task ClaimWorker")
}

func (operations *inputTaskOperations) UpdateWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.UpdateWorker) (model.Task, error) {
	operations.t.Error("unexpected Task UpdateWorker")
	var zero model.Task
	return zero, errors.New("unexpected Task UpdateWorker")
}

func (operations *inputTaskOperations) ReleaseWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.ReleaseWorker) (model.Task, error) {
	operations.t.Error("unexpected Task ReleaseWorker")
	var zero model.Task
	return zero, errors.New("unexpected Task ReleaseWorker")
}

func (operations *inputTaskOperations) WithdrawWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.WithdrawWorker) (model.Task, error) {
	operations.t.Error("unexpected Task WithdrawWorker")
	var zero model.Task
	return zero, errors.New("unexpected Task WithdrawWorker")
}
