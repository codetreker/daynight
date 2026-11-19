package worker_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestReviewParticipationPersistenceAndIndependentWrites(t *testing.T) {
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner, other, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	at := time.Now().UTC().Truncate(time.Microsecond)
	old := snapshot(owner, id, at.Add(-96*time.Hour))
	write := func(fn func(store.WorkerWriteDAO) error) {
		t.Helper()
		completion, err := db.WriteWorker(t.Context(), func(s store.WorkerScope) error { return fn(s.WorkerDAO()) })
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("write %+v %v", completion, err)
		}
	}
	read := func(user, workerID string) model.WorkerReviewParticipation {
		t.Helper()
		var result model.WorkerReviewParticipation
		err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
			var err error
			result, err = s.WorkerDAO().WorkerReviewParticipation(t.Context(), user, workerID)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	write(func(d store.WorkerWriteDAO) error {
		if _, err := d.UpsertWorker(t.Context(), old); err != nil {
			return err
		}
		_, err := d.UpsertWorker(t.Context(), snapshot(other, id, at))
		return err
	})
	if got := read(owner, id); got != (model.WorkerReviewParticipation{Version: 1}) {
		t.Fatalf("new default %+v", got)
	}
	var before, after string
	facts := func(target *string) {
		t.Helper()
		if err := db.Pool.QueryRow(t.Context(), `SELECT (to_jsonb(w)-'review_enabled'-'review_version')::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, owner, id).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	facts(&before)
	desired := model.WorkerReviewParticipation{Enabled: true, Version: 2}
	write(func(d store.WorkerWriteDAO) error {
		return d.SetWorkerReviewParticipation(t.Context(), owner, id, 1, desired)
	})
	if got := read(owner, id); got != desired {
		t.Fatalf("persisted %+v", got)
	}
	facts(&after)
	if before != after {
		t.Fatal("participation changed unrelated report/configuration facts")
	}
	write(func(d store.WorkerWriteDAO) error {
		return d.SetWorkerReviewParticipation(t.Context(), owner, id, 2, desired)
	})
	if got := read(other, id); got != (model.WorkerReviewParticipation{Version: 1}) {
		t.Fatalf("owner isolation %+v", got)
	}
	for _, key := range []struct{ owner, id string }{{uuid.NewString(), id}, {owner, uuid.NewString()}} {
		err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
			_, err := s.WorkerDAO().WorkerReviewParticipation(t.Context(), key.owner, key.id)
			return err
		})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unknown/foreign read %v", err)
		}
	}
	old.LastReportedAt = at
	write(func(d store.WorkerWriteDAO) error {
		if _, err := d.UpsertWorker(t.Context(), old); err != nil {
			return err
		}
		_, err := d.SetWorkerConfiguration(t.Context(), owner, id, 7, configuration())
		return err
	})
	if got := read(owner, id); got != desired {
		t.Fatalf("report/configuration overwrote participation %+v", got)
	}
	facts(&before)
	write(func(d store.WorkerWriteDAO) error {
		return d.SetWorkerReviewParticipation(t.Context(), owner, id, 2, model.WorkerReviewParticipation{Version: 3})
	})
	facts(&after)
	if before != after {
		t.Fatal("disabling participation changed unrelated configured Worker facts")
	}
	if got := read(owner, id); got != (model.WorkerReviewParticipation{Version: 3}) {
		t.Fatalf("disable readback %+v", got)
	}
	if err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
		cfg, err := s.WorkerDAO().WorkerConfiguration(t.Context(), owner, id)
		if err == nil && (cfg.Desired == nil || cfg.Desired.Revision != "7") {
			t.Fatalf("configuration version %+v", cfg)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		_, err := s.WorkerDAO().WorkerReviewParticipation(ctx, owner, id)
		return err
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation %v", err)
	}
}

func TestReviewParticipationConcurrentCASRejectsStaleNoop(t *testing.T) {
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, id := uuid.NewString(), uuid.NewString()
	if _, err := db.WriteWorker(ctx, func(s store.WorkerScope) error {
		_, err := s.WorkerDAO().UpsertWorker(ctx, snapshot(owner, id, time.Now().UTC()))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	first := claimTransaction(t, db, ctx)
	second := claimTransaction(t, db, ctx)
	next := model.WorkerReviewParticipation{Enabled: true, Version: 2}
	if err := worker.NewWriter(first).SetWorkerReviewParticipation(ctx, owner, id, 1, next); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		result <- worker.NewWriter(second).SetWorkerReviewParticipation(ctx, owner, id, 1, model.WorkerReviewParticipation{Version: 1})
	}()
	testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	err = testutil.ReceiveQueryResult(t, ctx, result)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale concurrent noop %v", err)
	}
	if err := db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		got, err := s.WorkerDAO().WorkerReviewParticipation(ctx, owner, id)
		if err == nil && got != next {
			t.Fatalf("winner lost %+v", got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestReviewParticipationDatabaseErrorsRemainVisible(t *testing.T) {
	tx := workerTransaction(t)
	reader, writer := worker.NewReader(tx), worker.NewWriter(tx)
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	owner, id := uuid.NewString(), uuid.NewString()
	if _, err := reader.WorkerReviewParticipation(t.Context(), owner, id); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("reader lost cause %v", err)
	}
	if _, err := writer.WorkerReviewParticipation(t.Context(), owner, id); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("writer lost cause %v", err)
	}
	if err := writer.SetWorkerReviewParticipation(t.Context(), owner, id, 1, model.WorkerReviewParticipation{Enabled: true, Version: 2}); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("update lost cause %v", err)
	}
}
