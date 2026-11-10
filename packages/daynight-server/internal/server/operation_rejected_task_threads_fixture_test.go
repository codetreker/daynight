package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"testing"
)

type operationRejectedTaskThreads struct{ t *testing.T }

func (r *operationRejectedTaskThreads) Post(context.Context, model.Principal, string, string, task.CreateThreadMessage) (task.ThreadMessageDocument, error) {
	r.t.Errorf("unexpected TaskThreads.Post call")
	var result0 task.ThreadMessageDocument
	return result0, errors.New("unexpected TaskThreads.Post")
}

func (r *operationRejectedTaskThreads) List(context.Context, model.Principal, string, string, task.ThreadListRequest) (task.ThreadPageDocument, error) {
	r.t.Errorf("unexpected TaskThreads.List call")
	var result0 task.ThreadPageDocument
	return result0, errors.New("unexpected TaskThreads.List")
}
