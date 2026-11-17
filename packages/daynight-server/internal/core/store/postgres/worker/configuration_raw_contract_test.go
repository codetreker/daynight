package worker_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func TestUnsupportedStoredTargetReadAndExplicitReplacement(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, worker := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(user, worker, time.Now().UTC()))
	candidate := testutil.WorkerConfiguration()
	if err := testutil.WriteWorker(database, ctx, func(scope store.WorkerScope) error {
		_, err := scope.WorkerDAO().SetWorkerConfiguration(ctx, user, worker, 7, candidate)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET desired_configuration = jsonb_set(desired_configuration, '{unsupportedSetting}', '{"value":"retained"}'::jsonb) WHERE user_id=$1 AND worker_id=$2`, user, worker); err != nil {
		t.Fatal(err)
	}
	read := func() model.WorkerConfigurationResource {
		t.Helper()
		var result model.WorkerConfigurationResource
		if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
			var err error
			result, err = scope.WorkerDAO().WorkerConfiguration(ctx, user, worker)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := read()
	var old map[string]json.RawMessage
	if before.Desired == nil || before.Desired.Revision != "7" || json.Unmarshal(before.Desired.RawValue, &old) != nil || len(old["unsupportedSetting"]) == 0 {
		t.Fatalf("stored target lost: %+v", before)
	}
	choices := model.WorkerToolPaths{Codex: &model.ToolPathChoice{Kind: "auto"}, Copilot: &model.ToolPathChoice{Kind: "auto"}}
	if err := testutil.WriteWorker(database, ctx, func(scope store.WorkerScope) error {
		receipt, err := workercore.ExchangeConfiguration(ctx, scope.WorkerDAO(), model.Principal{UserID: user}, worker, model.WorkerConfigurationExchange{ToolPathsBootstrap: &choices})
		if err == nil && (receipt.Desired == nil || receipt.Desired.Revision != "7") {
			t.Fatal("report rewrote unsupported target")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	afterReport := read()
	if !configurationJSONEqual(before.Desired, afterReport.Desired) {
		t.Fatal("report changed stored target")
	}
	if err := testutil.WriteWorker(database, ctx, func(scope store.WorkerScope) error {
		_, err := workercore.PutConfiguration(ctx, scope.WorkerDAO(), model.Principal{UserID: user}, worker, 7, candidate)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	replaced := read()
	var newValue map[string]json.RawMessage
	if replaced.Desired == nil || replaced.Desired.Revision != "8" || json.Unmarshal(replaced.Desired.RawValue, &newValue) != nil || len(newValue["unsupportedSetting"]) != 0 {
		t.Fatalf("explicit replacement failed: %+v", replaced)
	}
}
