package worker_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func lifecycleRow(user, id string) model.WorkerLifecycle {
	instance, operation, capability := uuid.NewString(), uuid.NewString(), 1
	return model.WorkerLifecycle{UserID: user, WorkerID: id, ProtocolVersion: 1, IntentVersion: 9223372036854775807, Desired: "disabled", Admission: "closed", CurrentOperationID: &operation, InstanceID: &instance, CapabilityVersion: &capability, BootstrapConsumed: true, UpdatedAt: time.Now().UTC().Truncate(time.Microsecond)}
}

func lifecycleWrite(t *testing.T, db *postgres.Store, fn func(store.WorkerLifecycleScope) error) {
	t.Helper()
	completion, err := db.WriteWorkerLifecycle(t.Context(), fn)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("lifecycle write: %+v %v", completion, err)
	}
}

func TestLifecycleRowsPersistAndRemainOwnerScoped(t *testing.T) {
	db := workerStorage(t)
	user, id := uuid.NewString(), uuid.NewString()
	testutil.PutWorkerSnapshot(t, db, snapshot(user, id, time.Now().UTC()))
	state := lifecycleRow(user, id)
	op := model.LifecycleOperation{UserID: user, WorkerID: id, OperationID: *state.CurrentOperationID, Action: "disable", Source: "web", RequestKind: "intent", RequestHash: bytes.Repeat([]byte{1}, 32), Request: json.RawMessage(`{"action":"disable"}`), IntentVersion: state.IntentVersion, State: "accepted", Receipt: json.RawMessage(`{"state":"accepted"}`), ActivationOutcome: "not_started", CreatedAt: state.UpdatedAt, UpdatedAt: state.UpdatedAt}
	observation := model.LifecycleStoredObservation{UserID: user, WorkerID: id, ReceivedAt: state.UpdatedAt, Envelope: model.LifecycleObservationEnvelope{ProtocolVersion: 1, InstanceID: *state.InstanceID, IntentVersion: "9223372036854775807", LocalEpoch: "2", ScopeGeneration: "3", ReportSequence: "5", OperationID: state.CurrentOperationID}}
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		d := s.LifecycleDAO()
		if err := d.LockWorker(t.Context(), user, id); err != nil {
			return err
		}
		if err := d.SaveLifecycle(t.Context(), state); err != nil {
			return err
		}
		if err := d.SaveOperation(t.Context(), op); err != nil {
			return err
		}
		return d.SaveObservation(t.Context(), observation)
	})
	check := func() {
		t.Helper()
		if err := db.ReadWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleSnapshot) error {
			d := s.LifecycleDAO()
			got, err := d.Lifecycle(t.Context(), user, id)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(got, state) {
				t.Fatalf("state changed: %+v want %+v", got, state)
			}
			saved, err := d.Operation(t.Context(), user, id, op.OperationID)
			if err != nil {
				return err
			}
			normalizeLifecycleJSON(t, &saved)
			normalizeLifecycleJSON(t, &op)
			if !reflect.DeepEqual(saved, op) {
				t.Fatalf("operation changed: %+v want %+v", saved, op)
			}
			report, err := d.Observation(t.Context(), user, id)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(report, observation) {
				t.Fatalf("observation changed: %+v want %+v", report, observation)
			}
			for _, foreign := range []string{uuid.NewString()} {
				if _, err := d.Lifecycle(t.Context(), foreign, id); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("foreign lifecycle: %v", err)
				}
				if _, err := d.Operation(t.Context(), foreign, id, op.OperationID); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("foreign operation: %v", err)
				}
				if _, err := d.Observation(t.Context(), foreign, id); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("foreign observation: %v", err)
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	check()
	// Reopening the service storage cannot reconstruct a default enabled intent.
	reopened, err := postgres.Open(t.Context(), db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	original := db
	db = reopened
	check()
	db = original
	op.State = "applied"
	op.Receipt = json.RawMessage(`{"state":"applied"}`)
	op.Activation = json.RawMessage(`{"admission":"open"}`)
	op.ActivationRequest = json.RawMessage(`{"scopeGeneration":"3"}`)
	op.ActivationHash = bytes.Repeat([]byte{2}, 32)
	op.ActivationOutcome = "committed"
	observation.Envelope.ReportSequence = "6"
	state.IntentVersion = 7
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		d := s.LifecycleDAO()
		if err := d.LockWorker(t.Context(), user, id); err != nil {
			return err
		}
		if err := d.SaveLifecycle(t.Context(), state); err != nil {
			return err
		}
		if err := d.SaveOperation(t.Context(), op); err != nil {
			return err
		}
		return d.SaveObservation(t.Context(), observation)
	})
	check()
	mutated := op
	mutated.RequestHash = bytes.Repeat([]byte{3}, 32)
	completion, err := db.WriteWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleScope) error { return s.LifecycleDAO().SaveOperation(t.Context(), mutated) })
	var fault *model.Fault
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &fault) || fault.Code != "operation_conflict" {
		t.Fatalf("original request overwritten: %+v %v", completion, err)
	}
	check()
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		return s.LifecycleDAO().DeleteObservation(t.Context(), user, id)
	})
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		return s.LifecycleDAO().DeleteObservation(t.Context(), user, id)
	})
	if err := db.ReadWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleSnapshot) error {
		_, err := s.LifecycleDAO().Observation(t.Context(), user, id)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted observation remains: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLifecycleWorkerLockOrdersClaimAndLifecycleWrites(t *testing.T) {
	db := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, id := uuid.NewString(), uuid.NewString()
	testutil.PutWorkerSnapshot(t, db, snapshot(user, id, time.Now().UTC()))
	first, second := claimTransaction(t, db, ctx), claimTransaction(t, db, ctx)
	if _, err := worker.NewClaimAdmission(first).ClaimWorkerConfiguration(ctx, user, id); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- worker.NewLifecycle(second).LockWorker(ctx, user, id) }()
	testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	state := lifecycleRow(user, id)
	if err := worker.NewLifecycle(second).SaveLifecycle(ctx, state); err != nil {
		t.Fatal(err)
	}
	third := claimTransaction(t, db, ctx)
	go func() {
		_, err := worker.NewClaimAdmission(third).ClaimWorkerConfiguration(ctx, user, id)
		result <- err
	}()
	testutil.WaitThreadBackendLock(t, db.Pool, third.Conn().PgConn().PID())
	if err := second.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	got, err := worker.NewLifecycle(third).Lifecycle(ctx, user, id)
	if err != nil || got.Admission != "closed" {
		t.Fatalf("claim did not observe prior disable: %+v %v", got, err)
	}
}

func TestLifecycleRollbackMissingWorkerAndCanceledLock(t *testing.T) {
	db := workerStorage(t)
	user, id := uuid.NewString(), uuid.NewString()
	missing, err := db.WriteWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleScope) error { return s.LifecycleDAO().LockWorker(t.Context(), user, id) })
	if missing.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing worker created: %+v %v", missing, err)
	}
	testutil.PutWorkerSnapshot(t, db, snapshot(user, id, time.Now().UTC()))
	reason := errors.New("stop before commit")
	state := lifecycleRow(user, id)
	completion, err := db.WriteWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleScope) error {
		if err := s.LifecycleDAO().SaveLifecycle(t.Context(), state); err != nil {
			return err
		}
		return reason
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, reason) {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	if err := db.ReadWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleSnapshot) error {
		_, err := s.LifecycleDAO().Lifecycle(t.Context(), user, id)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("rollback persisted: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	holder := claimTransaction(t, db, t.Context())
	if err := worker.NewLifecycle(holder).LockWorker(t.Context(), user, id); err != nil {
		t.Fatal(err)
	}
	waiter := claimTransaction(t, db, t.Context())
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- worker.NewLifecycle(waiter).LockWorker(ctx, user, id) }()
	testutil.WaitThreadBackendLock(t, db.Pool, waiter.Conn().PgConn().PID())
	cancel()
	if err := testutil.ReceiveQueryResult(t, t.Context(), result); !errors.Is(err, context.Canceled) {
		t.Fatalf("lock cancellation: %v", err)
	}
}

func TestLifecycleStorageErrorsRetainDriverCause(t *testing.T) {
	tx := workerTransaction(t)
	d := worker.NewLifecycle(tx)
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	user, id := uuid.NewString(), uuid.NewString()
	state := lifecycleRow(user, id)
	cases := []func() error{
		func() error { return d.LockWorker(t.Context(), user, id) },
		func() error { _, err := d.Lifecycle(t.Context(), user, id); return err },
		func() error { return d.SaveLifecycle(t.Context(), state) },
		func() error { _, err := d.Operation(t.Context(), user, id, uuid.NewString()); return err },
		func() error { return d.SaveOperation(t.Context(), model.LifecycleOperation{}) },
		func() error { _, err := d.Observation(t.Context(), user, id); return err },
		func() error { return d.SaveObservation(t.Context(), model.LifecycleStoredObservation{}) },
		func() error { return d.DeleteObservation(t.Context(), user, id) },
	}
	for _, call := range cases {
		if err := call(); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("lost driver cause: %v", err)
		}
	}
}

func normalizeLifecycleJSON(t *testing.T, op *model.LifecycleOperation) {
	t.Helper()
	for _, raw := range []*json.RawMessage{&op.Request, &op.Receipt, &op.Activation, &op.ActivationRequest} {
		if *raw == nil {
			continue
		}
		var v any
		if err := json.Unmarshal(*raw, &v); err != nil {
			t.Fatal(err)
		}
		next, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		*raw = next
	}
}
