package worker

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type reviewSettingsDAO struct {
	aliasServiceDAO
	readEnabled  func(context.Context, string, string) (bool, error)
	writeEnabled func(context.Context, string, string, bool) (bool, error)
}

func (d reviewSettingsDAO) WorkerReviewEnabled(ctx context.Context, userID, workerID string) (bool, error) {
	return d.readEnabled(ctx, userID, workerID)
}

func (d reviewSettingsDAO) SetWorkerReviewEnabled(ctx context.Context, userID, workerID string, enabled bool) (bool, error) {
	return d.writeEnabled(ctx, userID, workerID, enabled)
}

func TestWorkerReviewSettingsServiceScopesAndCompletion(t *testing.T) {
	actor := model.Principal{Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	const workerID = "30000000-0000-4000-8000-000000000001"
	for _, tc := range []struct {
		name      string
		read      bool
		daoErr    error
		outcome   store.TransactionOutcome
		success   bool
		wantFault string
	}{
		{name: "read", read: true, success: true},
		{name: "read foreign", read: true, daoErr: model.ErrNotFound, wantFault: "not_found"},
		{name: "write", outcome: store.TransactionCommitted, success: true},
		{name: "write foreign", daoErr: model.ErrNotFound, outcome: store.TransactionNotCommitted, wantFault: "not_found"},
		{name: "unknown completion", outcome: store.TransactionUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			calls := &configurationCalls{t: t, ctx: ctx}
			checkScope := func(user, worker string) {
				t.Helper()
				if user != actor.UserID || worker != workerID {
					t.Fatalf("unexpected scope: user=%s worker=%s", user, worker)
				}
			}
			dao := reviewSettingsDAO{
				readEnabled: func(ctx context.Context, user, worker string) (bool, error) {
					calls.take("read setting", ctx)
					checkScope(user, worker)
					return true, tc.daoErr
				},
				writeEnabled: func(ctx context.Context, user, worker string, enabled bool) (bool, error) {
					calls.take("write setting", ctx)
					checkScope(user, worker)
					if !enabled {
						t.Fatal("enabled value changed")
					}
					return true, tc.daoErr
				},
			}
			db := &configurationStore{calls: calls}
			var got bool
			var err error
			if tc.read {
				calls.want = []string{"snapshot", "read dao", "read setting"}
				db.read = func(_ context.Context, fn func(store.SnapshotScope) error) error {
					return fn(configurationReadScope{calls: calls, dao: dao})
				}
				got, err = NewWorkers(db).ReviewEnabled(ctx, actor, workerID)
			} else {
				calls.want = []string{"write", "write dao", "write setting"}
				db.write = func(_ context.Context, fn func(store.WorkerScope) error) (store.Completion, error) {
					return store.Completion{Outcome: tc.outcome}, fn(configurationWriteScope{calls: calls, dao: dao})
				}
				got, err = NewWorkers(db).SetReviewEnabled(ctx, actor, workerID, true)
			}
			if got != tc.success || (err == nil) != tc.success || !reflect.DeepEqual(calls.seen, calls.want) {
				t.Fatalf("got=%t err=%v calls=%v wantSuccess=%t calls=%v", got, err, calls.seen, tc.success, calls.want)
			}
			if tc.wantFault != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != tc.wantFault || !errors.Is(err, tc.daoErr) {
					t.Fatalf("unexpected fault: %v", err)
				}
			}
		})
	}
}

func TestWorkerReviewSettingsServiceRejectsInvalidScopeBeforeStorage(t *testing.T) {
	actor := model.Principal{Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	s := NewWorkers(&configurationStore{calls: &configurationCalls{t: t, ctx: t.Context()}})
	if _, err := s.ReviewEnabled(t.Context(), model.Principal{}, actor.UserID); err == nil {
		t.Fatal("read accepted an unauthenticated principal")
	}
	if _, err := s.ReviewEnabled(t.Context(), actor, "bad-worker-id"); err == nil {
		t.Fatal("read accepted an invalid Worker ID")
	}
	if _, err := s.SetReviewEnabled(t.Context(), model.Principal{}, actor.UserID, true); err == nil {
		t.Fatal("write accepted an unauthenticated principal")
	}
	if _, err := s.SetReviewEnabled(t.Context(), actor, "bad-worker-id", true); err == nil {
		t.Fatal("write accepted an invalid Worker ID")
	}
}
