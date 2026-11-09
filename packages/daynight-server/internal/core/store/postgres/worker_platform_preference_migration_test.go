package postgres

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestWorkerPlatformPreferenceMigrationPreservesConfigurationAndObservation(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:53]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	userID, workerID, uninitializedID := queryID(1), queryID(2), queryID(3)
	stamp := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, stamp))
	putWorkerSnapshot(t, database, workerSnapshotFixture(userID, uninitializedID, stamp))
	value := storeWorkerConfiguration()
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: queryID(4), NativeOverrides: map[string]json.RawMessage{"model": json.RawMessage(`null`)}}}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "preferPlatformSpecificTasks")
	encoded, err = json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	observation := `{"baseRevision":"7","desiredRevision":"9","items":[{"key":{"kind":"projectRemoval","projectId":"00000000-0000-4000-8000-000000000004"},"targetRevision":"8","appliedValue":null,"state":"error","error":{"code":"timeout","category":"runtime","phase":"stop","occurredAt":"2026-11-09T00:00:00Z"},"lastFailure":{"code":"timeout","category":"runtime","phase":"stop","occurredAt":"2026-11-09T00:00:00Z"},"nextAttemptAt":"2026-11-09T00:01:00Z"}],"reportedAt":"2026-11-09T00:00:00Z"}`
	mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$3,desired_configuration=$4,configuration_observation_revision=8,configuration_observation=$5 WHERE user_id=$1 AND worker_id=$2`, userID, workerID, stamp, encoded, observation)
	rows := func() []string {
		t.Helper()
		var result []string
		if err := pool.QueryRow(ctx, `SELECT array_agg((to_jsonb(w) || jsonb_build_object('desired_configuration',desired_configuration-'preferPlatformSpecificTasks'))::text ORDER BY worker_id) FROM workers w`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := rows()
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, rows()) {
		t.Fatal("preference migration changed existing worker, configuration, or observation facts")
	}
	var present bool
	if err := pool.QueryRow(ctx, `SELECT desired_configuration->'preferPlatformSpecificTasks'='false'::jsonb FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&present); err != nil || !present {
		t.Fatalf("initialized configuration did not acquire disabled preference: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		resource, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
		if err != nil {
			return err
		}
		if resource.Desired == nil || resource.Desired.Value.PreferPlatformSpecificTasks || resource.Desired.Revision != "9" || resource.ObservationRevision != "8" || resource.Observation == nil || len(resource.Observation.Items) != 1 || resource.Observation.Items[0].Key.Kind != "projectRemoval" {
			t.Fatalf("migrated resource differs: %+v", resource)
		}
		uninitialized, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, uninitializedID)
		if err == nil && (uninitialized.Desired != nil || uninitialized.Observation != nil || uninitialized.ObservationRevision != "0") {
			t.Fatalf("migration initialized an untouched worker: %+v", uninitialized)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, rows()) {
		t.Fatal("repeat migration changed configuration facts")
	}
}
