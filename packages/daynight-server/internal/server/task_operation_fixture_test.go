package server

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type taskHTTPOperations struct {
	t                  *testing.T
	CreateCall         func(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error)
	UpdateCall         func(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error)
	DeleteCall         func(context.Context, model.Principal, string, string, taskcore.DeleteTask) error
	SetStatusCall      func(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error)
	GetCall            func(context.Context, model.Principal, string, string) (model.Task, error)
	ObserveCall        func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error)
	ListCall           func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error)
	GraphCall          func(context.Context, model.Principal, string, string) (model.TaskGraph, error)
	AssigneesCall      func(context.Context, model.Principal, string, taskservice.TaskAssigneesRequest) (model.TaskAssignees, error)
	SetPropertyCall    func(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error)
	RemovePropertyCall func(context.Context, model.Principal, string, string, string, int64) (model.Task, error)
	ClaimWorkerCall    func(context.Context, model.Principal, string, string, taskcore.ClaimWorker) (model.Task, error)
	UpdateWorkerCall   func(context.Context, model.Principal, string, string, taskcore.UpdateWorker) (model.Task, error)
	ReleaseWorkerCall  func(context.Context, model.Principal, string, string, taskcore.ReleaseWorker) (model.Task, error)
	WithdrawWorkerCall func(context.Context, model.Principal, string, string, taskcore.WithdrawWorker) (model.Task, error)
	ResumeWorkerCall   func(context.Context, model.Principal, string, string, taskcore.ResumeWorker) (model.Task, error)
}

var _ taskhttp.TaskService = (*taskHTTPOperations)(nil)

func (m *taskHTTPOperations) Create(a0 context.Context, a1 model.Principal, a2 string, a3 taskcore.CreateTask) (model.Task, error) {
	if m.CreateCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.Create")
	}
	return m.CreateCall(a0, a1, a2, a3)
}

func (m *taskHTTPOperations) Update(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.UpdateTask) (model.Task, error) {
	if m.UpdateCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.Update")
	}
	return m.UpdateCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPOperations) Delete(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.DeleteTask) error {
	if m.DeleteCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.Delete")
	}
	return m.DeleteCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPOperations) SetStatus(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.SetTaskStatus) (model.Task, error) {
	if m.SetStatusCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.SetStatus")
	}
	return m.SetStatusCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPOperations) Get(a0 context.Context, a1 model.Principal, a2 string, a3 string) (model.Task, error) {
	if m.GetCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.Get")
	}
	return m.GetCall(a0, a1, a2, a3)
}

func (m *taskHTTPOperations) Observe(a0 context.Context, a1 model.Principal, a2 string, a3 string) (taskservice.TaskObservation, error) {
	if m.ObserveCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.Observe")
	}
	return m.ObserveCall(a0, a1, a2, a3)
}

func (m *taskHTTPOperations) List(a0 context.Context, a1 model.Principal, a2 string, a3 taskservice.TaskListRequest) (taskservice.TaskPage, error) {
	if m.ListCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.List")
	}
	return m.ListCall(a0, a1, a2, a3)
}

func (m *taskHTTPOperations) Graph(a0 context.Context, a1 model.Principal, a2 string, a3 string) (model.TaskGraph, error) {
	if m.GraphCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.Graph")
	}
	return m.GraphCall(a0, a1, a2, a3)
}

func (m *taskHTTPOperations) Assignees(a0 context.Context, a1 model.Principal, a2 string, a3 taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
	if m.AssigneesCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.Assignees")
	}
	return m.AssigneesCall(a0, a1, a2, a3)
}

func (m *taskHTTPOperations) SetProperty(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 int64) (model.Task, error) {
	if m.SetPropertyCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.SetProperty")
	}
	return m.SetPropertyCall(a0, a1, a2, a3, a4, a5, a6)
}

func (m *taskHTTPOperations) RemoveProperty(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 int64) (model.Task, error) {
	if m.RemovePropertyCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.RemoveProperty")
	}
	return m.RemovePropertyCall(a0, a1, a2, a3, a4, a5)
}

func (m *taskHTTPOperations) ClaimWorker(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.ClaimWorker) (model.Task, error) {
	if m.ClaimWorkerCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.ClaimWorker")
	}
	return m.ClaimWorkerCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPOperations) UpdateWorker(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.UpdateWorker) (model.Task, error) {
	if m.UpdateWorkerCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.UpdateWorker")
	}
	return m.UpdateWorkerCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPOperations) ReleaseWorker(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.ReleaseWorker) (model.Task, error) {
	if m.ReleaseWorkerCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.ReleaseWorker")
	}
	return m.ReleaseWorkerCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPOperations) WithdrawWorker(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.WithdrawWorker) (model.Task, error) {
	if m.WithdrawWorkerCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.WithdrawWorker")
	}
	return m.WithdrawWorkerCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPOperations) ResumeWorker(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskcore.ResumeWorker) (model.Task, error) {
	if m.ResumeWorkerCall == nil {
		unexpectedHTTPCall(m.t, "TaskService.ResumeWorker")
	}
	return m.ResumeWorkerCall(a0, a1, a2, a3, a4)
}

type taskHTTPStepOperations struct {
	t             *testing.T
	GetCall       func(context.Context, model.Principal, string, string, string) (taskservice.StepDocument, error)
	ListCall      func(context.Context, model.Principal, string, string) (taskservice.StepsDocument, error)
	AddCall       func(context.Context, model.Principal, string, string, taskservice.AddTaskStep) (taskservice.StepsWriteResult, error)
	UpdateCall    func(context.Context, model.Principal, string, string, string, taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error)
	SetStatusCall func(context.Context, model.Principal, string, string, string, taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error)
	DeleteCall    func(context.Context, model.Principal, string, string, string, taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error)
	MoveCall      func(context.Context, model.Principal, string, string, string, taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error)
}

var _ taskhttp.StepService = (*taskHTTPStepOperations)(nil)

func (m *taskHTTPStepOperations) Get(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (taskservice.StepDocument, error) {
	if m.GetCall == nil {
		unexpectedHTTPCall(m.t, "StepService.Get")
	}
	return m.GetCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPStepOperations) List(a0 context.Context, a1 model.Principal, a2 string, a3 string) (taskservice.StepsDocument, error) {
	if m.ListCall == nil {
		unexpectedHTTPCall(m.t, "StepService.List")
	}
	return m.ListCall(a0, a1, a2, a3)
}

func (m *taskHTTPStepOperations) Add(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	if m.AddCall == nil {
		unexpectedHTTPCall(m.t, "StepService.Add")
	}
	return m.AddCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPStepOperations) Update(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	if m.UpdateCall == nil {
		unexpectedHTTPCall(m.t, "StepService.Update")
	}
	return m.UpdateCall(a0, a1, a2, a3, a4, a5)
}

func (m *taskHTTPStepOperations) SetStatus(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	if m.SetStatusCall == nil {
		unexpectedHTTPCall(m.t, "StepService.SetStatus")
	}
	return m.SetStatusCall(a0, a1, a2, a3, a4, a5)
}

func (m *taskHTTPStepOperations) Delete(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	if m.DeleteCall == nil {
		unexpectedHTTPCall(m.t, "StepService.Delete")
	}
	return m.DeleteCall(a0, a1, a2, a3, a4, a5)
}

func (m *taskHTTPStepOperations) Move(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	if m.MoveCall == nil {
		unexpectedHTTPCall(m.t, "StepService.Move")
	}
	return m.MoveCall(a0, a1, a2, a3, a4, a5)
}

type taskHTTPThreadOperations struct {
	t        *testing.T
	PostCall func(context.Context, model.Principal, string, string, taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error)
	ListCall func(context.Context, model.Principal, string, string, taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error)
}

var _ taskhttp.ThreadService = (*taskHTTPThreadOperations)(nil)

func (m *taskHTTPThreadOperations) Post(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
	if m.PostCall == nil {
		unexpectedHTTPCall(m.t, "ThreadService.Post")
	}
	return m.PostCall(a0, a1, a2, a3, a4)
}

func (m *taskHTTPThreadOperations) List(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
	if m.ListCall == nil {
		unexpectedHTTPCall(m.t, "ThreadService.List")
	}
	return m.ListCall(a0, a1, a2, a3, a4)
}

type taskHTTPObservationOperations struct {
	t                *testing.T
	ObserveGetCall   func(context.Context, model.Principal, string, string) (taskservice.ObservedTask, error)
	ObserveListCall  func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.ObservedTaskPage, error)
	ObserveGraphCall func(context.Context, model.Principal, string, string) (taskservice.ObservedGraph, error)
	WorkListCall     func(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error)
}

var _ taskhttp.ObservationService = (*taskHTTPObservationOperations)(nil)

func (m *taskHTTPObservationOperations) ObserveGet(a0 context.Context, a1 model.Principal, a2 string, a3 string) (taskservice.ObservedTask, error) {
	if m.ObserveGetCall == nil {
		unexpectedHTTPCall(m.t, "ObservationService.ObserveGet")
	}
	return m.ObserveGetCall(a0, a1, a2, a3)
}

func (m *taskHTTPObservationOperations) ObserveList(a0 context.Context, a1 model.Principal, a2 string, a3 taskservice.TaskListRequest) (taskservice.ObservedTaskPage, error) {
	if m.ObserveListCall == nil {
		unexpectedHTTPCall(m.t, "ObservationService.ObserveList")
	}
	return m.ObserveListCall(a0, a1, a2, a3)
}

func (m *taskHTTPObservationOperations) ObserveGraph(a0 context.Context, a1 model.Principal, a2 string, a3 string) (taskservice.ObservedGraph, error) {
	if m.ObserveGraphCall == nil {
		unexpectedHTTPCall(m.t, "ObservationService.ObserveGraph")
	}
	return m.ObserveGraphCall(a0, a1, a2, a3)
}

func (m *taskHTTPObservationOperations) WorkList(a0 context.Context, a1 model.Principal, a2 string, a3 taskcore.WorkRequest) (taskwork.Page, error) {
	if m.WorkListCall == nil {
		unexpectedHTTPCall(m.t, "ObservationService.WorkList")
	}
	return m.WorkListCall(a0, a1, a2, a3)
}
