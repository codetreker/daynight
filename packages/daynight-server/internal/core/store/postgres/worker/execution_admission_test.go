package worker_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	pgworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func executionLifecycle(t *testing.T, tx pgx.Tx, user, worker, admission string) {
	t.Helper()
	execute(t, tx, `INSERT INTO worker_lifecycle(user_id,worker_id,protocol_version,intent_version,desired,admission,instance_epoch,updated_at) VALUES($1,$2,1,1,'enabled',$3,0,now())`, user, worker, admission)
}
func TestWorkerExecutionAdmissionLegacyAndLifecycle(t *testing.T) {
	db := workerStorage(t)
	ctx := t.Context()
	for _, state := range []string{"missing_worker", "legacy", "open", "closed"} {
		t.Run(state, func(t *testing.T) {
			user, worker := uuid.NewString(), uuid.NewString()
			tx := claimTransaction(t, db, ctx)
			if state != "missing_worker" {
				_, err := pgworker.NewWriter(tx).UpsertWorker(ctx, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
				if err != nil {
					t.Fatal(err)
				}
			}
			if state == "open" || state == "closed" {
				executionLifecycle(t, tx, user, worker, state)
			}
			err := pgworker.NewExecutionAdmission(tx).CheckWorkerExecution(ctx, user, worker)
			version, versionErr := pgworker.NewClaimAdmission(tx).WorkerExecutionVersion(ctx, user, worker)
			if state == "open" && (versionErr != nil || version == nil || *version != 1) {
				t.Fatalf("intent version: %v %v", version, versionErr)
			}
			if (state == "legacy" || state == "missing_worker") && (versionErr != nil || version != nil) {
				t.Fatalf("legacy intent version: %v %v", version, versionErr)
			}
			if state == "closed" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "worker_disabled" {
					t.Fatal(err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestWorkerExecutionAdmissionSerializesWithDisable(t *testing.T) {
	db := workerStorage(t)
	for _, disableFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "admission_first", true: "disable_first"}[disableFirst], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user, worker := uuid.NewString(), uuid.NewString()
			testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
			setup := claimTransaction(t, db, ctx)
			executionLifecycle(t, setup, user, worker, "open")
			if err := setup.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			holder := claimTransaction(t, db, ctx)
			if err := pgworker.NewExecutionAdmission(holder).CheckWorkerExecution(ctx, user, worker); err != nil {
				t.Fatal(err)
			}
			if disableFirst {
				execute(t, holder, `UPDATE worker_lifecycle SET admission='closed',desired='disabled' WHERE user_id=$1 AND worker_id=$2`, user, worker)
			}
			waiter, _, result := startClaimWaiter(t, ctx, db, holder, "SELECT configuration_revision", func(ctx context.Context, tx pgx.Tx) error {
				err := pgworker.NewExecutionAdmission(tx).CheckWorkerExecution(ctx, user, worker)
				if err == nil && !disableFirst {
					_, err = tx.Exec(ctx, `UPDATE worker_lifecycle SET admission='closed',desired='disabled' WHERE user_id=$1 AND worker_id=$2`, user, worker)
				}
				return err
			})
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err := testutil.ReceiveQueryResult(t, ctx, result)
			if disableFirst {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "worker_disabled" {
					t.Fatalf("post-disable admission: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if err := waiter.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			check := claimTransaction(t, db, ctx)
			var f *model.Fault
			if err := pgworker.NewExecutionAdmission(check).CheckWorkerExecution(ctx, user, worker); !errors.As(err, &f) || f.Code != "worker_disabled" {
				t.Fatalf("persisted gate: %v", err)
			}
		})
	}
}
func TestWorkerExecutionAdmissionPreservesStorageFailure(t *testing.T) {
	db := workerStorage(t)
	tx := claimTransaction(t, db, t.Context())
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	err := pgworker.NewExecutionAdmission(tx).CheckWorkerExecution(t.Context(), uuid.NewString(), uuid.NewString())
	var f *model.Fault
	if !errors.Is(err, pgx.ErrTxClosed) || !errors.As(err, &f) || f.Code != "lifecycle_unavailable" {
		t.Fatalf("lost authority failure: %v", err)
	}
}

func TestWorkerExecutionAdmissionFailsClosedOnLifecycleReadError(t *testing.T) {
	db := workerStorage(t)
	ctx := t.Context()
	user, worker := uuid.NewString(), uuid.NewString()
	testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
	tx := claimTransaction(t, db, ctx)
	execute(t, tx, `ALTER TABLE worker_lifecycle RENAME TO hidden_worker_lifecycle`)
	var fault *model.Fault
	err := pgworker.NewExecutionAdmission(tx).CheckWorkerExecution(ctx, user, worker)
	if !errors.As(err, &fault) || fault.Code != "lifecycle_unavailable" || fault.Cause == nil {
		t.Fatalf("authority absence treated as legacy: %v", err)
	}
}
