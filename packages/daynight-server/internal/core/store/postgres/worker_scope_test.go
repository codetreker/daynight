package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
)

var workerSnapshotFixture = testutil.WorkerSnapshotFixture
var workerStoredUTF8 = testutil.WorkerStoredUTF8
var putWorkerSnapshot = testutil.PutWorkerSnapshot
var readWorkerSnapshot = testutil.ReadWorkerSnapshot
var writeWorkerForTest = testutil.WriteWorker
var storeWorkerConfiguration = testutil.WorkerConfiguration
var sentinelConfigurationRollback = errors.New("intentional configuration transaction rollback")

func setSnapshotTaskClaim(t *testing.T, database *Store, projectID string, taskNumber int, owner, workerID string) model.WorkerTaskReference {
	t.Helper()
	return testutil.SetSnapshotTaskClaim(t, database.Pool, database, projectID, taskNumber, owner, workerID)
}

func TestWorkerSnapshotErrorsRollbackAndPreserveCauses(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	want := errors.New("observation unavailable")
	err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		if _, err := tx.WorkerDAO().UpsertWorker(ctx, worker); err != nil {
			return err
		}
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("write did not preserve callback cause: %v", err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM workers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed worker transaction committed: %d %v", count, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := writeWorkerForTest(database, canceled, func(WorkerScope) error { t.Error("canceled transaction entered"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled transaction: %v", err)
	}

}

func TestWorkerConfigurationStoreFailuresRetainCauses(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx := context.Background()
	database := isolatedStore(t)
	userID, workerID := queryID(1), queryID(2)
	worker := putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, time.Now().UTC()))
	if err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		_, err := tx.WorkerDAO().SetWorkerConfiguration(ctx, userID, workerID, 1, storeWorkerConfiguration())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := database.Pool.QueryRow(ctx, `SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func(WorkerWriteDAO) error{
		func(dao WorkerWriteDAO) error {
			bad := storeWorkerConfiguration()
			bad.Projects = append(bad.Projects, model.WorkerProjectConfiguration{ProjectID: queryID(3), NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}})
			_, err := dao.SetWorkerConfiguration(ctx, userID, workerID, 2, bad)
			return err
		},
		func(dao WorkerWriteDAO) error {
			observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{{AppliedValue: json.RawMessage(`invalid`)}}}
			return dao.SetWorkerConfigurationObservation(ctx, userID, workerID, 1, observation)
		},
	} {
		var encodingFailure error
		completion, err := database.WriteWorker(ctx, func(tx WorkerScope) error {
			updated := worker
			updated.LastReportedAt = worker.LastReportedAt.Add(time.Second)
			updated.Telemetry.Machine.Name = "Uncommitted replacement"
			written, err := tx.WorkerDAO().UpsertWorker(ctx, updated)
			if err != nil {
				return err
			}
			if written.Telemetry.Machine.Name != updated.Telemetry.Machine.Name {
				t.Fatal("configuration failure did not follow the actual telemetry write")
			}
			encodingFailure = operation(tx.WorkerDAO())
			return encodingFailure
		})
		var after string
		if readErr := database.Pool.QueryRow(ctx, `SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&after); readErr != nil {
			t.Fatal(readErr)
		}
		if encodingFailure == nil || !errors.Is(err, encodingFailure) || completion.Outcome != TransactionNotCommitted || before != after {
			t.Fatalf("encoding failure lost its cause or partially committed telemetry/configuration: %+v %v", completion, err)
		}
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if err := snapshot.(*Snapshot).tx.Rollback(ctx); err != nil {
			return err
		}
		_, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
		if !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed read failure lost: %v", err)
		}
		return sentinelConfigurationRollback
	}); !errors.Is(err, sentinelConfigurationRollback) {
		t.Fatalf("read operation error lost: %v", err)
	}
}
