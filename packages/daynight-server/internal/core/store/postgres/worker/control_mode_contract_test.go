package worker_test

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestWorkerControlModeObservationRemainsReadableAcrossRollback(t *testing.T) {
	database := workerStorage(t)
	ctx := t.Context()
	user, worker := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
	mode := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, TargetRevision: "7", AppliedValue: json.RawMessage(`"web"`), State: "applied"}
	observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "7", Items: []model.WorkerConfigurationItem{mode}}
	legacyBytes, err := json.Marshal(map[string]any{"baseRevision": "0", "desiredRevision": "7", "items": []any{}, "reportedAt": time.Now().UTC(), "controlModeObservation": map[string]any{"index": 0, "item": mode}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET configuration_observation_revision=1,configuration_observation=$3 WHERE user_id=$1 AND worker_id=$2`, user, worker, legacyBytes); err != nil {
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
