package task

import (
	"context"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type TaskService interface {
	Create(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error)
	Update(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error)
	ReplaceTags(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error)
	Delete(context.Context, model.Principal, string, string, taskcore.DeleteTask) error
	SetStatus(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error)
	Get(context.Context, model.Principal, string, string) (model.Task, error)
	Observe(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error)
	List(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error)
	Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error)
	Assignees(context.Context, model.Principal, string, taskservice.TaskAssigneesRequest) (model.TaskAssignees, error)
	SetProperty(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error)
	RemoveProperty(context.Context, model.Principal, string, string, string, int64) (model.Task, error)
	ClaimWorker(context.Context, model.Principal, string, string, taskcore.ClaimWorker) (model.Task, error)
	UpdateWorker(context.Context, model.Principal, string, string, taskcore.UpdateWorker) (model.Task, error)
	ReleaseWorker(context.Context, model.Principal, string, string, taskcore.ReleaseWorker) (model.Task, error)
	WithdrawWorker(context.Context, model.Principal, string, string, taskcore.WithdrawWorker) (model.Task, error)
}

type StepService interface {
	Get(context.Context, model.Principal, string, string, string) (taskservice.StepDocument, error)
	List(context.Context, model.Principal, string, string) (taskservice.StepsDocument, error)
	Add(context.Context, model.Principal, string, string, taskservice.AddTaskStep) (taskservice.StepsWriteResult, error)
	Update(context.Context, model.Principal, string, string, string, taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error)
	SetStatus(context.Context, model.Principal, string, string, string, taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error)
	Delete(context.Context, model.Principal, string, string, string, taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error)
	Move(context.Context, model.Principal, string, string, string, taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error)
}

type ThreadService interface {
	Post(context.Context, model.Principal, string, string, taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error)
	List(context.Context, model.Principal, string, string, taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error)
}

type SearchOperation func(context.Context, model.Principal, string, tasksearch.Request) (tasksearch.Page, error)

type SyncOperation func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error)

type RouteAuthentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}
