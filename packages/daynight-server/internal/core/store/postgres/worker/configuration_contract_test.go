package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	pgworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/jackc/pgx/v5"
)

func workerStorage(t *testing.T) *postgres.Store {
	t.Helper()
	return testutil.OpenStore(t, postgres.Open)
}

func TestWorkerConfigurationStoreReadWriteAndProjectAccess(t *testing.T) {
	database := workerStorage(t)
	admin, member, project := testutil.ProjectMembershipFixture(t, database)
	ctx := context.Background()
	workerID := testutil.QueryID(90)
	worker := testutil.WorkerSnapshotFixture(admin.UserID, workerID, time.Now().UTC())
	worker.Telemetry.AssistantHost = &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: worker.Telemetry.SampledAt, DefaultCwd: "/workspace", DefaultProvider: model.AgentCodex, Providers: []model.WorkerAssistantProvider{{Provider: model.AgentCodex, Available: true, Args: []string{}}}}
	worker = testutil.PutWorkerSnapshot(t, database, worker)
	value := testutil.WorkerConfiguration()
	value.MaxConcurrent, value.PollIntervalMs, value.RecoveryLimit = 64, 60000, 10
	name := testutil.WorkerStoredUTF8(256)
	value.Native.Model = &name
	value.Native.Args = make([]string, 128)
	for index := range value.Native.Args {
		value.Native.Args[index] = "x"
	}
	value.Native.Args[0] = testutil.WorkerStoredUTF8(4096)
	value.Projects = make([]model.WorkerProjectConfiguration, 128)
	for index := range value.Projects {
		value.Projects[index] = model.WorkerProjectConfiguration{ProjectID: testutil.QueryID(1000 + index), NativeOverrides: map[string]json.RawMessage{}}
	}
	observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: make([]model.WorkerConfigurationItem, 1024)}
	for index := range observation.Items {
		observation.Items[index] = model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "projectPreparation", ProjectID: testutil.QueryID(3000 + index)}, TargetRevision: "1", AppliedValue: json.RawMessage(`null`), State: "pending"}
	}
	var desired model.WorkerDesiredConfiguration
	if err := testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
		current, err := tx.WorkerDAO().WorkerConfiguration(ctx, admin.UserID, workerID)
		if err != nil || current.Desired != nil || current.ObservationRevision != "0" {
			t.Fatalf("initial configuration lock: %+v %v", current, err)
		}
		if err := tx.WorkerDAO().ConfigurationProjectAccess(ctx, admin.UserID, project.ID); err != nil {
			t.Fatalf("owner Project access rejected: %v", err)
		}
		if err := tx.WorkerDAO().ConfigurationProjectAccess(ctx, member.UserID, project.ID); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("inaccessible Project exposed: %v", err)
		}
		desired, err = tx.WorkerDAO().SetWorkerConfiguration(ctx, admin.UserID, workerID, 1, value)
		if err != nil {
			return err
		}
		if desired.Revision != "1" || desired.UpdatedAt.IsZero() || !reflect.DeepEqual(desired.Value, value) {
			t.Fatalf("stored target result: %+v", desired)
		}
		return tx.WorkerDAO().SetWorkerConfigurationObservation(ctx, admin.UserID, workerID, 1, observation)
	}); err != nil {
		t.Fatal(err)
	}
	var stored model.WorkerConfigurationResource
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		current, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, admin.UserID, workerID)
		if err != nil {
			return err
		}
		if current.Desired.Revision != "1" || !current.Desired.UpdatedAt.Equal(desired.UpdatedAt) || !reflect.DeepEqual(current.Desired.Value, value) || current.ObservationRevision != "1" || current.Observation == nil || current.Observation.ReportedAt.IsZero() || !reflect.DeepEqual(current.Observation.WorkerConfigurationObservation, observation) {
			t.Fatalf("configuration did not roundtrip: %+v", current)
		}
		stored = current
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	worker.LastReportedAt = worker.LastReportedAt.Add(time.Second)
	worker.Telemetry.AssistantHost = nil
	legacy := testutil.PutWorkerSnapshot(t, database, worker)
	if legacy.Telemetry.AssistantHost != nil || !legacy.LastReportedAt.Equal(worker.LastReportedAt) {
		t.Fatalf("legacy heartbeat retained stale assistant-host telemetry: %#v", legacy)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		current, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, admin.UserID, workerID)
		if err == nil && !reflect.DeepEqual(current, stored) {
			t.Fatal("legacy heartbeat changed committed configuration or observation state")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerConfigurationDAOFailuresRetainCauses(t *testing.T) {
	database := workerStorage(t)
	ctx := context.Background()
	userID, workerID := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(userID, workerID, time.Now().UTC()))
	if err := testutil.WriteWorker(database, ctx, func(scope WorkerScope) error {
		_, err := scope.WorkerDAO().SetWorkerConfiguration(ctx, userID, workerID, 1, testutil.WorkerConfiguration())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	dao := pgworker.NewWriter(tx).WorkerDAO()
	if _, err := dao.WorkerConfiguration(ctx, userID, workerID); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed lock failure lost: %v", err)
	}
	if _, err := dao.SetWorkerConfiguration(ctx, userID, workerID, 1, testutil.WorkerConfiguration()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed update failure lost: %v", err)
	}
	if err := dao.SetWorkerConfigurationObservation(ctx, userID, workerID, 1, model.WorkerConfigurationObservation{}); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed observation clock failure lost: %v", err)
	}
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN configuration_observation TO missing_observation`); err != nil {
		t.Fatal(err)
	}
	if err := testutil.WriteWorker(database, ctx, func(tx WorkerScope) error {
		return tx.WorkerDAO().SetWorkerConfigurationObservation(ctx, userID, workerID, 1, model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{}})
	}); err == nil {
		t.Fatal("observation database update failure hidden")
	}
}
