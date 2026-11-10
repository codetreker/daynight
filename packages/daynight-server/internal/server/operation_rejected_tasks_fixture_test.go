package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"testing"
)

type operationRejectedTasks struct{ t *testing.T }

func (r *operationRejectedTasks) Create(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.Create call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.Create")
}

func (r *operationRejectedTasks) Update(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.Update call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.Update")
}

func (r *operationRejectedTasks) Delete(context.Context, model.Principal, string, string, taskcore.DeleteTask) error {
	r.t.Errorf("unexpected Tasks.Delete call")
	return errors.New("unexpected Tasks.Delete")
}

func (r *operationRejectedTasks) SetStatus(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.SetStatus call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.SetStatus")
}

func (r *operationRejectedTasks) Get(context.Context, model.Principal, string, string) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.Get call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.Get")
}

func (r *operationRejectedTasks) Observe(context.Context, model.Principal, string, string) (task.TaskObservation, error) {
	r.t.Errorf("unexpected Tasks.Observe call")
	var result0 task.TaskObservation
	return result0, errors.New("unexpected Tasks.Observe")
}

func (r *operationRejectedTasks) List(context.Context, model.Principal, string, task.TaskListRequest) (task.TaskPage, error) {
	r.t.Errorf("unexpected Tasks.List call")
	var result0 task.TaskPage
	return result0, errors.New("unexpected Tasks.List")
}

func (r *operationRejectedTasks) Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error) {
	r.t.Errorf("unexpected Tasks.Graph call")
	var result0 model.TaskGraph
	return result0, errors.New("unexpected Tasks.Graph")
}

func (r *operationRejectedTasks) Assignees(context.Context, model.Principal, string, task.TaskAssigneesRequest) (model.TaskAssignees, error) {
	r.t.Errorf("unexpected Tasks.Assignees call")
	var result0 model.TaskAssignees
	return result0, errors.New("unexpected Tasks.Assignees")
}

func (r *operationRejectedTasks) SetProperty(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.SetProperty call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.SetProperty")
}

func (r *operationRejectedTasks) RemoveProperty(context.Context, model.Principal, string, string, string, int64) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.RemoveProperty call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.RemoveProperty")
}

func (r *operationRejectedTasks) ClaimWorker(context.Context, model.Principal, string, string, taskcore.ClaimWorker) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.ClaimWorker call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.ClaimWorker")
}

func (r *operationRejectedTasks) UpdateWorker(context.Context, model.Principal, string, string, taskcore.UpdateWorker) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.UpdateWorker call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.UpdateWorker")
}

func (r *operationRejectedTasks) ReleaseWorker(context.Context, model.Principal, string, string, taskcore.ReleaseWorker) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.ReleaseWorker call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.ReleaseWorker")
}

func (r *operationRejectedTasks) WithdrawWorker(context.Context, model.Principal, string, string, taskcore.WithdrawWorker) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.WithdrawWorker call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.WithdrawWorker")
}

func (r *operationRejectedTasks) ResumeWorker(context.Context, model.Principal, string, string, taskcore.ResumeWorker) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.ResumeWorker call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.ResumeWorker")
}

func (r *operationRejectedTasks) UpdatePartitionedDependencies(context.Context, model.Principal, string, string, taskcore.UpdateTask, *[]string, *[]string) (model.Task, error) {
	r.t.Errorf("unexpected Tasks.UpdatePartitionedDependencies call")
	var result0 model.Task
	return result0, errors.New("unexpected Tasks.UpdatePartitionedDependencies")
}

func (r *operationRejectedTasks) MCPReady(context.Context, model.Principal, string, taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	r.t.Errorf("unexpected Tasks.MCPReady call")
	var result0 []store.TaskPriorityItem
	return result0, errors.New("unexpected Tasks.MCPReady")
}
