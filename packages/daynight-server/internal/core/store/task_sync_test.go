package store

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Catalog predicates can be evaluated before schema filters. Resolve the
// fixture-owned OID first so concurrent schema cleanup stays outside this check.
const taskSyncIndexColumnsQuery = `SELECT pg_get_indexdef(format('%I.%I', current_schema(), 'tasks_project_updated_id')::regclass) LIKE '%(project_id, updated_at, id)%'`

func TestTaskSyncProjectionAndExactLowerBound(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	project, other := queryProject(t, s, 1), queryProject(t, s, 2)
	queryTask(t, s, other.ID, 19, core.TaskTodo)
	a := queryTask(t, s, project.ID, 10, core.TaskDone)
	b := queryTask(t, s, project.ID, 11, core.TaskInProgress, a.ID)
	c := queryTask(t, s, project.ID, 12, core.TaskTodo, a.ID, b.ID)
	stamp := time.Date(2026, 10, 24, 1, 2, 3, 123456000, time.UTC)
	mustQueryExec(t, s, `UPDATE tasks SET created_at=$1, updated_at=$1, version=9007199254740993,
		title=repeat('😀',161), description=repeat('private description',10000) WHERE project_id=$2`, stamp, project.ID)
	mustQueryExec(t, s, "UPDATE tasks SET updated_at=$1, required_platform='linux', allow_agents=true WHERE id=$2", stamp.Add(time.Microsecond), c.ID)
	mustQueryExec(t, s, "UPDATE task_dependencies SET external=true WHERE task_id=$1 AND depends_on_task_id=$2", c.ID, b.ID)
	// Failing detail expressions prove that the summary reader never selects bodies.
	mustQueryExec(t, s, `CREATE FUNCTION reject_sync_detail() RETURNS text LANGUAGE plpgsql STABLE AS $$
		BEGIN RAISE EXCEPTION 'private details selected'; END $$;
		ALTER TABLE tasks RENAME TO task_source;
		CREATE VIEW tasks AS SELECT id, project_id, title, reject_sync_detail() AS description,
		status, version, created_at, updated_at, started_at, completed_at, allow_agents, required_platform, worker_needs_attention, deleted_at FROM task_source`)
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		all, err := snapshot.TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil || len(all) != 3 || all[0].Version != 9007199254740993 || all[0].TitlePreview != strings.Repeat("😀", 160) || !all[0].TitleTruncated ||
			all[0].RequiredPlatform != nil || all[2].RequiredPlatform == nil || *all[2].RequiredPlatform != core.TaskPlatform("linux") || !all[2].AllowAgents ||
			!slices.Equal(all[2].DependsOn, []string{a.ID, b.ID}) || !slices.Equal(all[2].ExternalDependsOn, []string{b.ID}) {
			t.Fatalf("intrinsic projection: %#v, %v", all, err)
		}
		for _, test := range []struct {
			lower time.Time
			count int
		}{
			{stamp, 3}, {stamp.Add(time.Nanosecond), 1}, {stamp.Add(999 * time.Nanosecond), 1},
			{stamp.Add(time.Microsecond), 1}, {stamp.Add(time.Microsecond + time.Nanosecond), 0},
		} {
			got, err := snapshot.TaskSyncTasks(ctx, project.ID, &test.lower, 160)
			if err != nil || got == nil || len(got) != test.count {
				t.Fatalf("lower %s: %#v, %v", test.lower.Format(time.RFC3339Nano), got, err)
			}
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
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		var err error
		original, err = snapshot.TaskCacheEpoch(ctx, queryID(1))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if original == "" {
		t.Fatal("existing project has no epoch")
	}
	other := queryProject(t, s, 2)
	if err := s.WriteProject(ctx, queryID(1), func(tx *ProjectTx) error {
		_, err := tx.UpdateTask(ctx, queryID(11), TaskWrite{Title: "Changed", Status: core.TaskTodo})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		current, err := snapshot.TaskCacheEpoch(ctx, queryID(1))
		if err != nil {
			return err
		}
		otherEpoch, err := snapshot.TaskCacheEpoch(ctx, other.ID)
		if err != nil {
			return err
		}
		if current != original || otherEpoch == current {
			t.Fatalf("epoch changed or shared: %s %s", current, otherEpoch)
		}
		_, err = snapshot.TaskCacheEpoch(ctx, queryID(99))
		if !errors.Is(err, core.ErrNotFound) {
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

func TestTaskSyncStoreFailuresPreserveCauses(t *testing.T) {
	for _, test := range []struct{ name, ddl string }{
		{"query", "DROP TABLE tasks"},
		{"decode", `ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,title,status,version,1::bigint AS created_at,updated_at,started_at,completed_at,allow_agents,required_platform,worker_needs_attention,deleted_at FROM task_source`},
		{"invalid status", `ALTER TABLE tasks DROP CONSTRAINT tasks_status_check; UPDATE tasks SET status='invalid'`},
		{"iteration", `CREATE FUNCTION fail_sync_stamp() RETURNS timestamptz LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='private sync failure'; END $$; ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,title,status,version,created_at,fail_sync_stamp() AS updated_at,started_at,completed_at,allow_agents,required_platform,worker_needs_attention,deleted_at FROM task_source`},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := isolatedStore(t)
			project := queryProject(t, s, 1)
			queryTask(t, s, project.ID, 11, core.TaskTodo)
			mustQueryExec(t, s, test.ddl)
			err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
				_, err := snapshot.TaskSyncTasks(context.Background(), project.ID, nil, 160)
				return err
			})
			if err == nil || errors.Is(err, core.ErrNotFound) || strings.Contains(err.Error(), "private") {
				t.Fatalf("sync failure hidden or leaked: %v", err)
			}
			if test.name == "iteration" {
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "P1003" {
					t.Fatalf("driver cause lost: %v", err)
				}
			}
		})
	}
	s := isolatedStore(t)
	var expired *Snapshot
	if err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error { expired = snapshot; return nil }); err != nil {
		t.Fatal(err)
	}
	rows, err := expired.TaskSyncTasks(context.Background(), queryID(1), nil, 160)
	if !errors.Is(err, pgx.ErrTxClosed) || !reflect.DeepEqual(rows, []core.TaskViewRecord(nil)) {
		t.Fatalf("closed snapshot: %#v %v", rows, err)
	}
}
