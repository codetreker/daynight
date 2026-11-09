package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func graphCancellationWaiter(t *testing.T, ctx context.Context, observer *Store, reader, blocker uint32) {
	t.Helper()
	for {
		var blocked bool
		if err := observer.Pool.QueryRow(ctx, `SELECT coalesce((SELECT wait_event_type='Lock'
 AND $2::integer=ANY(pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=$1),false)`, reader, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("graph reader %d did not wait for blocker %d: %v", reader, blocker, err)
		}
	}
}

func graphCancellationReleased(t *testing.T, ctx context.Context, observer *Store, reader uint32) {
	t.Helper()
	for {
		var active bool
		if err := observer.Pool.QueryRow(ctx, `SELECT coalesce((SELECT state='active'
 OR xact_start IS NOT NULL OR cardinality(pg_blocking_pids(pid))>0 FROM pg_stat_activity WHERE pid=$1),false)`, reader).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if !active {
			return
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("canceled graph reader %d retained a transaction or blocker: %v", reader, err)
		}
	}
}

func graphCancellationPoolDrained(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for pool.Stat().AcquiredConns() != 0 {
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("canceled graph snapshot retained %d acquired connections: %v", pool.Stat().AcquiredConns(), err)
		}
	}
}

func TestTaskGraphSnapshotCancellationReleasesBlockedQuery(t *testing.T) {
	database, principal, _, project := membershipFixture(t)
	root := queryTask(t, database, project.ID, 10, model.TaskTodo)
	queryTask(t, database, project.ID, 11, model.TaskTodo, root.ID)
	for _, test := range []struct {
		name, table string
		read        func(context.Context, store.SnapshotScope) error
	}{
		{"project access", "projects", func(ctx context.Context, snapshot store.SnapshotScope) error {
			_, err := snapshot.ProjectDAO().ProjectAccess(ctx, principal, project.ID)
			return err
		}},
		{"graph count", "tasks", func(ctx context.Context, snapshot store.SnapshotScope) error {
			_, err := snapshot.TaskDAO().TaskGraphProjectionSize(ctx, project.ID, root.ID, testGraphSelection())
			return err
		}},
		{"graph projection", "tasks", func(ctx context.Context, snapshot store.SnapshotScope) error {
			_, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, root.ID, testGraphSelection(), 160)
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			bounded, stop := context.WithTimeout(t.Context(), 10*time.Second)
			defer stop()
			config := database.Pool.Config().Copy()
			config.MaxConns = 1
			config.MinConns = 0
			config.ConnConfig.RuntimeParams["application_name"] = fmt.Sprintf("graph-cancellation-%s", test.table)
			pool, err := pgxpool.NewWithConfig(bounded, config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			reader := &Store{Pool: pool}
			var readerPID uint32
			if err := pool.QueryRow(bounded, "SELECT pg_backend_pid()").Scan(&readerPID); err != nil {
				t.Fatal(err)
			}
			holder, err := database.Pool.Begin(bounded)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := holder.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Errorf("graph lock cleanup: %v", err)
				}
			}()
			if _, err := holder.Exec(bounded, "LOCK TABLE "+test.table+" IN ACCESS EXCLUSIVE MODE"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(bounded)
			finished := make(chan error, 1)
			go func() {
				finished <- reader.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error { return test.read(ctx, snapshot) })
			}()
			drained := false
			t.Cleanup(func() {
				cancel()
				if drained {
					return
				}
				select {
				case <-finished:
				case <-time.After(5 * time.Second):
					t.Error("graph snapshot did not stop during cleanup")
				}
			})
			graphCancellationWaiter(t, bounded, database, readerPID, holder.Conn().PgConn().PID())
			cancel()
			select {
			case err := <-finished:
				drained = true
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("graph cancellation lost its caller cause: %v", err)
				}
			case <-bounded.Done():
				t.Fatal("canceled graph snapshot did not return")
			}
			graphCancellationReleased(t, bounded, database, readerPID)
			graphCancellationPoolDrained(t, bounded, pool)
			if err := pool.Ping(bounded); err != nil {
				t.Fatalf("graph pool could not be reused while the original lock remained: %v", err)
			}
			if err := holder.Rollback(bounded); err != nil {
				t.Fatal(err)
			}
			if err := reader.ReadSnapshot(bounded, func(snapshot store.SnapshotScope) error {
				size, err := snapshot.TaskDAO().TaskGraphProjectionSize(bounded, project.ID, root.ID, testGraphSelection())
				if err != nil {
					return err
				}
				if size != (store.TaskGraphSize{NodeCount: 2, EdgeCount: 1}) {
					return fmt.Errorf("graph read after cancellation: size=%#v", size)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
