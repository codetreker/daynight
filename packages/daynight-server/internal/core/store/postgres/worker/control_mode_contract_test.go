package worker_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	pgworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
)

func TestWorkerControlModeStoredLegacyAndLockedReadback(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, worker := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
	value := testutil.WorkerConfiguration()
	value.MaxConcurrent = 9
	if err := testutil.WriteWorker(database, ctx, func(scope WorkerScope) error {
		_, err := scope.WorkerDAO().SetWorkerConfiguration(ctx, user, worker, 7, value)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// Reproduce an existing JSONB row from before the mode capability.
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET desired_configuration=desired_configuration-'agentControlMode' WHERE user_id=$1 AND worker_id=$2`, user, worker); err != nil {
		t.Fatal(err)
	}
	first, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	firstDAO := pgworker.NewWriter(first).WorkerDAO()
	old, err := firstDAO.WorkerConfiguration(ctx, user, worker)
	if err != nil || old.Desired == nil || old.Desired.Value.AgentControlMode != nil || old.Observation != nil {
		t.Fatalf("legacy row invented mode or evidence: %+v %v", old, err)
	}
	second, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Rollback(context.Background())
	type result struct {
		value model.WorkerConfigurationResource
		err   error
	}
	readback := make(chan result, 1)
	go func() {
		value, err := pgworker.NewWriter(second).WorkerDAO().WorkerConfiguration(ctx, user, worker)
		readback <- result{value, err}
	}()
	testutil.WaitThreadBackendLock(t, database.Pool, second.Conn().PgConn().PID())
	web := model.AgentControlModeWeb
	value.AgentControlMode = &web
	if _, err := firstDAO.SetWorkerConfiguration(ctx, user, worker, 8, value); err != nil {
		t.Fatal(err)
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-readback:
		if got.err != nil || got.value.Desired == nil || got.value.Desired.Revision != "8" || got.value.Desired.Value.AgentControlMode == nil || *got.value.Desired.Value.AgentControlMode != web || got.value.Desired.Value.MaxConcurrent != 9 {
			t.Fatalf("waiting writer did not see committed selection: %+v %v", got.value, got.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := second.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var stored map[string]json.RawMessage
	var raw []byte
	if err := database.Pool.QueryRow(ctx, `SELECT desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if string(stored["agentControlMode"]) != `"web"` {
		t.Fatalf("adopted mode not stored: %s", raw)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		got, err := scope.WorkerDAO().WorkerConfiguration(ctx, user, worker)
		if err == nil && (got.Desired.Revision != "8" || got.Desired.Value.AgentControlMode == nil || *got.Desired.Value.AgentControlMode != web || got.Observation != nil || got.ObservationRevision != "0") {
			t.Errorf("persisted mode/evidence: %+v", got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerControlModeObservationRemainsReadableAcrossRollback(t *testing.T) {
	database := workerStorage(t)
	ctx := t.Context()
	user, worker := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
	mode := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, TargetRevision: "7", AppliedValue: json.RawMessage(`"web"`), State: "applied"}
	observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "7", Items: []model.WorkerConfigurationItem{mode}}
	if err := testutil.WriteWorker(database, ctx, func(scope WorkerScope) error {
		return scope.WorkerDAO().SetWorkerConfigurationObservation(ctx, user, worker, 1, observation)
	}); err != nil {
		t.Fatal(err)
	}
	var persisted []byte
	if err := database.Pool.QueryRow(ctx, `SELECT configuration_observation FROM workers WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	var legacy model.WorkerConfigurationReportedObservationWire
	if err := json.Unmarshal(persisted, &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.Items == nil || len(legacy.Items) != 0 {
		t.Fatalf("baseline observation decoder receives mode: %s", persisted)
	}
	read := func() model.WorkerConfigurationResource {
		t.Helper()
		var resource model.WorkerConfigurationResource
		if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
			var err error
			resource, err = scope.WorkerDAO().WorkerConfiguration(ctx, user, worker)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return resource
	}
	got := read()
	if got.Observation == nil || !reflect.DeepEqual(got.Observation.WorkerConfigurationObservation, observation) || !got.Observation.ReportedAt.Equal(legacy.ReportedAt) {
		t.Fatalf("new reader lost mode data: %+v", got)
	}
	// A baseline writer replaces the complete observation, discarding unknown fields.
	legacy.BaseRevision = "1"
	legacy.Items = []model.WorkerConfigurationItem{}
	replacement, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET configuration_observation_revision=2,configuration_observation=$3 WHERE user_id=$1 AND worker_id=$2`, user, worker, replacement); err != nil {
		t.Fatal(err)
	}
	got = read()
	if got.ObservationRevision != "2" || got.Observation == nil || len(got.Observation.Items) != 0 {
		t.Fatalf("new reader resurrected stale mode after legacy write: %+v", got)
	}
}
