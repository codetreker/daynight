package task_test

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type observationServiceMock struct {
	*serviceCalls
	GetFunc   func(context.Context, model.Principal, string, string) (service.ObservedTask, error)
	ListFunc  func(context.Context, model.Principal, string, service.TaskListRequest) (service.ObservedTaskPage, error)
	GraphFunc func(context.Context, model.Principal, string, string) (service.ObservedGraph, error)
	WorkFunc  func(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error)
}

func newObservationServiceMock(t *testing.T) *observationServiceMock {
	m := &observationServiceMock{serviceCalls: newServiceCalls(t)}
	m.required = func() []string {
		var required []string
		if m.GetFunc != nil {
			required = append(required, "ObserveGet")
		}
		if m.ListFunc != nil {
			required = append(required, "ObserveList")
		}
		if m.GraphFunc != nil {
			required = append(required, "ObserveGraph")
		}
		if m.WorkFunc != nil {
			required = append(required, "WorkList")
		}
		return required
	}
	return m
}
func (m *observationServiceMock) ObserveGet(ctx context.Context, p model.Principal, pid, id string) (service.ObservedTask, error) {
	if err := m.check("ObserveGet", m.GetFunc != nil); err != nil {
		return service.ObservedTask{}, err
	}
	return m.GetFunc(ctx, p, pid, id)
}
func (m *observationServiceMock) ObserveList(ctx context.Context, p model.Principal, pid string, r service.TaskListRequest) (service.ObservedTaskPage, error) {
	if err := m.check("ObserveList", m.ListFunc != nil); err != nil {
		return service.ObservedTaskPage{}, err
	}
	return m.ListFunc(ctx, p, pid, r)
}
func (m *observationServiceMock) ObserveGraph(ctx context.Context, p model.Principal, pid, id string) (service.ObservedGraph, error) {
	if err := m.check("ObserveGraph", m.GraphFunc != nil); err != nil {
		return service.ObservedGraph{}, err
	}
	return m.GraphFunc(ctx, p, pid, id)
}
func (m *observationServiceMock) WorkList(ctx context.Context, p model.Principal, pid string, r taskcore.WorkRequest) (taskwork.Page, error) {
	if err := m.check("WorkList", m.WorkFunc != nil); err != nil {
		return taskwork.Page{}, err
	}
	return m.WorkFunc(ctx, p, pid, r)
}
