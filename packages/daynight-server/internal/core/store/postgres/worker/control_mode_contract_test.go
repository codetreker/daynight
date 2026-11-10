package worker_test

import (
	"context"
	"encoding/json"
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
