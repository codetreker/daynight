package task_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

var errUnexpectedServiceCall = errors.New("unexpected service call")

type serviceCalls struct {
	t        *testing.T
	mu       sync.Mutex
	calls    map[string]int
	expected map[string]int
	required func() []string
}

func newServiceCalls(t *testing.T) *serviceCalls {
	t.Helper()
	calls := &serviceCalls{t: t, calls: map[string]int{}, expected: map[string]int{}}
	t.Cleanup(func() {
		calls.mu.Lock()
		defer calls.mu.Unlock()
		expectedCalls := map[string]int{}
		if calls.required != nil {
			for _, method := range calls.required() {
				expectedCalls[method] = 1
			}
		}
		for method, expected := range calls.expected {
			expectedCalls[method] = expected
		}
		for method, expected := range expectedCalls {
			if actual := calls.calls[method]; actual != expected {
				t.Errorf("%s calls = %d, want %d", method, actual, expected)
			}
		}
	})
	return calls
}

func (calls *serviceCalls) ExpectCalls(method string, count int) {
	calls.t.Helper()
	if count < 0 {
		calls.t.Fatal("expected service call count cannot be negative")
	}
	calls.mu.Lock()
	defer calls.mu.Unlock()
	calls.expected[method] = count
}

func (calls *serviceCalls) Calls(method string) int {
	calls.mu.Lock()
	defer calls.mu.Unlock()
	return calls.calls[method]
}

func (calls *serviceCalls) TotalCalls() int {
	calls.mu.Lock()
	defer calls.mu.Unlock()
	total := 0
	for _, count := range calls.calls {
		total += count
	}
	return total
}

func (calls *serviceCalls) check(method string, configured bool) error {
	calls.t.Helper()
	calls.mu.Lock()
	calls.calls[method]++
	actual := calls.calls[method]
	expected, explicit := calls.expected[method]
	if !explicit {
		expected = 1
	}
	calls.mu.Unlock()
	if !configured || actual > expected {
		calls.t.Errorf("unexpected %s call: configured=%t, calls=%d, allowed=%d", method, configured, actual, expected)
		return errUnexpectedServiceCall
	}
	return nil
}

var _ taskhttp.TaskService = (*taskServiceMock)(nil)

type taskServiceMock struct {
	*serviceCalls
	CreateFunc         func(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error)
	UpdateFunc         func(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error)
	ReplaceTagsFunc    func(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error)
	DeleteFunc         func(context.Context, model.Principal, string, string, taskcore.DeleteTask) error
	SetStatusFunc      func(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error)
	GetFunc            func(context.Context, model.Principal, string, string) (model.Task, error)
	ObserveFunc        func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error)
	ListFunc           func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error)
	GraphFunc          func(context.Context, model.Principal, string, string) (model.TaskGraph, error)
	AssigneesFunc      func(context.Context, model.Principal, string, taskservice.TaskAssigneesRequest) (model.TaskAssignees, error)
	SetPropertyFunc    func(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error)
	RemovePropertyFunc func(context.Context, model.Principal, string, string, string, int64) (model.Task, error)
	ClaimWorkerFunc    func(context.Context, model.Principal, string, string, taskcore.ClaimWorker) (model.Task, error)
	UpdateWorkerFunc   func(context.Context, model.Principal, string, string, taskcore.UpdateWorker) (model.Task, error)
	ReleaseWorkerFunc  func(context.Context, model.Principal, string, string, taskcore.ReleaseWorker) (model.Task, error)
	WithdrawWorkerFunc func(context.Context, model.Principal, string, string, taskcore.WithdrawWorker) (model.Task, error)
}

func (mock *taskServiceMock) Create(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 taskcore.CreateTask) (model.Task, error) {
	if err := mock.check("Create", mock.CreateFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.CreateFunc(arg0, arg1, arg2, arg3)
}

func (mock *taskServiceMock) Update(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.UpdateTask) (model.Task, error) {
	if err := mock.check("Update", mock.UpdateFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.UpdateFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *taskServiceMock) ReplaceTags(ctx context.Context, principal model.Principal, projectID, id string, version int64, tags *[]string) (model.Task, error) {
	if err := mock.check("ReplaceTags", mock.ReplaceTagsFunc != nil); err != nil {
		return model.Task{}, err
	}
	return mock.ReplaceTagsFunc(ctx, principal, projectID, id, version, tags)
}

func (mock *taskServiceMock) Delete(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.DeleteTask) error {
	if err := mock.check("Delete", mock.DeleteFunc != nil); err != nil {
		return err
	}
	return mock.DeleteFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *taskServiceMock) SetStatus(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.SetTaskStatus) (model.Task, error) {
	if err := mock.check("SetStatus", mock.SetStatusFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.SetStatusFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *taskServiceMock) Get(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string) (model.Task, error) {
	if err := mock.check("Get", mock.GetFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.GetFunc(arg0, arg1, arg2, arg3)
}

func (mock *taskServiceMock) Observe(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string) (taskservice.TaskObservation, error) {
	if err := mock.check("Observe", mock.ObserveFunc != nil); err != nil {
		var result taskservice.TaskObservation
		return result, err
	}
	return mock.ObserveFunc(arg0, arg1, arg2, arg3)
}

func (mock *taskServiceMock) List(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 taskservice.TaskListRequest) (taskservice.TaskPage, error) {
	if err := mock.check("List", mock.ListFunc != nil); err != nil {
		var result taskservice.TaskPage
		return result, err
	}
	return mock.ListFunc(arg0, arg1, arg2, arg3)
}

func (mock *taskServiceMock) Graph(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string) (model.TaskGraph, error) {
	if err := mock.check("Graph", mock.GraphFunc != nil); err != nil {
		var result model.TaskGraph
		return result, err
	}
	return mock.GraphFunc(arg0, arg1, arg2, arg3)
}

func (mock *taskServiceMock) Assignees(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
	if err := mock.check("Assignees", mock.AssigneesFunc != nil); err != nil {
		var result model.TaskAssignees
		return result, err
	}
	return mock.AssigneesFunc(arg0, arg1, arg2, arg3)
}

func (mock *taskServiceMock) SetProperty(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 string, arg6 int64) (model.Task, error) {
	if err := mock.check("SetProperty", mock.SetPropertyFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.SetPropertyFunc(arg0, arg1, arg2, arg3, arg4, arg5, arg6)
}

func (mock *taskServiceMock) RemoveProperty(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 int64) (model.Task, error) {
	if err := mock.check("RemoveProperty", mock.RemovePropertyFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.RemovePropertyFunc(arg0, arg1, arg2, arg3, arg4, arg5)
}

func (mock *taskServiceMock) ClaimWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.ClaimWorker) (model.Task, error) {
	if err := mock.check("ClaimWorker", mock.ClaimWorkerFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.ClaimWorkerFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *taskServiceMock) UpdateWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.UpdateWorker) (model.Task, error) {
	if err := mock.check("UpdateWorker", mock.UpdateWorkerFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.UpdateWorkerFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *taskServiceMock) ReleaseWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.ReleaseWorker) (model.Task, error) {
	if err := mock.check("ReleaseWorker", mock.ReleaseWorkerFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.ReleaseWorkerFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *taskServiceMock) WithdrawWorker(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskcore.WithdrawWorker) (model.Task, error) {
	if err := mock.check("WithdrawWorker", mock.WithdrawWorkerFunc != nil); err != nil {
		var result model.Task
		return result, err
	}
	return mock.WithdrawWorkerFunc(arg0, arg1, arg2, arg3, arg4)
}

var _ taskhttp.StepService = (*stepsServiceMock)(nil)

type stepsServiceMock struct {
	*serviceCalls
	GetFunc       func(context.Context, model.Principal, string, string, string) (taskservice.StepDocument, error)
	ListFunc      func(context.Context, model.Principal, string, string) (taskservice.StepsDocument, error)
	AddFunc       func(context.Context, model.Principal, string, string, taskservice.AddTaskStep) (taskservice.StepsWriteResult, error)
	UpdateFunc    func(context.Context, model.Principal, string, string, string, taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error)
	SetStatusFunc func(context.Context, model.Principal, string, string, string, taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error)
	DeleteFunc    func(context.Context, model.Principal, string, string, string, taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error)
	MoveFunc      func(context.Context, model.Principal, string, string, string, taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error)
}

func (mock *stepsServiceMock) Get(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string) (taskservice.StepDocument, error) {
	if err := mock.check("Get", mock.GetFunc != nil); err != nil {
		var result taskservice.StepDocument
		return result, err
	}
	return mock.GetFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *stepsServiceMock) List(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string) (taskservice.StepsDocument, error) {
	if err := mock.check("List", mock.ListFunc != nil); err != nil {
		var result taskservice.StepsDocument
		return result, err
	}
	return mock.ListFunc(arg0, arg1, arg2, arg3)
}

func (mock *stepsServiceMock) Add(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	if err := mock.check("Add", mock.AddFunc != nil); err != nil {
		var result taskservice.StepsWriteResult
		return result, err
	}
	return mock.AddFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *stepsServiceMock) Update(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	if err := mock.check("Update", mock.UpdateFunc != nil); err != nil {
		var result taskservice.StepsWriteResult
		return result, err
	}
	return mock.UpdateFunc(arg0, arg1, arg2, arg3, arg4, arg5)
}

func (mock *stepsServiceMock) SetStatus(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	if err := mock.check("SetStatus", mock.SetStatusFunc != nil); err != nil {
		var result taskservice.StepsWriteResult
		return result, err
	}
	return mock.SetStatusFunc(arg0, arg1, arg2, arg3, arg4, arg5)
}

func (mock *stepsServiceMock) Delete(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	if err := mock.check("Delete", mock.DeleteFunc != nil); err != nil {
		var result taskservice.StepsWriteResult
		return result, err
	}
	return mock.DeleteFunc(arg0, arg1, arg2, arg3, arg4, arg5)
}

func (mock *stepsServiceMock) Move(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 string, arg5 taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	if err := mock.check("Move", mock.MoveFunc != nil); err != nil {
		var result taskservice.StepsWriteResult
		return result, err
	}
	return mock.MoveFunc(arg0, arg1, arg2, arg3, arg4, arg5)
}

var _ taskhttp.ThreadService = (*threadsServiceMock)(nil)

type threadsServiceMock struct {
	*serviceCalls
	PostFunc func(context.Context, model.Principal, string, string, taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error)
	ListFunc func(context.Context, model.Principal, string, string, taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error)
}

func (mock *threadsServiceMock) Post(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
	if err := mock.check("Post", mock.PostFunc != nil); err != nil {
		var result taskservice.ThreadMessageDocument
		return result, err
	}
	return mock.PostFunc(arg0, arg1, arg2, arg3, arg4)
}

func (mock *threadsServiceMock) List(arg0 context.Context, arg1 model.Principal, arg2 string, arg3 string, arg4 taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
	if err := mock.check("List", mock.ListFunc != nil); err != nil {
		var result taskservice.ThreadPageDocument
		return result, err
	}
	return mock.ListFunc(arg0, arg1, arg2, arg3, arg4)
}

func newTaskServiceMock(t *testing.T) *taskServiceMock {
	t.Helper()
	mock := &taskServiceMock{serviceCalls: newServiceCalls(t)}
	mock.required = func() []string {
		var methods []string
		if mock.CreateFunc != nil {
			methods = append(methods, "Create")
		}
		if mock.UpdateFunc != nil {
			methods = append(methods, "Update")
		}
		if mock.ReplaceTagsFunc != nil {
			methods = append(methods, "ReplaceTags")
		}
		if mock.DeleteFunc != nil {
			methods = append(methods, "Delete")
		}
		if mock.SetStatusFunc != nil {
			methods = append(methods, "SetStatus")
		}
		if mock.GetFunc != nil {
			methods = append(methods, "Get")
		}
		if mock.ObserveFunc != nil {
			methods = append(methods, "Observe")
		}
		if mock.ListFunc != nil {
			methods = append(methods, "List")
		}
		if mock.GraphFunc != nil {
			methods = append(methods, "Graph")
		}
		if mock.AssigneesFunc != nil {
			methods = append(methods, "Assignees")
		}
		if mock.SetPropertyFunc != nil {
			methods = append(methods, "SetProperty")
		}
		if mock.RemovePropertyFunc != nil {
			methods = append(methods, "RemoveProperty")
		}
		if mock.ClaimWorkerFunc != nil {
			methods = append(methods, "ClaimWorker")
		}
		if mock.UpdateWorkerFunc != nil {
			methods = append(methods, "UpdateWorker")
		}
		if mock.ReleaseWorkerFunc != nil {
			methods = append(methods, "ReleaseWorker")
		}
		if mock.WithdrawWorkerFunc != nil {
			methods = append(methods, "WithdrawWorker")
		}
		return methods
	}
	return mock
}

func newStepsServiceMock(t *testing.T) *stepsServiceMock {
	t.Helper()
	mock := &stepsServiceMock{serviceCalls: newServiceCalls(t)}
	mock.required = func() []string {
		var methods []string
		if mock.GetFunc != nil {
			methods = append(methods, "Get")
		}
		if mock.ListFunc != nil {
			methods = append(methods, "List")
		}
		if mock.AddFunc != nil {
			methods = append(methods, "Add")
		}
		if mock.UpdateFunc != nil {
			methods = append(methods, "Update")
		}
		if mock.SetStatusFunc != nil {
			methods = append(methods, "SetStatus")
		}
		if mock.DeleteFunc != nil {
			methods = append(methods, "Delete")
		}
		if mock.MoveFunc != nil {
			methods = append(methods, "Move")
		}
		return methods
	}
	return mock
}

func newThreadsServiceMock(t *testing.T) *threadsServiceMock {
	t.Helper()
	mock := &threadsServiceMock{serviceCalls: newServiceCalls(t)}
	mock.required = func() []string {
		var methods []string
		if mock.PostFunc != nil {
			methods = append(methods, "Post")
		}
		if mock.ListFunc != nil {
			methods = append(methods, "List")
		}
		return methods
	}
	return mock
}
