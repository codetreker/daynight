package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func queryID(number int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", number) }

func queryProject(t *testing.T, s *Store, number int) core.Project {
	t.Helper()
	project, err := s.CreateProject(context.Background(), queryID(number), "Project", "https://example.com/owner/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func queryTask(t *testing.T, s *Store, projectID string, number int, status core.TaskStatus, dependencies ...string) core.Task {
	t.Helper()
	var task core.Task
	err := s.WriteProject(context.Background(), projectID, func(tx *ProjectTx) error {
		var err error
		task, err = tx.CreateTask(context.Background(), queryID(number), TaskWrite{
			Title: "Task", Description: "Description", Status: status, DependsOn: dependencies,
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func snapshotTask(t *testing.T, s *Store, projectID, id string) core.Task {
	t.Helper()
	var task core.Task
	err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
		var err error
		task, err = snapshot.Task(context.Background(), projectID, id)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func mustQueryExec(t *testing.T, s *Store, sql string, args ...any) {
	t.Helper()
	if _, err := s.Pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func TestTaskReadersRejectInvalidStoredStatus(t *testing.T) {
	for _, status := range []string{"proposed", "unknown"} {
		t.Run(status, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := context.Background()
			project := queryProject(t, database, 1)
			task := queryTask(t, database, project.ID, 11, core.TaskTodo)
			mustQueryExec(t, database, `ALTER TABLE tasks DROP CONSTRAINT tasks_status_check`)
			mustQueryExec(t, database, `UPDATE tasks SET status=$1 WHERE id=$2`, status, task.ID)
			for _, read := range []func(*Snapshot) error{
				func(snapshot *Snapshot) error { _, err := snapshot.Task(ctx, project.ID, task.ID); return err },
				func(snapshot *Snapshot) error {
					_, err := snapshot.Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
					return err
				},
				func(snapshot *Snapshot) error { _, err := snapshot.TaskGraphTasks(ctx, project.ID, 160); return err },
			} {
				if err := database.ReadSnapshot(ctx, read); err == nil || errors.Is(err, core.ErrNotFound) {
					t.Fatalf("invalid persisted status was accepted or hidden: %v", err)
				}
			}
		})
	}
}

func TestQueriesScopedResourcesAndUpdates(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	first, second := queryProject(t, s, 1), queryProject(t, s, 2)
	if first.CreatedAt.IsZero() || first.CreatedAt.Location() != time.UTC || !first.CreatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("database creation timestamps: %#v", first)
	}
	if _, err := s.CreateProject(ctx, first.ID, "Duplicate", "ssh://git@example.com/repo"); err == nil {
		t.Fatal("duplicate project succeeded")
	} else {
		var cause *pgconn.PgError
		if !errors.As(err, &cause) || cause.Code != "23505" || strings.Contains(err.Error(), "projects_pkey") {
			t.Fatalf("redacted error and driver cause: %v", err)
		}
	}
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		project, err := snapshot.Project(ctx, first.ID)
		if err != nil || !reflect.DeepEqual(project, first) {
			t.Fatalf("project read: %#v, %v", project, err)
		}
		page, err := snapshot.Tasks(ctx, first.ID, TaskQuery{Page: Page{Limit: 10}})
		if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore {
			t.Fatalf("empty task page: %#v, %v", page, err)
		}
		_, err = snapshot.Project(ctx, queryID(999))
		return err
	}); !errors.Is(err, core.ErrNotFound) || !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing project: %v", err)
	}
	if err := s.WriteProject(ctx, queryID(999), func(*ProjectTx) error {
		t.Fatal("missing project invoked write callback")
		return nil
	}); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("missing project write: %v", err)
	}
	done := queryTask(t, s, first.ID, 10, core.TaskDone)
	pending := queryTask(t, s, first.ID, 11, core.TaskTodo)
	other := queryTask(t, s, second.ID, 12, core.TaskTodo)
	dependent := queryTask(t, s, first.ID, 13, core.TaskTodo, pending.ID, done.ID)
	if !reflect.DeepEqual(dependent.DependsOn, []string{done.ID, pending.ID}) ||
		!reflect.DeepEqual(dependent.BlockedBy, []string{pending.ID}) || dependent.Ready || dependent.Version != 1 {
		t.Fatalf("derived task fields: %#v", dependent)
	}
	if done.DependsOn == nil || done.BlockedBy == nil || pending.Ready != true {
		t.Fatalf("empty dependencies and ready: %#v, %#v", done, pending)
	}
	if err := s.WriteProject(ctx, first.ID, func(tx *ProjectTx) error {
		for _, ids := range [][]string{nil, {}, {other.ID, pending.ID, done.ID, queryID(999)}} {
			tasks, err := tx.TasksByID(ctx, ids)
			if err != nil || tasks == nil {
				t.Fatalf("prerequisites: %#v, %v", tasks, err)
			}
			if len(ids) > 0 && (len(tasks) != 2 || tasks[0].ID != done.ID || tasks[1].ID != pending.ID) {
				t.Fatalf("project-scoped prerequisites: %#v", tasks)
			}
		}
		_, err := tx.Task(ctx, other.ID)
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("cross-project task: %v", err)
		}
		_, err = tx.UpdateTask(ctx, other.ID, TaskWrite{Title: "Forbidden", Status: core.TaskTodo})
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("cross-project update: %v", err)
		}
		updated, err := tx.UpdateTask(ctx, dependent.ID, TaskWrite{Title: "Updated", Status: core.TaskInProgress, DependsOn: []string{done.ID}})
		if err != nil {
			return err
		}
		if updated.Title != "Updated" || updated.Description != "" || updated.Version != 2 ||
			updated.Status != core.TaskInProgress || !updated.CreatedAt.Equal(dependent.CreatedAt) ||
			!updated.UpdatedAt.After(dependent.UpdatedAt) || !reflect.DeepEqual(updated.DependsOn, []string{done.ID}) ||
			len(updated.BlockedBy) != 0 || updated.Ready {
			t.Fatalf("updated task: %#v", updated)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		_, err := snapshot.Task(ctx, second.ID, done.ID)
		return err
	}); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("cross-project snapshot: %v", err)
	}
}

func TestQueriesKeysetsAndFiltersBeforePagination(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	for _, n := range []int{3, 2, 4} {
		queryProject(t, s, n)
	}
	instant := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	mustQueryExec(t, s, "UPDATE projects SET created_at = $1", instant)
	a := queryTask(t, s, project.ID, 11, core.TaskTodo)
	c := queryTask(t, s, project.ID, 13, core.TaskTodo)
	b := queryTask(t, s, project.ID, 12, core.TaskTodo, c.ID)
	d := queryTask(t, s, project.ID, 14, core.TaskDone)
	e := queryTask(t, s, project.ID, 15, core.TaskInProgress, d.ID)
	f := queryTask(t, s, project.ID, 16, core.TaskTodo, d.ID)
	mustQueryExec(t, s, "UPDATE tasks SET created_at = $1", instant)
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		first, err := snapshot.Projects(ctx, Page{Limit: 2})
		if err != nil || !first.HasMore || len(first.Items) != 2 || first.Items[0].ID != queryID(1) || first.Items[1].ID != queryID(2) {
			t.Fatalf("first project page: %#v, %v", first, err)
		}
		second, err := snapshot.Projects(ctx, Page{Limit: 2, After: &Position{instant, first.Items[1].ID}})
		if err != nil || second.HasMore || len(second.Items) != 2 || second.Items[0].ID != queryID(3) || second.Items[1].ID != queryID(4) {
			t.Fatalf("second project page: %#v, %v", second, err)
		}
		empty, err := snapshot.Projects(ctx, Page{Limit: 2, After: &Position{instant, queryID(4)}})
		if err != nil || empty.HasMore || empty.Items == nil || len(empty.Items) != 0 {
			t.Fatalf("empty project page: %#v, %v", empty, err)
		}
		todo, yes, no := core.TaskTodo, true, false
		for _, test := range []struct {
			query   TaskQuery
			want    []string
			hasMore bool
		}{
			{TaskQuery{Page: Page{Limit: 2}}, []string{a.ID, b.ID}, true},
			{TaskQuery{Page: Page{Limit: 10, After: &Position{instant, b.ID}}}, []string{c.ID, d.ID, e.ID, f.ID}, false},
			{TaskQuery{Page: Page{Limit: 2}, Status: &todo, Ready: &yes}, []string{a.ID, c.ID}, true},
			{TaskQuery{Page: Page{Limit: 2, After: &Position{instant, c.ID}}, Status: &todo, Ready: &yes}, []string{f.ID}, false},
			{TaskQuery{Page: Page{Limit: 1}, Status: &todo, Ready: &no}, []string{b.ID}, false},
			{TaskQuery{Page: Page{Limit: 10}, Ready: &no}, []string{b.ID, d.ID, e.ID}, false},
		} {
			page, err := snapshot.Tasks(ctx, project.ID, test.query)
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
	s := isolatedStore(t)
	ctx := context.Background()
	project, other := queryProject(t, s, 1), queryProject(t, s, 2)
	a := queryTask(t, s, project.ID, 11, core.TaskTodo)
	b := queryTask(t, s, project.ID, 12, core.TaskTodo, a.ID)
	c := queryTask(t, s, project.ID, 13, core.TaskTodo, b.ID)
	z := queryTask(t, s, other.ID, 14, core.TaskTodo, a.ID)
	if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		for _, test := range []struct {
			from, to string
			replace  DependencyReplacement
			want     bool
		}{
			{c.ID, a.ID, DependencyReplacement{a.ID, nil}, true},
			{b.ID, a.ID, DependencyReplacement{a.ID, []string{b.ID}}, true},
			{c.ID, a.ID, DependencyReplacement{a.ID, []string{c.ID}}, true},
			{c.ID, a.ID, DependencyReplacement{b.ID, nil}, false},
			{c.ID, b.ID, DependencyReplacement{c.ID, []string{a.ID}}, false},
			{c.ID, a.ID, DependencyReplacement{c.ID, []string{a.ID}}, true},
			{z.ID, a.ID, DependencyReplacement{a.ID, nil}, false},
			{a.ID, z.ID, DependencyReplacement{a.ID, []string{c.ID}}, false},
		} {
			got, err := tx.Reachable(ctx, test.from, test.to, test.replace)
			if err != nil || got != test.want {
				t.Fatalf("candidate reachability %#v: %v, %v", test, got, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestQueriesPartialWriteRollbackRestoresResource(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	old := queryTask(t, s, project.ID, 11, core.TaskDone)
	first := queryTask(t, s, project.ID, 12, core.TaskDone)
	second := queryTask(t, s, project.ID, 13, core.TaskDone)
	before := queryTask(t, s, project.ID, 14, core.TaskTodo, old.ID)
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
	err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		_, err := tx.UpdateTask(ctx, before.ID, TaskWrite{Title: "Changed", Description: "Changed", Status: core.TaskDone, DependsOn: []string{first.ID, second.ID}})
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
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	a := queryTask(t, s, project.ID, 11, core.TaskTodo)
	b := queryTask(t, s, project.ID, 12, core.TaskTodo, a.ID)
	c := queryTask(t, s, project.ID, 13, core.TaskDone)
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		if _, err := snapshot.Project(ctx, project.ID); err != nil {
			return err
		}
		var isolation, readOnly string
		if err := snapshot.tx.QueryRow(ctx, "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')").Scan(&isolation, &readOnly); err != nil || isolation != "repeatable read" || readOnly != "on" {
			t.Fatalf("snapshot transaction modes: %s %s, %v", isolation, readOnly, err)
		}
		if err := s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
			if _, err := tx.UpdateTask(ctx, a.ID, TaskWrite{Title: "Done", Status: core.TaskDone}); err != nil {
				return err
			}
			_, err := tx.UpdateTask(ctx, b.ID, TaskWrite{Title: "Changed", Status: core.TaskTodo, DependsOn: []string{c.ID}})
			return err
		}); err != nil {
			return err
		}
		old, err := snapshot.Task(ctx, project.ID, b.ID)
		if err != nil || !reflect.DeepEqual(old, b) {
			t.Fatalf("snapshot mixed graph: %#v, %v", old, err)
		}
		oldA, err := snapshot.Task(ctx, project.ID, a.ID)
		if err != nil || !reflect.DeepEqual(oldA, a) {
			t.Fatalf("snapshot mixed predecessor: %#v, %v", oldA, err)
		}
		page, err := snapshot.Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}})
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

func TestQueriesReadFailuresAreNeverEmptyResults(t *testing.T) {
	t.Run("project decoding", func(t *testing.T) {
		s := isolatedStore(t)
		queryProject(t, s, 1)
		mustQueryExec(t, s, `ALTER TABLE projects RENAME TO project_source;
			CREATE VIEW projects AS SELECT id, name, repo_url, created_at, 1::bigint AS updated_at, settings_version, execution_warning_minutes FROM project_source`)
		err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
			_, err := snapshot.Projects(context.Background(), Page{Limit: 10})
			return err
		})
		if err == nil || errors.Is(err, core.ErrNotFound) {
			t.Fatalf("project decode failure became an empty result: %v", err)
		}
	})
	t.Run("project database execution", func(t *testing.T) {
		s := isolatedStore(t)
		queryProject(t, s, 1)
		mustQueryExec(t, s, `CREATE FUNCTION fail_read() RETURNS text LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'private read failure'; END $$;
			ALTER TABLE projects RENAME TO project_source;
			CREATE VIEW projects AS SELECT id, fail_read() AS name, repo_url, created_at, updated_at, settings_version, execution_warning_minutes FROM project_source`)
		err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
			_, err := snapshot.Projects(context.Background(), Page{Limit: 10})
			return err
		})
		var cause *pgconn.PgError
		if !errors.As(err, &cause) || cause.Code != "P1002" || strings.Contains(err.Error(), "private read") {
			t.Fatalf("project read failure cause or redaction: %v", err)
		}
	})
	t.Run("task decoding", func(t *testing.T) {
		s := isolatedStore(t)
		project := queryProject(t, s, 1)
		task := queryTask(t, s, project.ID, 11, core.TaskTodo)
		mustQueryExec(t, s, `ALTER TABLE tasks RENAME TO task_source;
			CREATE VIEW tasks AS SELECT id, project_id, title, description, status, 'invalid version'::text AS version,
			created_at, updated_at, started_at, completed_at, allow_agents, required_platform, properties, deleted_at FROM task_source`)
		if err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
			_, err := snapshot.Tasks(context.Background(), project.ID, TaskQuery{Page: Page{Limit: 10}})
			return err
		}); err == nil || errors.Is(err, core.ErrNotFound) {
			t.Fatalf("task decode failure became an empty page: %v", err)
		}
		if err := s.WriteProject(context.Background(), project.ID, func(tx *ProjectTx) error {
			_, err := tx.TasksByID(context.Background(), []string{task.ID})
			return err
		}); err == nil || errors.Is(err, core.ErrNotFound) {
			t.Fatalf("prerequisite decode failure became an empty result: %v", err)
		}
	})
}

func projectBeforeSettings(t *testing.T, database *Store, number int) core.Project {
	t.Helper()
	project := core.Project{ID: queryID(number), Name: "Project", RepoURL: "https://example.com/owner/repo.git"}
	if err := database.Pool.QueryRow(context.Background(), `INSERT INTO projects (id, name, repo_url)
		VALUES ($1, $2, $3) RETURNING created_at, updated_at`, project.ID, project.Name, project.RepoURL).
		Scan(&project.CreatedAt, &project.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	return project
}
