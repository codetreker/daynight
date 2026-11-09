package worker

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type missingWorkerCompletion struct {
	store.SnapshotScope
	store.WorkerReader
	t         *testing.T
	ctx       context.Context
	principal model.Principal
	worker    string
	observed  time.Time
	failure   error
	finish    func()
	calls     []string
}

func (s *missingWorkerCompletion) call(ctx context.Context, name string) {
	s.t.Helper()
	if ctx != s.ctx {
		s.t.Errorf("%s replaced the caller context", name)
	}
	s.calls = append(s.calls, name)
}
func (s *missingWorkerCompletion) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.call(ctx, "snapshot")
	if err := operation(s); err != nil {
		s.t.Fatalf("missing Worker was not staged until completion: %v", err)
	}
	s.call(ctx, "completion")
	if s.finish != nil {
		s.finish()
	}
	return s.failure
}
func (s *missingWorkerCompletion) WriteWorker(context.Context, func(store.WorkerScope) error) (store.Completion, error) {
	s.t.Error("Worker read attempted a write")
	return store.Completion{}, errors.New("unexpected Worker write")
}
func (s *missingWorkerCompletion) ObservedAt(ctx context.Context) (time.Time, error) {
	s.call(ctx, "clock")
	return s.observed, nil
}
func (s *missingWorkerCompletion) WorkerDAO() store.WorkerReader {
	s.calls = append(s.calls, "workerDAO")
	return s
}
func (s *missingWorkerCompletion) Worker(ctx context.Context, user, worker string, observed time.Time) (model.WorkerSnapshot, error) {
	s.call(ctx, "worker")
	if user != s.principal.UserID || worker != s.worker || observed != s.observed {
		s.t.Errorf("Worker query = %s/%s at %s", user, worker, observed)
	}
	return model.WorkerSnapshot{}, model.ErrNotFound
}

func TestMissingWorkerRefusalWaitsForSnapshotCompletion(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "confirmed refusal"
		if failed {
			name = "unknown completion"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
			reader := &missingWorkerCompletion{t: t, ctx: ctx, principal: principal, worker: "33333333-3333-4333-8333-333333333333", observed: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
			var failure *store.TransactionError
			if failed {
				failure = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
				reader.failure, reader.finish = failure, cancel
			}
			result, err := NewWorkers(reader).Get(ctx, principal, reader.worker)
			if !slices.Equal(reader.calls, []string{"snapshot", "clock", "workerDAO", "worker", "completion"}) || !reflect.DeepEqual(result, WorkerDetailResult{}) {
				t.Fatalf("read result = %+v, calls = %v", result, reader.calls)
			}
			var refusal *model.Fault
			if !failed {
				if !errors.As(err, &refusal) || refusal.Code != "not_found" {
					t.Fatalf("missing Worker result: %v", err)
				}
				return
			}
			var completion *store.TransactionError
			if !errors.Is(err, failure) || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || completion != failure || completion.Outcome != store.TransactionUnknown || !completion.CommitAttempted || errors.As(err, &refusal) {
				t.Fatalf("completion was replaced by the staged refusal: %v", err)
			}
		})
	}
}
