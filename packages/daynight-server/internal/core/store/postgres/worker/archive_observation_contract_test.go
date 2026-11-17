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
)

func TestArchiveObservationLegacyReplacementDoesNotReviveEvidence(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, worker := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
	archive := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "archiveSessions"}, TargetRevision: "7", AppliedValue: json.RawMessage(`false`), State: "applied"}
	mode := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, TargetRevision: "7", AppliedValue: json.RawMessage(`"web"`), State: "applied"}
	basic := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, TargetRevision: "7", AppliedValue: json.RawMessage(`3`), State: "applied"}
	observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "7", Items: []model.WorkerConfigurationItem{archive, mode, basic}}
	if err := testutil.WriteWorker(database, ctx, func(scope WorkerScope) error {
		return scope.WorkerDAO().SetWorkerConfigurationObservation(ctx, user, worker, 1, observation)
	}); err != nil {
		t.Fatal(err)
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
	if got.ObservationRevision != "1" || got.Observation == nil || !reflect.DeepEqual(got.Observation.WorkerConfigurationObservation, observation) {
		t.Fatalf("new observation not persisted: %+v", got)
	}
	var stored []byte
	if err := database.Pool.QueryRow(ctx, `SELECT configuration_observation FROM workers WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var legacy model.WorkerConfigurationReportedObservationWire
	if err := json.Unmarshal(stored, &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy.Items) != 1 || legacy.Items[0].Key.Kind != "maxConcurrent" {
		t.Fatalf("legacy inline data: %s", stored)
	}
	// The pre-extension writer stores its replacement as a complete observation.
	legacy.BaseRevision = "1"
	legacy.Items = []model.WorkerConfigurationItem{basic}
	replacement, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET configuration_observation_revision=2,configuration_observation=$3 WHERE user_id=$1 AND worker_id=$2`, user, worker, replacement); err != nil {
		t.Fatal(err)
	}
	got = read()
	if got.ObservationRevision != "2" || got.Observation == nil || got.Observation.BaseRevision != "1" || !reflect.DeepEqual(got.Observation.Items, []model.WorkerConfigurationItem{basic}) {
		t.Fatalf("legacy replacement revived obsolete evidence: %+v", got)
	}
}
