package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	pgworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	coreworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func TestArchiveSessionsLockedLegacyWrite(t *testing.T) {
	db := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, id := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
	initial := testutil.WorkerConfiguration()
	if err := testutil.WriteWorker(db, ctx, func(s WorkerScope) error {
		_, err := s.WorkerDAO().SetWorkerConfiguration(ctx, user, id, 1, initial)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	first, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	second, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Rollback(context.Background())
	a, b := pgworker.NewWriter(first).WorkerDAO(), pgworker.NewWriter(second).WorkerDAO()
	current, err := a.WorkerConfiguration(ctx, user, id)
	if err != nil || current.Desired.Value.ArchiveSessions == nil || !*current.Desired.Value.ArchiveSessions {
		t.Fatalf("default: %+v %v", current, err)
	}
	disabled := false
	selected := current.Desired.Value
	selected.ArchiveSessions = &disabled
	if _, err := coreworker.PutConfiguration(ctx, a, model.Principal{UserID: user}, id, 1, selected); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		value model.WorkerConfigurationResource
		err   error
	}
	pending := make(chan outcome, 1)
	legacy := initial
	legacy.ArchiveSessions = nil
	legacy.PreserveArchiveSessions = true
	legacy.MaxConcurrent = 5
	go func() {
		value, err := coreworker.PutConfiguration(ctx, b, model.Principal{UserID: user}, id, 1, legacy)
		pending <- outcome{value, err}
	}()
	testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-pending
	var fault *model.Fault
	if !errors.As(got.err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale concurrent write: %+v %v", got.value, got.err)
	}
	if err := second.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.WriteWorker(db, ctx, func(s WorkerScope) error {
		_, err := coreworker.PutConfiguration(ctx, s.WorkerDAO(), model.Principal{UserID: user}, id, 2, legacy)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(ctx, func(s SnapshotScope) error {
		got, err := s.WorkerDAO().WorkerConfiguration(ctx, user, id)
		if err == nil && (got.Desired.Revision != "3" || got.Desired.Value.MaxConcurrent != 5 || got.Desired.Value.ArchiveSessions == nil || *got.Desired.Value.ArchiveSessions) {
			t.Errorf("persisted: %+v", got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	var archive bool
	if err := db.Pool.QueryRow(ctx, `SELECT desired_configuration,archive_sessions FROM workers WHERE user_id=$1 AND worker_id=$2`, user, id).Scan(&raw, &archive); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if archive || fields["archiveSessions"] != nil {
		t.Fatalf("column/JSON=%v %s", archive, raw)
	}
}
