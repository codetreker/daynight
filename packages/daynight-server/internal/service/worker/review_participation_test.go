package worker

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type reviewParticipationServiceDAO struct {
	store.WorkerWriteDAO
	store.WorkerReader
	read  func(context.Context, string, string) (model.WorkerReviewParticipation, error)
	write func(context.Context, string, string, int64, model.WorkerReviewParticipation) error
}

func (d reviewParticipationServiceDAO) WorkerReviewParticipation(ctx context.Context, u, w string) (model.WorkerReviewParticipation, error) {
	if d.read == nil {
		panic("unexpected review read")
	}
	return d.read(ctx, u, w)
}
func (d reviewParticipationServiceDAO) SetWorkerReviewParticipation(ctx context.Context, u, w string, expected int64, next model.WorkerReviewParticipation) error {
	if d.write == nil {
		panic("unexpected review write")
	}
	return d.write(ctx, u, w, expected, next)
}

// Both embedded DAO contracts expose this unrelated operation.
func (reviewParticipationServiceDAO) WorkerConfiguration(context.Context, string, string) (model.WorkerConfigurationResource, error) {
	panic("unexpected configuration read")
}

func TestWorkerReviewParticipationServiceScopesAndCompletion(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222"}
	const id = "c3333333-3333-4333-8333-333333333333"
	failure := errors.New("operation failed")
	for _, tc := range []struct {
		name       string
		get        bool
		outcome    store.TransactionOutcome
		outerError error
		readError  error
	}{
		{name: "read", get: true},
		{name: "read missing", get: true, readError: model.ErrNotFound},
		{name: "read failure", get: true, outerError: failure},
		{name: "commit", outcome: store.TransactionCommitted},
		{name: "not committed", outcome: store.TransactionNotCommitted},
		{name: "unknown", outcome: store.TransactionUnknown},
		{name: "transaction failure", outerError: failure},
		{name: "operation failure", readError: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			calls := &configurationCalls{t: t, ctx: ctx}
			dao := &reviewParticipationServiceDAO{}
			current := model.WorkerReviewParticipation{Version: 2}
			dao.read = func(actual context.Context, user, worker string) (model.WorkerReviewParticipation, error) {
				calls.take("review read", actual)
				if user != p.UserID || worker != id {
					t.Fatal("review participation scope changed")
				}
				return current, tc.readError
			}
			dao.write = func(actual context.Context, user, worker string, expected int64, next model.WorkerReviewParticipation) error {
				calls.take("review write", actual)
				if user != p.UserID || worker != id || expected != 2 || next.Version != 3 || !next.Enabled {
					t.Fatalf("review write arguments: %s %s %d %+v", user, worker, expected, next)
				}
				return nil
			}
			db := &configurationStore{calls: calls}
			var callbackErr error
			if tc.get {
				calls.want = []string{"snapshot"}
				if tc.outerError == nil {
					calls.want = append(calls.want, "read dao", "review read")
				}
				db.read = func(actual context.Context, fn func(store.SnapshotScope) error) error {
					if tc.outerError != nil {
						return tc.outerError
					}
					callbackErr = fn(configurationReadScope{calls: calls, dao: dao})
					return callbackErr
				}
			} else {
				calls.want = []string{"write"}
				if tc.outerError == nil {
					calls.want = append(calls.want, "write dao", "review read")
					if tc.readError == nil {
						calls.want = append(calls.want, "review write")
					}
				}
				db.write = func(actual context.Context, fn func(store.WorkerScope) error) (store.Completion, error) {
					if tc.outerError != nil {
						return store.Completion{}, tc.outerError
					}
					callbackErr = fn(configurationWriteScope{calls: calls, dao: dao})
					return store.Completion{Outcome: tc.outcome}, callbackErr
				}
			}
			s := NewWorkers(db)
			var got model.WorkerReviewParticipation
			var err error
			if tc.get {
				got, err = s.ReviewParticipation(ctx, p, id)
			} else {
				got, err = s.PutReviewParticipation(ctx, p, id, "2", true)
			}
			success := tc.outerError == nil && tc.readError == nil && (tc.get || tc.outcome == store.TransactionCommitted)
			if success {
				want := model.WorkerReviewParticipation{Enabled: true, Version: 3}
				if tc.get {
					want = current
				}
				if err != nil || !reflect.DeepEqual(got, want) {
					t.Fatalf("result: %+v %v", got, err)
				}
			} else if err == nil || got != (model.WorkerReviewParticipation{}) {
				t.Fatalf("unconfirmed result exposed: %+v %v", got, err)
			}
			if (tc.outerError == failure || tc.readError == failure) && !errors.Is(err, failure) {
				t.Fatalf("failure cause lost: %v", err)
			}
			if !reflect.DeepEqual(calls.seen, calls.want) {
				t.Fatalf("calls=%v want=%v", calls.seen, calls.want)
			}
		})
	}
}

func TestWorkerReviewParticipationServiceRejectsInvalidVersionBeforeWrite(t *testing.T) {
	db := &configurationStore{calls: &configurationCalls{t: t, ctx: t.Context()}}
	if _, err := NewWorkers(db).PutReviewParticipation(t.Context(), model.Principal{}, "worker", "01", false); err == nil {
		t.Fatal("invalid version accepted")
	}
}

func (reviewParticipationServiceDAO) WorkerAlias(context.Context, string, string) (model.WorkerAlias, error) {
	panic("unexpected alias read")
}
