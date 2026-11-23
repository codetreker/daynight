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

func TestSudoCleanupConfigurationTransactionContract(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	userID, workerID := testutil.QueryID(1), testutil.QueryID(2)
	principal := model.Principal{UserID: userID}
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(userID, workerID, time.Now().UTC()))

	const oldValue = `{"maxConcurrent":1,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[]},"projects":[]}`
	const editedValue = `{"maxConcurrent":2,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[]},"projects":[]}`
	const enableValue = `{"maxConcurrent":1,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"enableSudoCleanup":true,"native":{"agent":"codex","model":null,"args":[]},"projects":[]}`
	const disableValue = `{"maxConcurrent":2,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"enableSudoCleanup":false,"native":{"agent":"codex","model":null,"args":[]},"projects":[]}`
	parse := func(raw string) model.WorkerConfiguration {
		t.Helper()
		value, err := workercore.ParseWorkerConfigurationProtocol(json.RawMessage(raw), workerprotocol.Capabilities{})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	read := func() model.WorkerConfigurationResource {
		t.Helper()
		var result model.WorkerConfigurationResource
		err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
			var err error
			result, err = scope.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	put := func(expected int64, raw string) (model.WorkerConfigurationResource, error) {
		t.Helper()
		value := parse(raw)
		var result model.WorkerConfigurationResource
		completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
			var err error
			result, err = workercore.PutConfiguration(ctx, scope.WorkerDAO(), principal, workerID, expected, value)
			return err
		})
		if err == nil && completion.Outcome != TransactionCommitted {
			t.Fatalf("write did not commit: %+v", completion)
		}
		if err != nil && completion.Outcome != TransactionNotCommitted {
			t.Fatalf("failed write was not rolled back: %+v %v", completion, err)
		}
		return result, err
	}
	exchange := func(raw string) *model.WorkerConfigurationReceipt {
		t.Helper()
		input, err := workercore.ParseWorkerConfigurationExchangeProtocol(json.RawMessage(raw), workerprotocol.Capabilities{})
		if err != nil {
			t.Fatal(err)
		}
		var receipt *model.WorkerConfigurationReceipt
		completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
			var err error
			receipt, err = workercore.ExchangeConfiguration(ctx, scope.WorkerDAO(), principal, workerID, *input)
			return err
		})
		if err != nil || completion.Outcome != TransactionCommitted {
			t.Fatalf("exchange did not commit: %+v %v", completion, err)
		}
		return receipt
	}
	if got := read(); got.Desired != nil {
		t.Fatalf("new worker already had desired configuration: %+v", got)
	}
	boot := exchange(`{"bootstrap":` + oldValue + `,"observation":null}`)
	if boot.Desired == nil || boot.Desired.Revision != "1" || boot.Desired.Value.EnableSudoCleanup {
		t.Fatalf("old bootstrap: %+v", boot)
	}
	if got := read(); got.Desired == nil || got.Desired.Revision != "1" || got.Desired.Value.EnableSudoCleanup {
		t.Fatalf("bootstrap readback: %+v", got)
	}
	if _, err := put(1, enableValue); err != nil {
		t.Fatal(err)
	}
	if got := read(); got.Desired.Revision != "2" || !got.Desired.Value.EnableSudoCleanup {
		t.Fatalf("explicit true readback: %+v", got)
	}
	if _, err := put(2, editedValue); err != nil {
		t.Fatal(err)
	}
	updated := read()
	if updated.Desired.Revision != "3" || !updated.Desired.Value.EnableSudoCleanup || updated.Desired.Value.MaxConcurrent != 2 || updated.Desired.Value.PreserveSudoCleanup {
		t.Fatalf("omitted edit readback: %+v", updated)
	}
	if _, err := put(3, editedValue); err != nil || !reflect.DeepEqual(read(), updated) {
		t.Fatalf("omitted no-op changed stored resource: %v", err)
	}
	_, err := put(2, disableValue)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" || !reflect.DeepEqual(read(), updated) {
		t.Fatalf("stale replacement changed stored resource: %v", err)
	}
	first := exchange(`{"bootstrap":` + oldValue + `,"observation":{"baseRevision":"0","desiredRevision":"3","items":[{"key":{"kind":"enableSudoCleanup"},"targetRevision":"3","appliedValue":true,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}]}}`)
	if !first.ObservationAccepted || first.ObservationRevision != "1" || !first.Desired.Value.EnableSudoCleanup || first.Desired.Revision != "3" {
		t.Fatalf("late bootstrap and observation: %+v", first)
	}
	observed := read()
	if observed.Desired.Revision != "3" || !observed.Desired.Value.EnableSudoCleanup || observed.Observation == nil || len(observed.Observation.Items) != 1 || observed.Observation.Items[0].Key.Kind != "enableSudoCleanup" || string(observed.Observation.Items[0].AppliedValue) != "true" {
		t.Fatalf("observation readback: %+v", observed)
	}
	oldReport := exchange(`{"bootstrap":` + oldValue + `,"observation":{"baseRevision":"1","desiredRevision":"3","items":[{"key":{"kind":"maxConcurrent"},"targetRevision":"3","appliedValue":2,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}]}}`)
	if !oldReport.ObservationAccepted || oldReport.ObservationRevision != "2" || !oldReport.Desired.Value.EnableSudoCleanup || oldReport.Desired.Revision != "3" {
		t.Fatalf("old report changed desired: %+v", oldReport)
	}
	replaced := read()
	if replaced.Desired.Revision != "3" || !replaced.Desired.Value.EnableSudoCleanup || replaced.ObservationRevision != "2" || replaced.Observation == nil || len(replaced.Observation.Items) != 1 || replaced.Observation.Items[0].Key.Kind != "maxConcurrent" {
		t.Fatalf("old report did not replace observation: %+v", replaced)
	}
	if _, err := put(3, disableValue); err != nil {
		t.Fatal(err)
	}
	if got := read(); got.Desired.Revision != "4" || got.Desired.Value.EnableSudoCleanup || got.Desired.Value.MaxConcurrent != 2 || got.ObservationRevision != "2" {
		t.Fatalf("explicit false readback: %+v", got)
	}
}
