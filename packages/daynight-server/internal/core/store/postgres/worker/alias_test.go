package worker_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
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

func TestWorkerAliasPersistenceOwnershipAndReportIndependence(t *testing.T) {
	url := testutil.ScopedDatabaseURL(t)
	db, err := postgres.Open(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner, other, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	at := time.Now().UTC().Truncate(time.Microsecond)
	old := snapshot(owner, id, at.Add(-96*time.Hour))
	write := func(fn func(store.WorkerWriteDAO) error) {
		t.Helper()
		completion, err := db.WriteWorker(t.Context(), func(scope store.WorkerScope) error { return fn(scope.WorkerDAO()) })
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("write: %+v %v", completion, err)
		}
	}
	read := func(user string) model.WorkerAlias {
		t.Helper()
		var got model.WorkerAlias
		err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
			var err error
			got, err = s.WorkerDAO().WorkerAlias(t.Context(), user, id)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	write(func(d store.WorkerWriteDAO) error {
		if _, err := d.UpsertWorker(t.Context(), old); err != nil {
			return err
		}
		_, err := d.UpsertWorker(t.Context(), snapshot(other, id, at))
		return err
	})
	if got := read(owner); got.Value != nil || got.Version != 1 {
		t.Fatalf("initial alias: %+v", got)
	}
	desired := model.WorkerAlias{Value: new("开发 👩‍💻"), Version: 2}
	write(func(d store.WorkerWriteDAO) error { return d.SetWorkerAlias(t.Context(), owner, id, 1, desired) })
	if got := read(owner); !reflect.DeepEqual(got, desired) {
		t.Fatalf("persisted alias: %+v", got)
	}
	// Alias access has no report-retention cutoff, and changes no admission facts.
	var seen time.Time
	var telemetry, tasks string
	if err := db.Pool.QueryRow(t.Context(), `SELECT last_seen_at,telemetry::text,task_snapshot::text FROM workers WHERE user_id=$1 AND worker_id=$2`, owner, id).Scan(&seen, &telemetry, &tasks); err != nil || !seen.Equal(old.LastReportedAt) {
		t.Fatalf("alias changed report timestamp: %v %v", seen, err)
	}
	write(func(d store.WorkerWriteDAO) error { return d.SetWorkerAlias(t.Context(), owner, id, 2, desired) })
	var telemetryAfter, tasksAfter string
	if err := db.Pool.QueryRow(t.Context(), `SELECT telemetry::text,task_snapshot::text FROM workers WHERE user_id=$1 AND worker_id=$2`, owner, id).Scan(&telemetryAfter, &tasksAfter); err != nil || telemetryAfter != telemetry || tasksAfter != tasks {
		t.Fatalf("alias changed report data: %v", err)
	}
	if got := read(other); got.Value != nil || got.Version != 1 {
		t.Fatalf("alias leaked between owners: %+v", got)
	}
	err = db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
		_, err := s.WorkerDAO().WorkerAlias(t.Context(), uuid.NewString(), id)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("foreign Worker not hidden: %v", err)
	}
	// A later legacy report and re-created local Worker retain owner metadata.
	old.LastReportedAt = at
	old.Telemetry.Machine.Name = "New machine report"
	write(func(d store.WorkerWriteDAO) error {
		_, err := d.UpsertWorker(t.Context(), old)
		return err
	})
	if got := read(owner); !reflect.DeepEqual(got, desired) {
		t.Fatalf("report overwrote alias: %+v", got)
	}
	if err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
		list, err := s.WorkerDAO().WorkerSummaries(t.Context(), owner, at, store.Page{Limit: 10})
		if err != nil || len(list.Items) != 1 || !reflect.DeepEqual(list.Items[0].Alias, desired) {
			t.Fatalf("summary alias: %+v %v", list, err)
		}
		detail, err := s.WorkerDAO().Worker(t.Context(), owner, id, at)
		if err == nil && !reflect.DeepEqual(detail.Alias, desired) {
			t.Fatalf("detail alias: %+v", detail.Alias)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// Closing the pool cannot lose metadata committed independently of reports.
	db.Close()
	db, err = postgres.Open(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if got := read(owner); !reflect.DeepEqual(got, desired) {
		t.Fatalf("reopened alias: %+v", got)
	}
	write(func(d store.WorkerWriteDAO) error {
		return d.SetWorkerAlias(t.Context(), owner, id, 2, model.WorkerAlias{Version: 3})
	})
	if got := read(owner); got.Value != nil || got.Version != 3 {
		t.Fatalf("clear was not persisted: %+v", got)
	}
}

func TestWorkerAliasDatabaseFailuresRemainVisible(t *testing.T) {
	tx := workerTransaction(t)
	reader, writer := worker.NewReader(tx), worker.NewWriter(tx)
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	user, id := uuid.NewString(), uuid.NewString()
	if _, err := reader.WorkerAlias(t.Context(), user, id); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("reader lost query cause: %v", err)
	}
	if _, err := writer.WorkerAlias(t.Context(), user, id); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("writer lost query cause: %v", err)
	}
	if err := writer.SetWorkerAlias(t.Context(), user, id, 1, model.WorkerAlias{Version: 2}); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("writer lost update cause: %v", err)
	}
}

func TestWorkerAliasSummaryAndDetailShareSnapshot(t *testing.T) {
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner, id := uuid.NewString(), uuid.NewString()
	at := time.Now().UTC()
	if _, err := db.WriteWorker(t.Context(), func(s store.WorkerScope) error {
		_, err := s.WorkerDAO().UpsertWorker(t.Context(), snapshot(owner, id, at))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
		page, err := s.WorkerDAO().WorkerSummaries(t.Context(), owner, at, store.Page{Limit: 10})
		if err != nil || len(page.Items) != 1 || page.Items[0].Alias.Version != 1 {
			t.Fatalf("initial summary: %+v %v", page, err)
		}
		if _, err := db.WriteWorker(t.Context(), func(write store.WorkerScope) error {
			return write.WorkerDAO().SetWorkerAlias(t.Context(), owner, id, 1, model.WorkerAlias{Value: new("Concurrent edit"), Version: 2})
		}); err != nil {
			return err
		}
		detail, err := s.WorkerDAO().Worker(t.Context(), owner, id, at)
		if err == nil && (detail.Alias.Version != 1 || detail.Alias.Value != nil) {
			t.Fatalf("detail escaped read snapshot: %+v", detail.Alias)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
		value, err := s.WorkerDAO().WorkerAlias(t.Context(), owner, id)
		if err == nil && (value.Version != 2 || value.Value == nil || *value.Value != "Concurrent edit") {
			t.Fatalf("fresh snapshot lost committed edit: %+v", value)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerAliasConcurrentCASAndStaleNoop(t *testing.T) {
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner, id := uuid.NewString(), uuid.NewString()
	if _, err := db.WriteWorker(t.Context(), func(s store.WorkerScope) error {
		_, err := s.WorkerDAO().UpsertWorker(t.Context(), snapshot(owner, id, time.Now().UTC()))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, name := range []string{"First", "Second"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			completion, err := db.WriteWorker(t.Context(), func(s store.WorkerScope) error {
				return s.WorkerDAO().SetWorkerAlias(t.Context(), owner, id, 1, model.WorkerAlias{Value: &name, Version: 2})
			})
			if err == nil && completion.Outcome != store.TransactionCommitted {
				err = errors.New("CAS did not commit")
			}
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		var fault *model.Fault
		switch {
		case err == nil:
			successes++
		case errors.As(err, &fault) && fault.Code == "version_conflict":
			conflicts++
		default:
			t.Fatalf("unexpected CAS error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("CAS successes=%d conflicts=%d", successes, conflicts)
	}
	var current model.WorkerAlias
	if err := db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
		var err error
		current, err = s.WorkerDAO().WorkerAlias(t.Context(), owner, id)
		return err
	}); err != nil || current.Version != 2 || current.Value == nil {
		t.Fatalf("CAS readback: %+v %v", current, err)
	}
	_, err = db.WriteWorker(t.Context(), func(s store.WorkerScope) error {
		return s.WorkerDAO().SetWorkerAlias(t.Context(), owner, id, 1, current)
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale noop accepted: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		_, err := s.WorkerDAO().WorkerAlias(ctx, owner, id)
		return err
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}
