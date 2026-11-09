package postgres

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Catalog predicates can be evaluated before schema filters. Resolve the
// fixture-owned OID first so concurrent schema cleanup stays outside this check.
const taskSyncIndexColumnsQuery = `SELECT pg_get_indexdef(format('%I.%I', current_schema(), 'tasks_project_updated_id')::regclass) LIKE '%(project_id, updated_at, id)%'`

func TestTaskSyncInterleavedWriteKeepsOneSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, _, reader, project := membershipFixture(t)
	ctx := context.Background()
	a := queryTask(t, database, project.ID, 11, model.TaskTodo)
	b := queryTask(t, database, project.ID, 12, model.TaskTodo, a.ID)
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, reader.UserID)
	var oldEpoch string
	var beforeAccess model.ProjectAccess
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		beforeAccess, err = snapshot.ProjectDAO().ProjectAccess(ctx, reader, project.ID)
		if err != nil {
			return err
		}
		oldEpoch, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, a.ID, TaskWrite{Title: "After", Status: model.TaskDone})
			return err
		}); err != nil {
			return err
		}
		mustQueryExec(t, database, `UPDATE projects SET task_cache_epoch=gen_random_uuid(),execution_warning_minutes=31 WHERE id=$1`, project.ID)
		mustQueryExec(t, database, `UPDATE project_grants SET role='admin',version=9007199254740993,updated_at=statement_timestamp() WHERE project_id=$1 AND user_id=$2`, project.ID, reader.UserID)
		epoch, err := snapshot.TaskDAO().TaskCacheEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		storedProject, err := snapshot.ProjectDAO().Project(ctx, project.ID)
		if err != nil {
			return err
		}
		access, err := snapshot.ProjectDAO().ProjectAccess(ctx, reader, project.ID)
		if err != nil {
			return err
		}
		tasks, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil || epoch != oldEpoch || storedProject != project || !reflect.DeepEqual(access, beforeAccess) || len(tasks) != 2 || tasks[0].TitlePreview != a.Title || tasks[0].Version != 1 || !slices.Equal(tasks[1].DependsOn, []string{a.ID}) {
			t.Fatalf("mixed project/access/epoch/task snapshot: %#v %#v %#v %#v, %v", storedProject, access, epoch, tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		epoch, err := snapshot.TaskDAO().TaskCacheEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		storedProject, err := snapshot.ProjectDAO().Project(ctx, project.ID)
		if err != nil {
			return err
		}
		access, err := snapshot.ProjectDAO().ProjectAccess(ctx, reader, project.ID)
		if err != nil {
			return err
		}
		tasks, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil || epoch == oldEpoch || storedProject.Settings.ExecutionWarningMinutes != 31 || access.Role != model.ProjectAdmin || access.DirectGrant == nil || access.DirectGrant.Version != 9007199254740993 || len(tasks) != 2 || tasks[0].TitlePreview != "After" || tasks[0].Version != 2 || tasks[1].ID != b.ID {
			t.Fatalf("fresh snapshot missed committed history: %#v %#v %#v %#v, %v", storedProject, access, epoch, tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskSyncEpochMigrationAndStableHistory(t *testing.T) {
	pool := emptyPool(t)
	ctx := context.Background()
	if err := migrate(ctx, pool, schemaMigrations[:14]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO projects(id,name,repo_url) VALUES ($1,'Existing','repo')", queryID(1)); err != nil {
		t.Fatal(err)
	}
	if err := seedHistoricalProjectAdmin(ctx, &Store{Pool: pool}, queryID(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO tasks(id,project_id,title) VALUES ($1,$2,'Existing task')", queryID(11), queryID(1)); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := pool.QueryRow(ctx, "SELECT updated_at FROM tasks").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var migrated time.Time
	var version int64
	if err := pool.QueryRow(ctx, "SELECT updated_at, version FROM tasks").Scan(&migrated, &version); err != nil || migrated != before || version != 1 {
		t.Fatalf("migration rewrote task signal: %v %d %v", migrated, version, err)
	}
	s := &Store{Pool: pool}
	var original string
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		original, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, queryID(1))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if original == "" {
		t.Fatal("existing project has no epoch")
	}
	other := queryProject(t, s, 2)
	if err := writeProjectForTest(s, ctx, queryID(1), func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, queryID(11), TaskWrite{Title: "Changed", Status: model.TaskTodo})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		current, err := snapshot.TaskDAO().TaskCacheEpoch(ctx, queryID(1))
		if err != nil {
			return err
		}
		otherEpoch, err := snapshot.TaskDAO().TaskCacheEpoch(ctx, other.ID)
		if err != nil {
			return err
		}
		if current != original || otherEpoch == current {
			t.Fatalf("epoch changed or shared: %s %s", current, otherEpoch)
		}
		_, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, queryID(99))
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("epoch missing cause: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var indexed bool
	if err := pool.QueryRow(ctx, taskSyncIndexColumnsQuery).Scan(&indexed); err != nil {
		t.Fatal(err)
	}
	if !indexed {
		t.Fatal("window index column order is not (project_id, updated_at, id)")
	}
	var after time.Time
	if err := pool.QueryRow(ctx, "SELECT updated_at FROM tasks").Scan(&after); err != nil || !after.After(before) {
		t.Fatalf("normal task mutation clock lost: %v", err)
	}
}

func TestTaskSyncIndexCheckStaysInFixtureSchema(t *testing.T) {
	ctx := context.Background()
	fallback := emptyPool(t)
	if _, err := fallback.Exec(ctx, `CREATE TABLE tasks(project_id integer, updated_at integer, id integer);
		CREATE INDEX tasks_project_updated_id ON tasks(project_id, updated_at, id)`); err != nil {
		t.Fatal(err)
	}
	var fallbackSchema string
	if err := fallback.QueryRow(ctx, "SELECT current_schema()").Scan(&fallbackSchema); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name      string
		indexDDL  string
		want      bool
		wantError bool
	}{
		{"correct order", "CREATE INDEX tasks_project_updated_id ON tasks(project_id, updated_at, id)", true, false},
		{"wrong order", "CREATE INDEX tasks_project_updated_id ON tasks(id, updated_at, project_id)", false, false},
		{"missing index", "", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := emptyPool(t)
			conn, err := pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(conn.Release)
			if _, err := conn.Exec(ctx, "CREATE TABLE tasks(project_id integer, updated_at integer, id integer)"); err != nil {
				t.Fatal(err)
			}
			if test.indexDDL != "" {
				if _, err := conn.Exec(ctx, test.indexDDL); err != nil {
					t.Fatal(err)
				}
			}
			var schema string
			if err := conn.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
				t.Fatal(err)
			}
			searchPath := pgx.Identifier{schema}.Sanitize() + ", " + pgx.Identifier{fallbackSchema}.Sanitize()
			if _, err := conn.Exec(ctx, "SELECT set_config('search_path', $1, false)", searchPath); err != nil {
				t.Fatal(err)
			}
			var indexed bool
			err = conn.QueryRow(ctx, taskSyncIndexColumnsQuery).Scan(&indexed)
			if test.wantError {
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "42P01" {
					t.Fatalf("missing fixture index did not fail: indexed=%v err=%v", indexed, err)
				}
				return
			}
			if err != nil || indexed != test.want {
				t.Fatalf("fixture index column order: indexed=%v want=%v err=%v", indexed, test.want, err)
			}
		})
	}
}

func TestTaskSyncSnapshotCannotEscapeCallback(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	var expired SnapshotScope
	if err := s.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error { expired = snapshot; return nil }); err != nil {
		t.Fatal(err)
	}
	rows, err := expired.TaskDAO().TaskSyncTasks(context.Background(), queryID(1), nil, 160)
	if !errors.Is(err, pgx.ErrTxClosed) || !reflect.DeepEqual(rows, []model.TaskViewRecord(nil)) {
		t.Fatalf("closed snapshot: %#v %v", rows, err)
	}
}
