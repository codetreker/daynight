package worker

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type lifecycleTestStore struct {
	workerStore
	write func(context.Context, func(store.WorkerLifecycleScope) error) (store.Completion, error)
	read  func(context.Context, func(store.WorkerLifecycleSnapshot) error) error
}

func (s lifecycleTestStore) WriteWorkerLifecycle(ctx context.Context, f func(store.WorkerLifecycleScope) error) (store.Completion, error) {
	return s.write(ctx, f)
}
func (s lifecycleTestStore) ReadWorkerLifecycle(ctx context.Context, f func(store.WorkerLifecycleSnapshot) error) error {
	return s.read(ctx, f)
}

type lifecycleTestScope struct {
	store.WorkerScope
	dao      store.WorkerLifecycleDAO
	now      time.Time
	clockErr error
}

func (s lifecycleTestScope) LifecycleDAO() store.WorkerLifecycleDAO        { return s.dao }
func (s lifecycleTestScope) ObservedAt(context.Context) (time.Time, error) { return s.now, s.clockErr }

type lifecycleTestSnapshot struct {
	store.SnapshotScope
	dao      store.WorkerLifecycleReader
	now      time.Time
	clockErr error
}

func (s lifecycleTestSnapshot) LifecycleDAO() store.WorkerLifecycleReader { return s.dao }
func (s lifecycleTestSnapshot) ObservedAt(context.Context) (time.Time, error) {
	return s.now, s.clockErr
}

type lifecycleTestDAO struct {
	store.WorkerLifecycleDAO
	lock func(context.Context, string, string) error
}

func (d lifecycleTestDAO) LockWorker(ctx context.Context, u, w string) error {
	return d.lock(ctx, u, w)
}

func TestLifecycleServiceCompletion(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}
	id := "22222222-2222-4222-8222-222222222222"
	now := time.Now().UTC()
	for _, tc := range []struct {
		name                  string
		outcome               store.TransactionOutcome
		callbackErr, finalErr error
		success               bool
	}{
		{"committed", store.TransactionCommitted, nil, nil, true},
		{"committed cleanup", store.TransactionCommitted, nil, errors.New("cleanup"), false},
		{"unknown", store.TransactionUnknown, nil, errors.New("commit"), false},
		{"unconfirmed", store.TransactionNotCommitted, nil, nil, false},
		{"refused", store.TransactionNotCommitted, &model.Fault{Code: "version_conflict", Message: "changed"}, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			locks, calls := 0, 0
			dao := lifecycleTestDAO{lock: func(ctx context.Context, u, w string) error {
				locks++
				if u != p.UserID || w != id {
					t.Fatal("wrong lock identity")
				}
				return nil
			}}
			db := lifecycleTestStore{write: func(ctx context.Context, f func(store.WorkerLifecycleScope) error) (store.Completion, error) {
				err := f(lifecycleTestScope{dao: dao, now: now})
				if err != nil {
					return store.Completion{Outcome: tc.outcome}, err
				}
				return store.Completion{Outcome: tc.outcome}, tc.finalErr
			}}
			got, err := lifecycleWrite(context.Background(), NewWorkers(db), p, id, scopepolicy.WorkerReport, func(d store.WorkerLifecycleDAO, w string, at time.Time) (string, error) {
				calls++
				if locks != 1 || w != id || at != now || d == nil {
					t.Fatal("missing locked input")
				}
				return "receipt", tc.callbackErr
			})
			if locks != 1 || calls != 1 {
				t.Fatalf("locks=%d calls=%d", locks, calls)
			}
			if tc.success {
				if err != nil || got != "receipt" {
					t.Fatalf("%q %v", got, err)
				}
			} else {
				if err == nil || got != "" {
					t.Fatalf("unconfirmed receipt %q %v", got, err)
				}
				var f *model.Fault
				if !errors.As(err, &f) {
					t.Fatal(err)
				}
				if tc.name == "refused" && f.Code != "version_conflict" {
					t.Fatal(f)
				}
			}
		})
	}
}

func TestLifecycleServiceAdmissionAndFailures(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}
	id := "22222222-2222-4222-8222-222222222222"
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"worker:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := workerAuthorization{write: func(context.Context, store.WorkerScope, model.Principal) (model.CredentialAuthorization, error) {
		return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}, nil
	}}
	dbDenied := lifecycleTestStore{write: func(ctx context.Context, f func(store.WorkerLifecycleScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, f(lifecycleTestScope{})
	}}
	scoped, e := NewScopedWorkers(dbDenied, auth)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = lifecycleWrite(context.Background(), scoped, p, id, scopepolicy.WorkerConfigure, func(store.WorkerLifecycleDAO, string, time.Time) (string, error) {
		t.Fatal("denied write ran")
		return "", nil
	}); e == nil {
		t.Fatal("scope denial missing")
	}
	for _, tc := range []struct {
		name              string
		p                 model.Principal
		id                string
		lockErr, clockErr error
	}{
		{"principal", model.Principal{}, id, nil, nil},
		{"id", p, "bad", nil, nil},
		{"lock", p, id, model.ErrNotFound, nil},
		{"clock", p, id, nil, errors.New("clock")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := lifecycleTestStore{write: func(ctx context.Context, f func(store.WorkerLifecycleScope) error) (store.Completion, error) {
				return store.Completion{Outcome: store.TransactionNotCommitted}, f(lifecycleTestScope{dao: lifecycleTestDAO{lock: func(context.Context, string, string) error { return tc.lockErr }}, clockErr: tc.clockErr})
			}}
			_, err := lifecycleWrite(context.Background(), NewWorkers(db), tc.p, tc.id, scopepolicy.WorkerConfigure, func(store.WorkerLifecycleDAO, string, time.Time) (string, error) {
				t.Fatal("unexpected write")
				return "", nil
			})
			if err == nil {
				t.Fatal("missing failure")
			}
		})
	}
	for _, err := range []error{&store.Error{DatabaseFailure: true}, &store.TransactionError{Outcome: store.TransactionUnknown}, model.ErrNotFound, errors.New("unknown")} {
		if lifecycleError(err) == nil {
			t.Fatal("lost error")
		}
	}
	if lifecycleError(nil) != nil {
		t.Fatal("nil changed")
	}
	if _, err := NewWorkers(nil).Lifecycle(context.Background(), p, id); err == nil {
		t.Fatal("missing store")
	}
	if _, err := NewWorkers(nil).SetLifecycleIntent(context.Background(), p, id, model.LifecycleIntentRequest{}); err == nil {
		t.Fatal("missing writer")
	}
}

func TestLifecycleServiceReadScope(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}
	id := "22222222-2222-4222-8222-222222222222"
	now := time.Now()
	for _, clockErr := range []error{nil, errors.New("clock")} {
		db := lifecycleTestStore{read: func(ctx context.Context, f func(store.WorkerLifecycleSnapshot) error) error {
			return f(lifecycleTestSnapshot{now: now, clockErr: clockErr})
		}}
		got, err := lifecycleRead(context.Background(), NewWorkers(db), p, id, func(_ store.WorkerLifecycleReader, w string, at time.Time) (string, error) {
			if w != id || at != now {
				t.Fatal("read identity changed")
			}
			return "read", nil
		})
		if clockErr == nil {
			if err != nil || got != "read" {
				t.Fatalf("%s %v", got, err)
			}
		} else if err == nil || got != "" {
			t.Fatal("clock error hidden")
		}
	}
	for _, p := range []model.Principal{{}, p} {
		_, err := lifecycleRead(context.Background(), NewWorkers(nil), p, id, func(store.WorkerLifecycleReader, string, time.Time) (string, error) {
			t.Fatal("unexpected read")
			return "", nil
		})
		if err == nil {
			t.Fatal("missing error")
		}
	}
	if _, err := NewWorkers(nil).LifecycleOperation(context.Background(), p, id, "invalid"); err == nil {
		t.Fatal("bad operation")
	}
	if _, err := NewWorkers(nil).ResolveLifecycle(context.Background(), p, id, "invalid", model.LifecycleResolveRequest{}); err == nil {
		t.Fatal("bad resolve")
	}
}

func TestLifecyclePublicWritesUseCurrentPermissionsAndOriginalScope(t *testing.T) {
	ctx := t.Context()
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}
	id := "22222222-2222-4222-8222-222222222222"
	op, instance := "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"
	sentinel := errors.New("locked authority read failed")
	disable := model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: op, Action: "disable", ExpectedVersion: "1", Source: "web"}
	raw, err := json.Marshal(disable)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		scope scopepolicy.ScopeID
		run   func(*Workers) error
	}{
		{"intent", "worker:configure", func(s *Workers) error { _, e := s.SetLifecycleIntent(ctx, p, id, disable); return e }},
		{"instance", "worker:report", func(s *Workers) error {
			_, e := s.RegisterLifecycle(ctx, p, id, model.LifecycleInstanceRequest{ProtocolVersion: 1, OperationID: op, InstanceID: instance, Capabilities: model.LifecycleCapabilities{Disable: true, Resume: true, Inventory: 1, DispatchFence: 1}, Platform: "macos"})
			return e
		}},
		{"activation", "worker:report", func(s *Workers) error {
			_, e := s.ActivateLifecycle(ctx, p, id, model.LifecycleActivationRequest{ProtocolVersion: 1, OperationID: op, InstanceID: instance, InstanceEpoch: "1", IntentVersion: "1", LocalEpoch: "1", ScopeGeneration: "1", ReportSequence: "1"})
			return e
		}},
		{"observation", "worker:report", func(s *Workers) error {
			_, e := s.ObserveLifecycle(ctx, p, id, model.LifecycleObservationEnvelope{ProtocolVersion: 1, InstanceID: instance, InstanceEpoch: "1", IntentVersion: "1", LocalEpoch: "1", ScopeGeneration: "1", ReportSequence: "1", Observation: model.LifecycleObservation{Phase: "disabling", Stop: "stopping", Save: "pending", Sync: "pending", InventoryRevision: "1", InventoryDigest: strings.Repeat("a", 64), Resources: []model.LifecycleResourceObservation{}, Recovery: []model.LifecycleRecoveryObservation{}}})
			return e
		}},
		{"resolve", "worker:configure", func(s *Workers) error {
			_, e := s.ResolveLifecycle(ctx, p, id, op, model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "intent", Request: raw})
			return e
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, allowed := range []bool{false, true} {
				checks, locks := 0, 0
				dao := lifecycleTestDAO{lock: func(ctx context.Context, u, w string) error {
					locks++
					if checks != 1 || ctx != ctx || u != p.UserID || w != id {
						t.Fatal("authority/order mismatch")
					}
					if locks == 2 {
						return sentinel
					}
					return nil
				}}
				scope := lifecycleTestScope{dao: dao, now: time.Now()}
				db := lifecycleTestStore{write: func(ctx context.Context, f func(store.WorkerLifecycleScope) error) (store.Completion, error) {
					return store.Completion{Outcome: store.TransactionNotCommitted}, f(scope)
				}}
				scopes := []scopepolicy.ScopeID{"worker:read"}
				if allowed {
					scopes = append(scopes, tc.scope)
				}
				authority := workerPolicy(t, p, scopes...)
				s, e := NewScopedWorkers(db, workerAuthorization{write: func(ctx context.Context, actual store.WorkerScope, principal model.Principal) (model.CredentialAuthorization, error) {
					checks++
					if ctx != ctx || principal != p || actual.(lifecycleTestScope).now != scope.now {
						t.Fatal("scope lost")
					}
					return authority, nil
				}})
				if e != nil {
					t.Fatal(e)
				}
				e = tc.run(s)
				if allowed {
					if !errors.Is(e, sentinel) || locks != 2 {
						t.Fatalf("error=%v locks=%d", e, locks)
					}
				} else {
					var f *model.Fault
					if !errors.As(e, &f) || f.Code != "insufficient_scope" || locks != 0 {
						t.Fatalf("permission bypass: %v locks=%d", e, locks)
					}
				}
			}
		})
	}
}

type lifecycleReadDAO struct {
	store.WorkerLifecycleReader
	user, worker string
	calls        *int
}

func (d lifecycleReadDAO) Lifecycle(ctx context.Context, u, w string) (model.WorkerLifecycle, error) {
	*d.calls++
	if u != d.user || w != d.worker {
		panic("wrong identity")
	}
	return model.WorkerLifecycle{UserID: u, WorkerID: w, ProtocolVersion: 1, IntentVersion: 1, Desired: "enabled", Admission: "closed"}, nil
}
func (d lifecycleReadDAO) Observation(context.Context, string, string) (model.LifecycleStoredObservation, error) {
	return model.LifecycleStoredObservation{}, model.ErrNotFound
}
func (d lifecycleReadDAO) Operation(ctx context.Context, u, w, id string) (model.LifecycleOperation, error) {
	*d.calls++
	if u != d.user || w != d.worker {
		panic("wrong identity")
	}
	return model.LifecycleOperation{RequestKind: "instance", Receipt: json.RawMessage(`{}`)}, nil
}
func TestLifecyclePublicReadsRetainSnapshotAuthorization(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}
	id := "22222222-2222-4222-8222-222222222222"
	calls, checks := 0, 0
	dao := lifecycleReadDAO{user: p.UserID, worker: id, calls: &calls}
	db := lifecycleTestStore{read: func(ctx context.Context, f func(store.WorkerLifecycleSnapshot) error) error {
		return f(lifecycleTestSnapshot{dao: dao, now: time.Now()})
	}}
	s, err := NewScopedWorkers(db, workerAuthorization{read: func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error) {
		checks++
		return workerPolicy(t, p, "worker:read"), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if r, e := s.Lifecycle(t.Context(), p, id); e != nil || r.WorkerID != id {
		t.Fatalf("%+v %v", r, e)
	}
	if r, e := s.LifecycleOperation(t.Context(), p, id, "44444444-4444-4444-8444-444444444444"); e != nil || r.Kind != "instance" {
		t.Fatalf("%+v %v", r, e)
	}
	if calls != 2 || checks != 2 {
		t.Fatalf("calls=%d checks=%d", calls, checks)
	}
}
