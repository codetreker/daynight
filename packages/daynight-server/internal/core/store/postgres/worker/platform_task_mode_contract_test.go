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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func TestPlatformTaskModeConfigurationTransactionContract(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	userID, workerID := testutil.QueryID(1), testutil.QueryID(2)
	principal := model.Principal{UserID: userID}
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(userID, workerID, time.Now().UTC()))
	value := testutil.WorkerConfiguration()
	value.TaskTagFilter = &model.TagNameFilter{Names: []string{}, Match: "any"}
	if err := testutil.WriteWorker(database, ctx, func(scope WorkerScope) error {
		if _, err := scope.WorkerDAO().SetWorkerConfiguration(ctx, userID, workerID, 1, value); err != nil {
			return err
		}
		return scope.WorkerDAO().SetWorkerConfigurationObservation(ctx, userID, workerID, 1, model.WorkerConfigurationObservation{
			BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "platformTaskMode"}, TargetRevision: "1", AppliedValue: json.RawMessage(`"all"`), State: "applied"}},
		})
	}); err != nil {
		t.Fatal(err)
	}
	read := func() model.WorkerConfigurationResource {
		t.Helper()
		var result model.WorkerConfigurationResource
		if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
			var err error
			result, err = scope.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	put := func(expected int64, candidate model.WorkerConfiguration) error {
		t.Helper()
		completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
			_, err := workercore.PutConfiguration(ctx, scope.WorkerDAO(), principal, workerID, expected, candidate)
			return err
		})
		if err == nil && completion.Outcome != TransactionCommitted || err != nil && completion.Outcome != TransactionNotCommitted {
			t.Fatalf("unexpected completion: %+v %v", completion, err)
		}
		return err
	}
	value.PlatformTaskMode = model.PlatformTaskOnly
	if err := put(1, value); err != nil {
		t.Fatal(err)
	}
	strict := read()
	if strict.Desired.Revision != "2" || strict.Desired.Value.PlatformTaskMode != model.PlatformTaskOnly || string(strict.Observation.Items[0].AppliedValue) != `"all"` {
		t.Fatalf("save lost target or changed application: %+v", strict)
	}
	legacy, err := workercore.ParseWorkerConfigurationProtocol(json.RawMessage(`{"maxConcurrent":2,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":true,"native":{"agent":"codex","model":null,"args":[]},"projects":[]}`), workerprotocol.Capabilities{})
	if err != nil {
		t.Fatal(err)
	}
	if err := put(2, legacy); err != nil {
		t.Fatal(err)
	}
	retained := read()
	if retained.Desired.Revision != "3" || retained.Desired.Value.PlatformTaskMode != model.PlatformTaskOnly || retained.Desired.Value.MaxConcurrent != 2 {
		t.Fatalf("legacy edit lost strict target: %+v", retained)
	}
	legacy.PlatformTaskMode = model.PlatformTaskAll
	if err := put(3, legacy); err == nil || !reflect.DeepEqual(retained, read()) {
		t.Fatalf("legacy projection change did not roll back: %v", err)
	}
	if err := put(2, value); err == nil {
		t.Fatal("stale configuration write succeeded")
	} else {
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "version_conflict" || !reflect.DeepEqual(retained, read()) {
			t.Fatalf("stale write changed state: %v", err)
		}
	}
	if err := testutil.WriteWorker(database, ctx, func(scope WorkerScope) error {
		return scope.WorkerDAO().SetWorkerConfigurationObservation(ctx, userID, workerID, 2, model.WorkerConfigurationObservation{
			BaseRevision: "1", DesiredRevision: "3", Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "preferPlatformSpecificTasks"}, TargetRevision: "3", AppliedValue: json.RawMessage(`true`), State: "applied"}},
		})
	}); err != nil {
		t.Fatal(err)
	}
	value.PlatformTaskMode = model.PlatformTaskAll
	if err := put(3, value); err != nil {
		t.Fatalf("explicit exit without support: %v", err)
	}
	exited := read()
	value.PlatformTaskMode = model.PlatformTaskOnly
	if err := put(4, value); err == nil || !reflect.DeepEqual(exited, read()) {
		t.Fatalf("old observation enabled strict target: %v", err)
	}
}
