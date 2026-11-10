package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5/pgconn"
)

func queryID(number int) string { return testutil.QueryID(number) }

func queryProject(t *testing.T, s *Store, number int) model.Project {
	t.Helper()
	return testutil.QueryProject(t, s.Pool, s, number)
}

func queryTask(t *testing.T, s *Store, projectID string, number int, status model.TaskStatus, dependencies ...string) model.Task {
	t.Helper()
	return testutil.QueryTask(t, s, projectID, number, status, dependencies...)
}

func snapshotTask(t *testing.T, s *Store, projectID, id string) model.Task {
	t.Helper()
	return testutil.SnapshotTask(t, s, projectID, id)
}

func mustQueryExec(t *testing.T, s *Store, sql string, args ...any) {
	t.Helper()
	testutil.MustExec(t, s.Pool, sql, args...)
}

func TestQueriesScopedResourcesAndUpdates(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := t.Context()
	if err := writeProjectForTest(s, ctx, queryID(999), func(ProjectWriteScope) error {
		t.Fatal("missing project invoked write callback")
		return nil
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing project write: %v", err)
	}
}

func TestQueriesPartialWriteRollbackRestoresResource(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	old := queryTask(t, s, project.ID, 11, model.TaskDone)
	first := queryTask(t, s, project.ID, 12, model.TaskDone)
	second := queryTask(t, s, project.ID, 13, model.TaskDone)
	before := queryTask(t, s, project.ID, 14, model.TaskTodo, old.ID)
	mustQueryExec(t, s, `CREATE FUNCTION reject_second_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
		IF NEW.depends_on_task_id = '`+second.ID+`' THEN
			IF NOT EXISTS (SELECT 1 FROM tasks WHERE id = '`+before.ID+`' AND title = 'Changed' AND version = 2)
				OR NOT EXISTS (SELECT 1 FROM task_dependencies WHERE task_id = NEW.task_id AND depends_on_task_id = '`+first.ID+`') THEN
				RAISE EXCEPTION 'failure was injected before partial write';
			END IF;
			RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'sensitive database diagnostic';
		END IF;
		RETURN NEW;
		END $$;
		CREATE TRIGGER reject_second_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_second_edge()`)
	err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, before.ID, TaskWrite{Title: "Changed", Description: "Changed", Status: model.TaskDone, DependsOn: []string{first.ID, second.ID}})
		return err
	})
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P1001" || strings.Contains(err.Error(), "sensitive") {
		t.Fatalf("partial write failure cause: %v", err)
	}
	after := snapshotTask(t, s, project.ID, before.ID)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("partial rollback changed resource:\nbefore %#v\nafter %#v", before, after)
	}
}

func TestQueriesSnapshotRetainsCompleteOldGraph(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	a := queryTask(t, s, project.ID, 11, model.TaskTodo)
	b := queryTask(t, s, project.ID, 12, model.TaskTodo, a.ID)
	c := queryTask(t, s, project.ID, 13, model.TaskDone)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if _, err := snapshot.ProjectDAO().Project(ctx, project.ID); err != nil {
			return err
		}
		var isolation, readOnly string
		if err := snapshot.(*Snapshot).tx.QueryRow(ctx, "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')").Scan(&isolation, &readOnly); err != nil || isolation != "repeatable read" || readOnly != "on" {
			t.Fatalf("snapshot transaction modes: %s %s, %v", isolation, readOnly, err)
		}
		if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
			if _, err := tx.TaskDAO().UpdateTask(ctx, a.ID, TaskWrite{Title: "Done", Status: model.TaskDone}); err != nil {
				return err
			}
			_, err := tx.TaskDAO().UpdateTask(ctx, b.ID, TaskWrite{Title: "Changed", Status: model.TaskTodo, DependsOn: []string{c.ID}})
			return err
		}); err != nil {
			return err
		}
		old, err := snapshot.TaskDAO().Task(ctx, project.ID, b.ID)
		if err != nil || !reflect.DeepEqual(old, b) {
			t.Fatalf("snapshot mixed graph: %#v, %v", old, err)
		}
		oldA, err := snapshot.TaskDAO().Task(ctx, project.ID, a.ID)
		if err != nil || !reflect.DeepEqual(oldA, a) {
			t.Fatalf("snapshot mixed predecessor: %#v, %v", oldA, err)
		}
		page, err := snapshot.TaskDAO().Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
		if err != nil || len(page.Items) != 3 || !reflect.DeepEqual(page.Items[1], b) {
			t.Fatalf("snapshot mixed list: %#v, %v", page, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	updated := snapshotTask(t, s, project.ID, b.ID)
	if updated.Title != "Changed" || !updated.Ready || len(updated.BlockedBy) != 0 || !reflect.DeepEqual(updated.DependsOn, []string{c.ID}) || updated.Version != 2 {
		t.Fatalf("new snapshot: %#v", updated)
	}
	oldDependent := b
	if !reflect.DeepEqual(oldDependent.DependsOn, []string{a.ID}) || !reflect.DeepEqual(oldDependent.BlockedBy, []string{a.ID}) {
		t.Fatal("reader returned shared mutable dependency slices")
	}
}

func projectBeforeSettings(t *testing.T, database *Store, number int) model.Project {
	t.Helper()
	project := model.Project{ID: queryID(number), Name: "Project", RepoURL: "https://example.com/owner/repo.git"}
	if err := database.Pool.QueryRow(context.Background(), `INSERT INTO projects (id, name, repo_url)
		VALUES ($1, $2, $3) RETURNING created_at, updated_at`, project.ID, project.Name, project.RepoURL).
		Scan(&project.CreatedAt, &project.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	return project
}
