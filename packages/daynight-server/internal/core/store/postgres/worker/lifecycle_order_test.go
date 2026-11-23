package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/google/uuid"
)

func TestLifecycleResolveSerializesWithOriginalRegistration(t *testing.T) {
	db := workerStorage(t)
	for _, originalFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "resolve first", true: "original first"}[originalFirst], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user, id := uuid.NewString(), uuid.NewString()
			now := time.Now().UTC()
			testutil.PutWorkerSnapshot(t, db, snapshot(user, id, now))
			request := model.LifecycleInstanceRequest{ProtocolVersion: 1, OperationID: uuid.NewString(), InstanceID: uuid.NewString(), Capabilities: model.LifecycleCapabilities{Disable: true, Resume: true, Inventory: 1, DispatchFence: 1}, Platform: "linux"}
			raw, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			resolve := model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "instance", Request: raw}
			first, second := claimTransaction(t, db, ctx), claimTransaction(t, db, ctx)
			one, two := worker.NewLifecycle(first), worker.NewLifecycle(second)
			var result model.LifecycleOperationResult
			done := make(chan error, 1)
			if originalFirst {
				if _, err := core.LifecycleRegister(ctx, one, user, id, request, now); err != nil {
					t.Fatal(err)
				}
				go func() {
					var e error
					result, e = core.LifecycleResolve(ctx, two, user, id, request.OperationID, resolve, now)
					done <- e
				}()
			} else {
				result, err = core.LifecycleResolve(ctx, one, user, id, request.OperationID, resolve, now)
				if err != nil || result.Kind != "not_committed" {
					t.Fatalf("resolve: %+v %v", result, err)
				}
				go func() { _, e := core.LifecycleRegister(ctx, two, user, id, request, now); done <- e }()
			}
			testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
			if err := first.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = testutil.ReceiveQueryResult(t, ctx, done)
			if originalFirst {
				if err != nil || result.Kind != "instance" {
					t.Fatalf("committed original not recovered: %+v %v", result, err)
				}
				if err := second.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "operation_resolved_not_committed" {
					t.Fatalf("late original executed: %v", err)
				}
				if err := second.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if err := db.ReadWorkerLifecycle(ctx, func(s store.WorkerLifecycleSnapshot) error {
				op, err := s.LifecycleDAO().Operation(ctx, user, id, request.OperationID)
				if err != nil {
					return err
				}
				state, readErr := s.LifecycleDAO().Lifecycle(ctx, user, id)
				if originalFirst {
					if readErr != nil || state.InstanceEpoch != 1 || op.State != "applied" {
						t.Fatalf("registration changed more than once: %+v %+v %v", state, op, readErr)
					}
				} else if !errors.Is(readErr, model.ErrNotFound) || op.State != "not_committed" {
					t.Fatalf("tombstone created lifecycle: %+v %+v %v", state, op, readErr)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLifecycleIntentCASAndActivationResolutionPersist(t *testing.T) {
	db := workerStorage(t)
	user, id := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	testutil.PutWorkerSnapshot(t, db, snapshot(user, id, now))
	request := model.LifecycleInstanceRequest{ProtocolVersion: 1, OperationID: uuid.NewString(), InstanceID: uuid.NewString(), Capabilities: model.LifecycleCapabilities{Disable: true, Resume: true, Inventory: 1, DispatchFence: 1}, Platform: "linux"}
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		_, err := core.LifecycleRegister(t.Context(), s.LifecycleDAO(), user, id, request, now)
		return err
	})
	disable := model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: uuid.NewString(), Action: "disable", ExpectedVersion: "1", Source: "web"}
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		_, err := core.LifecycleIntent(t.Context(), s.LifecycleDAO(), user, id, disable, now)
		return err
	})
	stale := disable
	stale.OperationID = uuid.NewString()
	completion, err := db.WriteWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleScope) error {
		_, err := core.LifecycleIntent(t.Context(), s.LifecycleDAO(), user, id, stale, now)
		return err
	})
	var fault *model.Fault
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale version: %+v %v", completion, err)
	}
	// A lost activation response is resolved independently of the accepted resume.
	resumeID := uuid.NewString()
	resume := model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: resumeID, Action: "resume", ExpectedVersion: "2", Source: "web"}
	epoch := "1"
	resume.LocalEpoch = &epoch
	resume.InstanceEpoch = &epoch
	zero := int64(0)
	obs := model.LifecycleObservationEnvelope{ProtocolVersion: 1, InstanceID: request.InstanceID, InstanceEpoch: "1", IntentVersion: "2", OperationID: &disable.OperationID, LocalEpoch: "1", ScopeGeneration: "1", ReportSequence: "1", Observation: model.LifecycleObservation{Phase: "disabled", Stop: "confirmed", Save: "durable", Sync: "complete", InventoryComplete: true, DetailsComplete: true, InventoryRevision: "1", InventoryDigest: "0000000000000000000000000000000000000000000000000000000000000000", ResourceCount: &zero, StoppedCount: &zero, PendingCount: &zero, BlockedCount: &zero, Resources: []model.LifecycleResourceObservation{}, Recovery: []model.LifecycleRecoveryObservation{}}}
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		_, err := core.LifecycleObserve(t.Context(), s.LifecycleDAO(), user, id, obs, now)
		return err
	})
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		_, err := core.LifecycleIntent(t.Context(), s.LifecycleDAO(), user, id, resume, now)
		return err
	})
	activation := model.LifecycleActivationRequest{ProtocolVersion: 1, OperationID: resumeID, InstanceID: request.InstanceID, InstanceEpoch: "1", IntentVersion: "3", LocalEpoch: "1", ScopeGeneration: "2", ReportSequence: "2"}
	raw, err := json.Marshal(activation)
	if err != nil {
		t.Fatal(err)
	}
	lifecycleWrite(t, db, func(s store.WorkerLifecycleScope) error {
		result, err := core.LifecycleResolve(t.Context(), s.LifecycleDAO(), user, id, resumeID, model.LifecycleResolveRequest{ProtocolVersion: 1, RequestKind: "activation", Request: raw}, now)
		if err == nil && (result.Kind != "intent" || result.ActivationOutcome != "not_committed") {
			t.Fatalf("intent overwritten: %+v", result)
		}
		return err
	})
	completion, err = db.WriteWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleScope) error {
		_, err := core.LifecycleActivate(t.Context(), s.LifecycleDAO(), user, id, activation, now)
		return err
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &fault) || fault.Code != "operation_resolved_not_committed" {
		t.Fatalf("late activation: %+v %v", completion, err)
	}
	if err := db.ReadWorkerLifecycle(t.Context(), func(s store.WorkerLifecycleSnapshot) error {
		state, err := s.LifecycleDAO().Lifecycle(t.Context(), user, id)
		if err != nil {
			return err
		}
		if state.Admission != "closed" || state.IntentVersion != 3 {
			t.Fatalf("late activation opened: %+v", state)
		}
		op, err := s.LifecycleDAO().Operation(t.Context(), user, id, resumeID)
		if err == nil && (op.State != "accepted" || op.ActivationOutcome != "not_committed" || len(op.Activation) != 0) {
			t.Fatalf("resume lost: %+v", op)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
