package postgres

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Cancellation after a successful SQL statement is distinct from cancellation
// after COMMIT acknowledgement: the former must roll back, the latter persists.
type taskTouchCancelTracer struct {
	fragment string
	cancel   context.CancelFunc
	observed atomic.Bool
}

func (tracer *taskTouchCancelTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, tracer, strings.HasPrefix(data.SQL, tracer.fragment))
}
func (tracer *taskTouchCancelTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if ctx.Value(tracer) == true && data.Err == nil {
		tracer.observed.Store(true)
		tracer.cancel()
	}
}

func taskTouchState(t *testing.T, database *Store, taskID string) string {
	t.Helper()
	var state string
	if err := database.Pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, taskID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestTaskTouchCancellationAndCompletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	for i, tc := range []struct {
		name, fragment string
		outcome        TransactionOutcome
	}{
		{"after write", "UPDATE tasks SET version=version+1,updated_at=$3", TransactionNotCommitted},
		{"after commit", "commit", TransactionCommitted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := queryTask(t, database, project.ID, 10+i, model.TaskTodo)
			before := taskTouchState(t, database, task.ID)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			tracer := &taskTouchCancelTracer{fragment: tc.fragment, cancel: cancel}
			config := database.Pool.Config()
			config.ConnConfig.Tracer = tracer
			pool, err := pgxpool.NewWithConfig(t.Context(), config)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			traced := &Store{Pool: pool}
			completion, err := traced.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
				if _, err := scope.TaskDAO().TaskHeader(ctx, task.ID); err != nil {
					return err
				}
				stamp, err := scope.TaskDAO().ObservedAt(ctx)
				if err != nil {
					return err
				}
				return scope.TaskDAO().TouchTask(ctx, task.ID, stamp)
			})
			if !tracer.observed.Load() || !errors.Is(ctx.Err(), context.Canceled) || completion.Outcome != tc.outcome {
				t.Fatalf("observed=%t context=%v completion=%+v error=%v", tracer.observed.Load(), ctx.Err(), completion, err)
			}
			if tc.outcome == TransactionNotCommitted {
				var failure *TransactionError
				if !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionNotCommitted {
					t.Fatalf("rollback: %+v %v", failure, err)
				}
				if taskTouchState(t, database, task.ID) != before {
					t.Fatal("touch survived rollback")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				var version int64
				var updated time.Time
				if err := database.Pool.QueryRow(t.Context(), `SELECT version,updated_at FROM tasks WHERE id=$1`, task.ID).Scan(&version, &updated); err != nil {
					t.Fatal(err)
				}
				if version != task.Version+1 || updated.Before(task.UpdatedAt) {
					t.Fatalf("committed touch version=%d updated=%v", version, updated)
				}
				state := taskTouchState(t, database, task.ID)
				if state == before || taskTouchState(t, database, task.ID) != state {
					t.Fatal("committed touch missing or reconciliation changed state")
				}
			}
			assertMigrationPoolReusable(t, pool)
		})
	}
}

func TestTaskTouchCommitLostReceiptKeepsUnknownAndCurrentFacts(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	transaction, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("private lost commit receipt")
	err = transact(ctx, &threadCommitResponseLoss{Tx: transaction, cause: lost}, func(raw pgx.Tx) error {
		tx := &ProjectTx{tx: raw, projectID: project.ID}
		if _, err := raw.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
			return err
		}
		header, err := tx.TaskDAO().TaskHeader(ctx, task.ID)
		if err != nil {
			return err
		}
		if header.Version != task.Version {
			t.Fatal("wrong locked version")
		}
		stamp, err := tx.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		return tx.TaskDAO().TouchTask(ctx, task.ID, stamp)
	})
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Outcome != TransactionUnknown || failure.Phase != "commit" || !failure.CommitAttempted || failure.CleanupFailed || !errors.Is(err, lost) {
		t.Fatalf("lost receipt classification: %+v %v", failure, err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		header, err := snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		if header.Version != task.Version+1 {
			t.Fatal("current read facts do not reflect applied commit")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskTouchStoreFailuresKeepCausesAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	before := taskTouchState(t, database, task.ID)
	for _, operation := range []string{"touch", "missing"} {
		t.Run(operation, func(t *testing.T) {
			err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
				if _, err := tx.TaskDAO().TaskHeader(ctx, task.ID); err != nil {
					return err
				}
				stamp, err := tx.TaskDAO().ObservedAt(ctx)
				if err != nil {
					return err
				}
				if operation == "touch" {
					if _, err := tx.(*ProjectTx).tx.Exec(ctx, `ALTER TABLE tasks RENAME COLUMN updated_at TO invalid_updated_at`); err != nil {
						return err
					}
					return tx.TaskDAO().TouchTask(ctx, task.ID, stamp)
				}
				return tx.TaskDAO().TouchTask(ctx, queryID(999), stamp)
			})
			var failure *TransactionError
			if !errors.As(err, &failure) || failure.CommitAttempted || failure.Outcome != TransactionNotCommitted {
				t.Fatalf("store refusal: %+v %v", failure, err)
			}
			if operation == "missing" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("missing touch marker lost")
				}
			} else {
				var cause *pgconn.PgError
				if !errors.As(err, &cause) {
					t.Fatal("driver cause lost")
				}
			}
			if taskTouchState(t, database, task.ID) != before {
				t.Fatal("store failure left partial parent changes")
			}
		})
	}
}

func TestTaskHeaderSnapshotAndDeletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		header, err := snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
		if err != nil || header.Version != task.Version || header.DeletedAt != nil {
			t.Fatalf("initial header: %+v %v", header, err)
		}
		mustQueryExec(t, database, `UPDATE tasks SET version=version+1 WHERE id=$1`, task.ID)
		header, err = snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
		if err != nil || header.Version != task.Version {
			t.Fatalf("snapshot changed: %+v %v", header, err)
		}
		if _, err := snapshot.TaskDAO().TaskHeader(ctx, queryID(999), task.ID); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("cross-project header: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at='2026-11-03T11:12:13Z' WHERE id=$1`, task.ID)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		header, err := snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
		if err != nil || header.Version != task.Version+1 || header.DeletedAt == nil || header.DeletedAt.Location() != time.UTC {
			t.Fatalf("updated header: %+v %v", header, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
