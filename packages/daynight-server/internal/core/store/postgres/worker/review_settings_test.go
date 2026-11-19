package worker_test

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestWorkerReviewSettingPersistsByOwnerIndependentlyOfReports(t *testing.T) {
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner, other, workerID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	reportedAt := time.Now().UTC().Truncate(time.Microsecond)
	write := func(fn func(store.WorkerWriteDAO) error) {
		t.Helper()
		completion, err := db.WriteWorker(t.Context(), func(scope store.WorkerScope) error {
			return fn(scope.WorkerDAO())
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("write: %+v %v", completion, err)
		}
	}
	report := func(user string, stamp time.Time) {
		t.Helper()
		write(func(d store.WorkerWriteDAO) error {
			_, err := d.UpsertWorker(t.Context(), snapshot(user, workerID, stamp))
			return err
		})
	}
	read := func(user string, want bool, expectedErr error) {
		t.Helper()
		err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
			got, err := scope.WorkerDAO().WorkerReviewEnabled(t.Context(), user, workerID)
			if err == nil && got != want {
				t.Errorf("review setting for %s: got=%t want=%t", user, got, want)
			}
			return err
		})
		if !errors.Is(err, expectedErr) {
			t.Fatalf("read: got=%v want=%v", err, expectedErr)
		}
	}
	set := func(enabled bool) {
		t.Helper()
		write(func(d store.WorkerWriteDAO) error {
			stored, err := d.SetWorkerReviewEnabled(t.Context(), owner, workerID, enabled)
			if err == nil && stored != enabled {
				t.Errorf("review setting receipt: got=%t want=%t", stored, enabled)
			}
			return err
		})
	}
	report(owner, reportedAt)
	report(other, reportedAt)
	read(owner, false, nil)
	read(other, false, nil)
	set(true)
	read(owner, true, nil)
	read(other, false, nil)
	var retained time.Time
	err = db.Pool.QueryRow(t.Context(), `SELECT last_seen_at FROM workers WHERE user_id=$1 AND worker_id=$2`, owner, workerID).Scan(&retained)
	if err != nil || !retained.Equal(reportedAt) {
		t.Fatalf("review setting changed Worker liveness: got=%v want=%v err=%v", retained, reportedAt, err)
	}
	report(owner, reportedAt.Add(time.Second))
	read(owner, true, nil)
	set(false)
	read(owner, false, nil)

	foreign := uuid.NewString()
	read(foreign, false, model.ErrNotFound)
	completion, err := db.WriteWorker(t.Context(), func(scope store.WorkerScope) error {
		_, err := scope.WorkerDAO().SetWorkerReviewEnabled(t.Context(), foreign, workerID, true)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("write to missing owner: completion=%+v err=%v", completion, err)
	}
}
