package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"testing"
)

type operationRejectedTaskSteps struct{ t *testing.T }

func (r *operationRejectedTaskSteps) ListPage(context.Context, model.Principal, string, string, int64, int, *int64, bool) (task.StepsPage, error) {
	r.t.Errorf("unexpected TaskSteps.ListPage call")
	var result0 task.StepsPage
	return result0, errors.New("unexpected TaskSteps.ListPage")
}

func (r *operationRejectedTaskSteps) GetSummary(context.Context, model.Principal, string, string, string) (task.StepSummary, error) {
	r.t.Errorf("unexpected TaskSteps.GetSummary call")
	var result0 task.StepSummary
	return result0, errors.New("unexpected TaskSteps.GetSummary")
}

func (r *operationRejectedTaskSteps) List(context.Context, model.Principal, string, string) (task.StepsDocument, error) {
	r.t.Errorf("unexpected TaskSteps.List call")
	var result0 task.StepsDocument
	return result0, errors.New("unexpected TaskSteps.List")
}

func (r *operationRejectedTaskSteps) Get(context.Context, model.Principal, string, string, string) (task.StepDocument, error) {
	r.t.Errorf("unexpected TaskSteps.Get call")
	var result0 task.StepDocument
	return result0, errors.New("unexpected TaskSteps.Get")
}

func (r *operationRejectedTaskSteps) Add(context.Context, model.Principal, string, string, task.AddTaskStep) (task.StepsWriteResult, error) {
	r.t.Errorf("unexpected TaskSteps.Add call")
	var result0 task.StepsWriteResult
	return result0, errors.New("unexpected TaskSteps.Add")
}

func (r *operationRejectedTaskSteps) Update(context.Context, model.Principal, string, string, string, task.UpdateTaskStep) (task.StepsWriteResult, error) {
	r.t.Errorf("unexpected TaskSteps.Update call")
	var result0 task.StepsWriteResult
	return result0, errors.New("unexpected TaskSteps.Update")
}

func (r *operationRejectedTaskSteps) SetStatus(context.Context, model.Principal, string, string, string, task.SetTaskStepStatus) (task.StepsWriteResult, error) {
	r.t.Errorf("unexpected TaskSteps.SetStatus call")
	var result0 task.StepsWriteResult
	return result0, errors.New("unexpected TaskSteps.SetStatus")
}

func (r *operationRejectedTaskSteps) Move(context.Context, model.Principal, string, string, string, task.MoveTaskStep) (task.StepsWriteResult, error) {
	r.t.Errorf("unexpected TaskSteps.Move call")
	var result0 task.StepsWriteResult
	return result0, errors.New("unexpected TaskSteps.Move")
}

func (r *operationRejectedTaskSteps) Delete(context.Context, model.Principal, string, string, string, task.DeleteTaskStep) (task.StepsWriteResult, error) {
	r.t.Errorf("unexpected TaskSteps.Delete call")
	var result0 task.StepsWriteResult
	return result0, errors.New("unexpected TaskSteps.Delete")
}
