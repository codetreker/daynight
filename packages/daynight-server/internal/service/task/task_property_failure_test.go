package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestWorkerClaimClockFailurePreventsTaskWrite(t *testing.T) {
	_, target, _ := taskMockModels()
	target.AllowAgents = true
	f := newPropertyWriteFixture(t, target, propertyAbort(t, func(err error) {
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("clock callback lost cancellation: %v", err)
		}
	}))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	f.ctx = ctx
	f.scope.WorkerClaimAdmissionDAOFn = func() store.WorkerClaimAdmissionDAO {
		return &workerClaimAdmissionMock{check: func(context.Context, string, string) error { return nil }, read: func(actual context.Context, user, worker string) (*model.WorkerDesiredConfiguration, error) {
			if actual != ctx || user != f.principal.UserID || worker == "" {
				t.Fatal("claim admission identity changed")
			}
			return nil, nil
		}}
	}
	calls := 0
	f.dao.ObservedAtFn = func(actual context.Context) (time.Time, error) {
		calls++
		if actual != ctx {
			t.Fatal("claim clock changed context")
		}
		cancel()
		return time.Time{}, actual.Err()
	}
	actual, err := f.tasks.ClaimWorker(ctx, f.principal, f.project.ID, target.ID, taskcore.ClaimWorker{Version: target.Version, WorkerDescriptor: workerDescriptor()})
	assertOperational(t, err)
	if !errors.Is(err, context.Canceled) || calls != 1 || !reflect.DeepEqual(actual, model.Task{}) {
		t.Fatalf("claim clock failure: %#v %v, calls=%d", actual, err, calls)
	}
}
