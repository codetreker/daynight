package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"testing"
)

type operationRejectedTaskObservations struct{ t *testing.T }

func (r *operationRejectedTaskObservations) ObserveGet(context.Context, model.Principal, string, string) (task.ObservedTask, error) {
	r.t.Errorf("unexpected TaskObservations.ObserveGet call")
	var result0 task.ObservedTask
	return result0, errors.New("unexpected TaskObservations.ObserveGet")
}

func (r *operationRejectedTaskObservations) ObserveList(context.Context, model.Principal, string, task.TaskListRequest) (task.ObservedTaskPage, error) {
	r.t.Errorf("unexpected TaskObservations.ObserveList call")
	var result0 task.ObservedTaskPage
	return result0, errors.New("unexpected TaskObservations.ObserveList")
}

func (r *operationRejectedTaskObservations) ObserveGraph(context.Context, model.Principal, string, string) (task.ObservedGraph, error) {
	r.t.Errorf("unexpected TaskObservations.ObserveGraph call")
	var result0 task.ObservedGraph
	return result0, errors.New("unexpected TaskObservations.ObserveGraph")
}

func (r *operationRejectedTaskObservations) ObservedMCPList(context.Context, model.Principal, string, taskcore.MCPListRequest) (task.ObservedMCPPage, error) {
	r.t.Errorf("unexpected TaskObservations.ObservedMCPList call")
	var result0 task.ObservedMCPPage
	return result0, errors.New("unexpected TaskObservations.ObservedMCPList")
}

func (r *operationRejectedTaskObservations) WorkList(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error) {
	r.t.Errorf("unexpected TaskObservations.WorkList call")
	var result0 taskwork.Page
	return result0, errors.New("unexpected TaskObservations.WorkList")
}
