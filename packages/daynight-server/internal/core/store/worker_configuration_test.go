package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func storeWorkerConfiguration() model.WorkerConfiguration {
	return model.WorkerConfiguration{MaxConcurrent: 1, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: []model.WorkerProjectConfiguration{}}
}

func TestWorkerConfigurationMigrationPreservesWorkersAndTasks(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:33]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	stamp := time.Now().UTC()
	userID, workerID := queryID(1), queryID(2)
	original := putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, stamp))
	project := queryProject(t, database, 10)
	queryTask(t, database, project.ID, 20, model.TaskInProgress)
	before := currentTaskFactsFixture(t, database)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	after := readWorkerSnapshot(t, database, userID, workerID, stamp)
	if !reflect.DeepEqual(original, after) || !reflect.DeepEqual(before, currentTaskFactsFixture(t, database)) {
		t.Fatal("configuration migration changed telemetry or Task facts")
	}
	var resource model.WorkerConfigurationResource
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		var err error
		resource, err = snapshot.WorkerConfiguration(ctx, userID, workerID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if resource.Desired != nil || resource.Observation != nil || resource.ObservationRevision != "0" {
		t.Fatalf("legacy config synthesized: %+v", resource)
	}
	var foreignKeys int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conrelid='workers'::regclass AND contype='f'`).Scan(&foreignKeys); err != nil || foreignKeys != 0 {
		t.Fatalf("configuration introduced foreign keys: %d %v", foreignKeys, err)
	}
	for _, query := range []string{
		`UPDATE workers SET configuration_revision=1`,
		`UPDATE workers SET configuration_revision=1,configuration_updated_at=statement_timestamp()`,
		`UPDATE workers SET configuration_revision=0,configuration_updated_at=statement_timestamp(),desired_configuration='{}'`,
		`UPDATE workers SET configuration_observation_revision=-1`,
		`UPDATE workers SET configuration_observation='[]'`,
	} {
		if _, err := pool.Exec(ctx, query); err == nil {
			t.Fatalf("invalid configuration state accepted: %s", query)
		}
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerConfigurationStoredDecodeErrors(t *testing.T) {
	sentinel := errors.New("worker configuration scan failed")
	if _, err := scanWorkerConfiguration(workerSnapshotRow(func(...any) error { return sentinel })); !errors.Is(err, sentinel) {
		t.Fatalf("scan error lost: %v", err)
	}
	for _, test := range []struct{ desired, observation string }{{`{"native":"bad"}`, `null`}, {`{}`, `{"items":"bad"}`}} {
		_, err := scanWorkerConfiguration(workerSnapshotRow(func(destinations ...any) error {
			revision := int64(1)
			stamp := time.Now().UTC()
			*destinations[0].(**int64) = &revision
			*destinations[1].(**time.Time) = &stamp
			*destinations[2].(*[]byte) = []byte(test.desired)
			*destinations[4].(*[]byte) = []byte(test.observation)
			return nil
		}))
		if err == nil {
			t.Fatal("typed stored corruption hidden")
		}
	}
}

func TestWorkerConfigurationStoreFailuresRetainCauses(t *testing.T) {
	ctx := context.Background()
	database := isolatedStore(t)
	userID, workerID := queryID(1), queryID(2)
	putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, time.Now().UTC()))
	if err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		bad := storeWorkerConfiguration()
		bad.Projects = append(bad.Projects, model.WorkerProjectConfiguration{ProjectID: queryID(3), NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}})
		if _, err := tx.SetWorkerConfiguration(ctx, userID, workerID, 1, bad); err == nil {
			t.Fatal("invalid native JSON encoding hidden")
		}
		observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{{AppliedValue: json.RawMessage(`invalid`)}}}
		if err := tx.SetWorkerConfigurationObservation(ctx, userID, workerID, 1, observation); err == nil {
			t.Fatal("invalid application JSON encoding hidden")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		if err := tx.tx.Rollback(ctx); err != nil {
			return err
		}
		if _, err := tx.WorkerConfiguration(ctx, userID, workerID); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed lock failure lost: %v", err)
		}
		if _, err := tx.SetWorkerConfiguration(ctx, userID, workerID, 1, storeWorkerConfiguration()); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed update failure lost: %v", err)
		}
		if err := tx.SetWorkerConfigurationObservation(ctx, userID, workerID, 1, model.WorkerConfigurationObservation{}); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed observation clock failure lost: %v", err)
		}
		return sentinelConfigurationRollback
	}); !errors.Is(err, sentinelConfigurationRollback) {
		t.Fatalf("rollback operation error lost: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		if err := snapshot.tx.Rollback(ctx); err != nil {
			return err
		}
		_, err := snapshot.WorkerConfiguration(ctx, userID, workerID)
		if !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed read failure lost: %v", err)
		}
		return sentinelConfigurationRollback
	}); !errors.Is(err, sentinelConfigurationRollback) {
		t.Fatalf("read operation error lost: %v", err)
	}
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN configuration_observation TO missing_observation`); err != nil {
		t.Fatal(err)
	}
	if err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		return tx.SetWorkerConfigurationObservation(ctx, userID, workerID, 1, model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{}})
	}); err == nil {
		t.Fatal("observation database update failure hidden")
	}
}

var sentinelConfigurationRollback = errors.New("intentional configuration transaction rollback")

func TestWorkerConfigurationStoreReadWriteAndProjectAccess(t *testing.T) {
	database, admin, member, project := membershipFixture(t)
	ctx := context.Background()
	workerID := queryID(90)
	putWorkerSnapshot(t, database, workerSnapshotFixture(admin.UserID, workerID, time.Now().UTC()))
	value := storeWorkerConfiguration()
	var desired model.WorkerDesiredConfiguration
	if err := database.WriteWorker(ctx, func(tx *WorkerTx) error {
		current, err := tx.WorkerConfiguration(ctx, admin.UserID, workerID)
		if err != nil || current.Desired != nil || current.ObservationRevision != "0" {
			t.Fatalf("initial configuration lock: %+v %v", current, err)
		}
		if err := tx.ConfigurationProjectAccess(ctx, admin.UserID, project.ID); err != nil {
			t.Fatalf("owner Project access rejected: %v", err)
		}
		if err := tx.ConfigurationProjectAccess(ctx, member.UserID, project.ID); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("inaccessible Project exposed: %v", err)
		}
		desired, err = tx.SetWorkerConfiguration(ctx, admin.UserID, workerID, 1, value)
		if err != nil {
			return err
		}
		if desired.Revision != "1" || desired.UpdatedAt.IsZero() || !reflect.DeepEqual(desired.Value, value) {
			t.Fatalf("stored target result: %+v", desired)
		}
		observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}
		return tx.SetWorkerConfigurationObservation(ctx, admin.UserID, workerID, 1, observation)
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		current, err := snapshot.WorkerConfiguration(ctx, admin.UserID, workerID)
		if err != nil {
			return err
		}
		if current.Desired.Revision != "1" || !current.Desired.UpdatedAt.Equal(desired.UpdatedAt) || !reflect.DeepEqual(current.Desired.Value, value) || current.ObservationRevision != "1" || current.Observation == nil || current.Observation.ReportedAt.IsZero() {
			t.Fatalf("configuration did not roundtrip: %+v", current)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
