package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestExternalDependencyStoreReadFailuresPreserveCauses(t *testing.T) {
	for _, canceled := range []bool{true, false} {
		t.Run(map[bool]string{true: "cancellation", false: "missing marker column"}[canceled], func(t *testing.T) {
			database := testutil.OpenStore(t, postgres.Open)
			project := testutil.QueryProject(t, database.Pool, database, 1)
			predecessor := testutil.QueryTask(t, database, project.ID, 10, model.TaskDone)
			target := testutil.QueryTask(t, database, project.ID, 11, model.TaskTodo, predecessor.ID)
			if !canceled {
				testutil.MustExec(t, database.Pool, "ALTER TABLE task_dependencies DROP COLUMN external")
			}
			err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if canceled {
					cancel()
				}
				_, err := snapshot.TaskDAO().Task(ctx, project.ID, target.ID)
				return err
			})
			if canceled {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("classification read lost cancellation: %v", err)
				}
			} else {
				var cause *pgconn.PgError
				if !errors.As(err, &cause) || cause.Code != "42703" {
					t.Fatalf("classification read lost native cause: %v", err)
				}
			}
		})
	}
}

func TestActiveDependentIDsUseOnlyDirectScopedOrdinaryAndExternalEdges(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	ctx := context.Background()
	project, foreign := testutil.QueryProject(t, database.Pool, database, 1), testutil.QueryProject(t, database.Pool, database, 2)
	predecessor := testutil.QueryTask(t, database, project.ID, 10, model.TaskDone)
	active := testutil.QueryTask(t, database, project.ID, 11, model.TaskInProgress, predecessor.ID)
	done := testutil.QueryTask(t, database, project.ID, 12, model.TaskDone, predecessor.ID)
	testutil.QueryTask(t, database, project.ID, 13, model.TaskTodo, predecessor.ID)
	testutil.QueryTask(t, database, project.ID, 14, model.TaskDone, active.ID)
	testutil.QueryTask(t, database, foreign.ID, 15, model.TaskInProgress, predecessor.ID)
	testutil.MustExec(t, database.Pool, `UPDATE task_dependencies SET external=true WHERE task_id=$1`, done.ID)
	testutil.MustExec(t, database.Pool, `CREATE FUNCTION reject_dependent_materials() RETURNS text LANGUAGE plpgsql STABLE AS $$
		BEGIN RAISE EXCEPTION 'dependent materials must not be selected'; END $$;
		ALTER TABLE tasks RENAME TO task_source;
		CREATE VIEW tasks AS SELECT id, project_id, status, reject_dependent_materials() AS title,
		reject_dependent_materials() AS description, deleted_at FROM task_source`)
	if err := testutil.WriteProject(ctx, database, project.ID, func(tx ProjectWriteScope) error {
		ids, err := tx.TaskDAO().ActiveDependentIDs(ctx, predecessor.ID)
		if err != nil || !reflect.DeepEqual(ids, []string{active.ID, done.ID}) {
			t.Fatalf("direct active dependents lost scope, order, classification or ID-only projection: %#v %v", ids, err)
		}
		empty, err := tx.TaskDAO().ActiveDependentIDs(ctx, testutil.QueryID(99))
		if err != nil || len(empty) != 0 {
			t.Fatalf("empty active dependent lookup failed: %#v %v", empty, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestProjectWriteClockUsesDatabaseStatementTimeAndUTC(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	project := testutil.QueryProject(t, database.Pool, database, 1)
	ctx := t.Context()
	raw, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Rollback(context.Background())
	if _, err := raw.Exec(ctx, "SET LOCAL TIME ZONE 'Asia/Kolkata'"); err != nil {
		t.Fatal(err)
	}
	var before, after time.Time
	if err := raw.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&before); err != nil {
		t.Fatal(err)
	}
	observed, err := task.NewWriter(raw, project.ID).ObservedAt(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if observed.Location() != time.UTC || observed.Before(before) || observed.After(after) {
		t.Fatalf("project clock is not a UTC database statement timestamp: before %s observed %s after %s", before, observed, after)
	}
	if err := raw.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	testutil.AssertPoolReusable(t, database.Pool)
}

func TestProjectWriteClockPreservesQueryFailureCause(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	project := testutil.QueryProject(t, database.Pool, database, 1)
	ctx := t.Context()
	raw, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Rollback(context.Background())
	dao := task.NewWriter(raw, project.ID)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	observed, err := dao.ObservedAt(canceled)
	var failure *Error
	if !observed.IsZero() || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Phase != "read project clock" {
		t.Fatalf("canceled project clock lost its query cause: observed %s, error %v", observed, err)
	}
	_ = raw.Rollback(ctx)
	observed, err = dao.ObservedAt(ctx)
	if !observed.IsZero() || !errors.Is(err, pgx.ErrTxClosed) || !errors.As(err, &failure) || failure.Phase != "read project clock" {
		t.Fatalf("completed project clock hid its closed transaction: observed %s, error %v", observed, err)
	}
	testutil.AssertPoolReusable(t, database.Pool)
}

func TestQueriesKeysetsAndFiltersBeforePagination(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := context.Background()
	project := testutil.QueryProject(t, s.Pool, s, 1)
	instant := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	a := testutil.QueryTask(t, s, project.ID, 11, model.TaskTodo)
	c := testutil.QueryTask(t, s, project.ID, 13, model.TaskTodo)
	b := testutil.QueryTask(t, s, project.ID, 12, model.TaskTodo, c.ID)
	d := testutil.QueryTask(t, s, project.ID, 14, model.TaskDone)
	e := testutil.QueryTask(t, s, project.ID, 15, model.TaskInProgress, d.ID)
	f := testutil.QueryTask(t, s, project.ID, 16, model.TaskTodo, d.ID)
	testutil.MustExec(t, s.Pool, "UPDATE tasks SET created_at = $1", instant)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		todo, yes, no := model.TaskTodo, true, false
		for _, test := range []struct {
			query   TaskQuery
			want    []string
			hasMore bool
		}{
			{TaskQuery{Page: Page{Limit: 2}}, []string{a.ID, b.ID}, true},
			{TaskQuery{Page: Page{Limit: 10, After: &Position{CreatedAt: instant, ID: b.ID}}}, []string{c.ID, d.ID, e.ID, f.ID}, false},
			{TaskQuery{Page: Page{Limit: 2}, Status: &todo, Ready: &yes}, []string{a.ID, c.ID}, true},
			{TaskQuery{Page: Page{Limit: 2, After: &Position{CreatedAt: instant, ID: c.ID}}, Status: &todo, Ready: &yes}, []string{f.ID}, false},
			{TaskQuery{Page: Page{Limit: 1}, Status: &todo, Ready: &no}, []string{b.ID}, false},
			{TaskQuery{Page: Page{Limit: 10}, Ready: &no}, []string{b.ID, d.ID, e.ID}, false},
		} {
			page, err := snapshot.TaskDAO().Tasks(ctx, project.ID, test.query)
			if err != nil {
				t.Fatal(err)
			}
			ids := make([]string, 0, len(page.Items))
			for _, task := range page.Items {
				ids = append(ids, task.ID)
			}
			if !reflect.DeepEqual(ids, test.want) || page.HasMore != test.hasMore {
				t.Fatalf("filtered page: ids %v, more %v; want %v, %v", ids, page.HasMore, test.want, test.hasMore)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestQueriesCandidateGraphReplacesWholeSet(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := context.Background()
	project, other := testutil.QueryProject(t, s.Pool, s, 1), testutil.QueryProject(t, s.Pool, s, 2)
	a := testutil.QueryTask(t, s, project.ID, 11, model.TaskTodo)
	b := testutil.QueryTask(t, s, project.ID, 12, model.TaskTodo, a.ID)
	c := testutil.QueryTask(t, s, project.ID, 13, model.TaskTodo, b.ID)
	z := testutil.QueryTask(t, s, other.ID, 14, model.TaskTodo, a.ID)
	if err := testutil.WriteProject(ctx, s, project.ID, func(tx ProjectWriteScope) error {
		for _, test := range []struct {
			from, to string
			replace  DependencyReplacement
			want     bool
		}{
			{c.ID, a.ID, DependencyReplacement{TaskID: a.ID, DependsOn: nil}, true},
			{b.ID, a.ID, DependencyReplacement{TaskID: a.ID, DependsOn: []string{b.ID}}, true},
			{c.ID, a.ID, DependencyReplacement{TaskID: a.ID, DependsOn: []string{c.ID}}, true},
			{c.ID, a.ID, DependencyReplacement{TaskID: b.ID, DependsOn: nil}, false},
			{c.ID, b.ID, DependencyReplacement{TaskID: c.ID, DependsOn: []string{a.ID}}, false},
			{c.ID, a.ID, DependencyReplacement{TaskID: c.ID, DependsOn: []string{a.ID}}, true},
			{z.ID, a.ID, DependencyReplacement{TaskID: a.ID, DependsOn: nil}, false},
			{a.ID, z.ID, DependencyReplacement{TaskID: a.ID, DependsOn: []string{c.ID}}, false},
		} {
			got, err := tx.TaskDAO().Reachable(ctx, test.from, test.to, test.replace)
			if err != nil || got != test.want {
				t.Fatalf("candidate reachability %#v: %v, %v", test, got, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestQueriesReadFailuresAreNeverEmptyResults(t *testing.T) {
	t.Run("task decoding", func(t *testing.T) {
		s := testutil.OpenStore(t, postgres.Open)
		project := testutil.QueryProject(t, s.Pool, s, 1)
		task := testutil.QueryTask(t, s, project.ID, 11, model.TaskTodo)
		testutil.MustExec(t, s.Pool, `ALTER TABLE tasks RENAME TO task_source;
			CREATE VIEW tasks AS SELECT id, project_id, title, description, status, 'invalid version'::text AS version,
			created_at, updated_at, started_at, completed_at, cancelled_at, allow_agents, required_platform, assigned_to, deleted_at FROM task_source`)
		if err := s.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
			_, err := snapshot.TaskDAO().Tasks(context.Background(), project.ID, TaskQuery{Page: Page{Limit: 10}})
			return err
		}); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("task decode failure became an empty page: %v", err)
		}
		if err := testutil.WriteProject(context.Background(), s, project.ID, func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().TasksByID(context.Background(), []string{task.ID})
			return err
		}); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("prerequisite decode failure became an empty result: %v", err)
		}
	})
}

func TestQueriesScopedResourcesAndUpdates(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := context.Background()
	first, second := testutil.QueryProject(t, s.Pool, s, 1), testutil.QueryProject(t, s.Pool, s, 2)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		page, err := snapshot.TaskDAO().Tasks(ctx, first.ID, TaskQuery{Page: Page{Limit: 10}})
		if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore {
			t.Fatalf("empty task page: %#v, %v", page, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	done := testutil.QueryTask(t, s, first.ID, 10, model.TaskDone)
	pending := testutil.QueryTask(t, s, first.ID, 11, model.TaskTodo)
	other := testutil.QueryTask(t, s, second.ID, 12, model.TaskTodo)
	dependent := testutil.QueryTask(t, s, first.ID, 13, model.TaskTodo, pending.ID, done.ID)
	if !reflect.DeepEqual(dependent.DependsOn, []string{done.ID, pending.ID}) ||
		!reflect.DeepEqual(dependent.BlockedBy, []string{pending.ID}) || dependent.Ready || dependent.Version != 1 {
		t.Fatalf("derived task fields: %#v", dependent)
	}
	if done.DependsOn == nil || done.BlockedBy == nil || pending.Ready != true {
		t.Fatalf("empty dependencies and ready: %#v, %#v", done, pending)
	}
	if err := testutil.WriteProject(ctx, s, first.ID, func(tx ProjectWriteScope) error {
		for _, ids := range [][]string{nil, {}, {other.ID, pending.ID, done.ID, testutil.QueryID(999)}} {
			tasks, err := tx.TaskDAO().TasksByID(ctx, ids)
			if err != nil || tasks == nil {
				t.Fatalf("prerequisites: %#v, %v", tasks, err)
			}
			if len(ids) > 0 && (len(tasks) != 2 || tasks[0].ID != done.ID || tasks[1].ID != pending.ID) {
				t.Fatalf("project-scoped prerequisites: %#v", tasks)
			}
		}
		_, err := tx.TaskDAO().Task(ctx, other.ID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("cross-project task: %v", err)
		}
		_, err = tx.TaskDAO().UpdateTask(ctx, other.ID, TaskWrite{Title: "Forbidden", Status: model.TaskTodo})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("cross-project update: %v", err)
		}
		updated, err := tx.TaskDAO().UpdateTask(ctx, dependent.ID, TaskWrite{Title: "Updated", Status: model.TaskInProgress, DependsOn: []string{done.ID}})
		if err != nil {
			return err
		}
		if updated.Title != "Updated" || updated.Description != "" || updated.Version != 2 ||
			updated.Status != model.TaskInProgress || !updated.CreatedAt.Equal(dependent.CreatedAt) ||
			!updated.UpdatedAt.After(dependent.UpdatedAt) || !reflect.DeepEqual(updated.DependsOn, []string{done.ID}) ||
			len(updated.BlockedBy) != 0 || updated.Ready {
			t.Fatalf("updated task: %#v", updated)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.TaskDAO().Task(ctx, second.ID, done.ID)
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("cross-project snapshot: %v", err)
	}
}
