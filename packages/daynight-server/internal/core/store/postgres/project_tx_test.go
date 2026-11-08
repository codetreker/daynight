package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func TestActiveDependentIDsUseOnlyDirectScopedOrdinaryAndExternalEdges(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project, foreign := queryProject(t, database, 1), queryProject(t, database, 2)
	predecessor := queryTask(t, database, project.ID, 10, model.TaskDone)
	active := queryTask(t, database, project.ID, 11, model.TaskInProgress, predecessor.ID)
	done := queryTask(t, database, project.ID, 12, model.TaskDone, predecessor.ID)
	queryTask(t, database, project.ID, 13, model.TaskTodo, predecessor.ID)
	queryTask(t, database, project.ID, 14, model.TaskDone, active.ID)
	queryTask(t, database, foreign.ID, 15, model.TaskInProgress, predecessor.ID)
	mustQueryExec(t, database, `UPDATE task_dependencies SET external=true WHERE task_id=$1`, done.ID)
	mustQueryExec(t, database, `CREATE FUNCTION reject_dependent_materials() RETURNS text LANGUAGE plpgsql STABLE AS $$
		BEGIN RAISE EXCEPTION 'dependent materials must not be selected'; END $$;
		ALTER TABLE tasks RENAME TO task_source;
		CREATE VIEW tasks AS SELECT id, project_id, status, reject_dependent_materials() AS title,
		reject_dependent_materials() AS description, deleted_at FROM task_source`)
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		ids, err := tx.TaskDAO().ActiveDependentIDs(ctx, predecessor.ID)
		if err != nil || !reflect.DeepEqual(ids, []string{active.ID, done.ID}) {
			t.Fatalf("direct active dependents lost scope, order, classification or ID-only projection: %#v %v", ids, err)
		}
		empty, err := tx.TaskDAO().ActiveDependentIDs(ctx, queryID(99))
		if err != nil || len(empty) != 0 {
			t.Fatalf("empty active dependent lookup failed: %#v %v", empty, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func waitForQueryLock(t *testing.T, s *Store, prefix string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1)`, prefix+"%").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("query never reached a database lock wait")
		case <-ticker.C:
		}
	}
}

func receiveQueryResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return ctx.Err()
	}
}

func TestProjectTransactionsSerializeAndReadFreshAfterLock(t *testing.T) {
	s := isolatedStore(t)
	first, second := queryProject(t, s, 1), queryProject(t, s, 2)
	task := queryTask(t, s, first.ID, 11, model.TaskTodo)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result := make(chan error, 1)
	var firstUpdate, secondUpdate model.Task
	if err := writeProjectForTest(s, ctx, first.ID, func(tx ProjectWriteScope) error {
		var isolation string
		if err := tx.(*ProjectTx).tx.QueryRow(ctx, "SHOW transaction_isolation").Scan(&isolation); err != nil || isolation != "read committed" {
			t.Fatalf("write isolation: %s, %v", isolation, err)
		}
		go func() {
			result <- writeProjectForTest(s, ctx, first.ID, func(waiter ProjectWriteScope) error {
				fresh, err := waiter.TaskDAO().Task(ctx, task.ID)
				if err != nil {
					return err
				}
				if fresh.Status != model.TaskDone || fresh.Version != 2 {
					return errors.New("lock waiter read a snapshot predating the preceding commit")
				}
				secondUpdate, err = waiter.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Second", Status: model.TaskDone})
				return err
			})
		}()
		waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
		independent, finish := context.WithTimeout(ctx, 2*time.Second)
		defer finish()
		if err := writeProjectForTest(s, independent, second.ID, func(other ProjectWriteScope) error {
			_, err := other.TaskDAO().CreateTask(independent, queryID(12), TaskWrite{Title: "Independent", Status: model.TaskTodo})
			return err
		}); err != nil {
			t.Fatalf("unrelated project was blocked: %v", err)
		}
		var err error
		firstUpdate, err = tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "First", Status: model.TaskDone})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	if secondUpdate.Version != 3 || !secondUpdate.UpdatedAt.After(firstUpdate.UpdatedAt) {
		t.Fatalf("lock waiter timestamp/version regressed: first %#v, second %#v", firstUpdate, secondUpdate)
	}
}

func TestProjectTransactionsCancelActualRowLockWithoutLateWrite(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	before := queryTask(t, s, project.ID, 11, model.TaskTodo)
	ctx, finish := context.WithTimeout(context.Background(), 10*time.Second)
	defer finish()
	var invoked atomic.Bool
	if err := writeProjectForTest(s, ctx, project.ID, func(ProjectWriteScope) error {
		waiting, cancel := context.WithCancel(ctx)
		defer cancel()
		result := make(chan error, 1)
		go func() {
			result <- writeProjectForTest(s, waiting, project.ID, func(tx ProjectWriteScope) error {
				invoked.Store(true)
				_, err := tx.TaskDAO().UpdateTask(waiting, before.ID, TaskWrite{Title: "Late", Status: model.TaskDone})
				return err
			})
		}()
		waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
		cancel()
		if err := receiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
			t.Fatalf("row-lock cancellation cause: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if invoked.Load() {
		t.Fatal("canceled lock wait invoked mutation callback")
	}
	after := snapshotTask(t, s, project.ID, before.ID)
	if after.Title != before.Title || after.Version != before.Version || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("canceled row-lock wait wrote late: %#v", after)
	}
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().Task(ctx, before.ID)
		return err
	}); err != nil {
		t.Fatalf("lock was not reusable: %v", err)
	}
}

func TestProjectTransactionsCancelActualQueryWait(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	ctx, finish := context.WithTimeout(context.Background(), 10*time.Second)
	defer finish()
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, "LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- s.ReadSnapshot(waiting, func(snapshot SnapshotScope) error {
			_, err := snapshot.TaskDAO().Task(waiting, project.ID, task.ID)
			return err
		})
	}()
	waitForQueryLock(t, s, "SELECT t.id::text")
	cancel()
	if err := receiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("query cancellation cause: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if after := snapshotTask(t, s, project.ID, task.ID); after.Version != task.Version {
		t.Fatalf("canceled query changed task: %#v", after)
	}
	assertMigrationPoolReusable(t, s.Pool)
}

func TestQueriesFailuresPreserveCauses(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	for _, operation := range []func() error{
		func() error { _, err := s.CreateProject(canceled, queryID(99), "Canceled", "repo"); return err },
		func() error {
			return s.ReadSnapshot(canceled, func(SnapshotScope) error { t.Fatal("canceled snapshot began"); return nil })
		},
		func() error {
			return writeProjectForTest(s, canceled, project.ID, func(ProjectWriteScope) error { t.Fatal("canceled writer began"); return nil })
		},
	} {
		if err := operation(); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled begin cause: %v", err)
		}
	}
	var expiredSnapshot SnapshotScope
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error { expiredSnapshot = snapshot; return nil }); err != nil {
		t.Fatal(err)
	}
	var expiredProject ProjectWriteScope
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error { expiredProject = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { _, err := expiredSnapshot.ProjectDAO().Projects(ctx, Page{Limit: 10}); return err },
		func() error { _, err := expiredSnapshot.ObservedAt(ctx); return err },
		func() error {
			_, err := expiredSnapshot.TaskDAO().Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
			return err
		},
		func() error { _, err := expiredProject.TaskDAO().TasksByID(ctx, []string{task.ID}); return err },
		func() error { _, err := expiredProject.TaskDAO().ActiveDependentIDs(ctx, task.ID); return err },
		func() error { _, err := expiredProject.ProjectDAO().Project(ctx); return err },
		func() error { _, err := expiredProject.ProjectDAO().UpdateProjectSettings(ctx, 90); return err },
		func() error {
			_, err := expiredProject.TaskDAO().Reachable(ctx, task.ID, queryID(99), DependencyReplacement{TaskID: task.ID, DependsOn: nil})
			return err
		},
	} {
		if err := operation(); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("completed transaction cause was lost: %v", err)
		}
	}
	for _, test := range []struct {
		name string
		call func(ProjectWriteScope) error
	}{
		{"invalid task metadata", func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().CreateTask(ctx, queryID(12), TaskWrite{Title: "", Status: model.TaskTodo})
			return err
		}},
		{"invalid update", func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: "unknown"})
			return err
		}},
		{"invalid edge rolls back creation", func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().CreateTask(ctx, queryID(12), TaskWrite{Title: "New", Status: model.TaskTodo, DependsOn: []string{queryID(12)}})
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := writeProjectForTest(s, ctx, project.ID, test.call); err == nil {
				t.Fatal("invalid database write succeeded")
			}
			if got := snapshotTask(t, s, project.ID, task.ID); got.Title != task.Title || got.Version != task.Version {
				t.Fatalf("failed update changed task: %#v", got)
			}
		})
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.TaskDAO().Task(ctx, project.ID, queryID(12))
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("failed create was persisted: %v", err)
	}

	dependency := queryTask(t, s, project.ID, 13, model.TaskDone)
	queryTask(t, s, project.ID, 14, model.TaskTodo, dependency.ID)
	mustQueryExec(t, s, `CREATE FUNCTION reject_edge_delete() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'private SQL diagnostic'; END $$;
		CREATE TRIGGER reject_edge_delete BEFORE DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_edge_delete()`)
	err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, queryID(14), TaskWrite{Title: "Changed", Status: model.TaskTodo})
		return err
	})
	if err == nil || strings.Contains(err.Error(), "private SQL") {
		t.Fatalf("replace dependency error: %v", err)
	}
}

func TestProjectWriteClockUsesDatabaseStatementTimeAndUTC(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	ctx := context.Background()
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		if _, err := tx.(*ProjectTx).tx.Exec(ctx, "SET LOCAL TIME ZONE 'Asia/Kolkata'"); err != nil {
			return err
		}
		var before, after time.Time
		if err := tx.(*ProjectTx).tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&before); err != nil {
			return err
		}
		observed, err := tx.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if err := tx.(*ProjectTx).tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&after); err != nil {
			return err
		}
		if observed.Location() != time.UTC || observed.Before(before) || observed.After(after) {
			t.Fatalf("project clock is not a UTC database statement timestamp: before %s observed %s after %s", before, observed, after)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestProjectWriteClockPreservesQueryFailureCause(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	ctx := context.Background()
	var completed ProjectWriteScope
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		completed = tx
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		observed, err := tx.TaskDAO().ObservedAt(canceled)
		var failure *Error
		if !observed.IsZero() || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Phase != "read project clock" {
			t.Fatalf("canceled project clock lost its query cause: observed %s, error %v", observed, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	observed, err := completed.TaskDAO().ObservedAt(ctx)
	var failure *Error
	if !observed.IsZero() || !errors.Is(err, pgx.ErrTxClosed) || !errors.As(err, &failure) || failure.Phase != "read project clock" {
		t.Fatalf("completed project clock hid its closed transaction: observed %s, error %v", observed, err)
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestProjectWriteScopeCompletion(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 91)
	before := queryTask(t, s, project.ID, 92, model.TaskTodo)
	rejected := errors.New("reject project mutation")
	completion, err := s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		current, err := scope.TaskDAO().Task(ctx, before.ID)
		if err != nil {
			return err
		}
		if _, err := scope.TaskDAO().UpdateTask(ctx, current.ID, TaskWrite{Title: "Rolled back", Status: current.Status}); err != nil {
			return err
		}
		return rejected
	})
	if completion.Outcome != TransactionNotCommitted || !errors.Is(err, rejected) {
		t.Fatalf("failed operation completion = %q, err = %v", completion.Outcome, err)
	}
	if after := snapshotTask(t, s, project.ID, before.ID); after.Title != before.Title || after.Version != before.Version {
		t.Fatalf("failed operation persisted: %#v", after)
	}
	completion, err = s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		_, err := scope.ProjectDAO().Project(ctx)
		return err
	})
	if completion.Outcome != TransactionCommitted || err != nil {
		t.Fatalf("successful operation completion = %q, err = %v", completion.Outcome, err)
	}
}
