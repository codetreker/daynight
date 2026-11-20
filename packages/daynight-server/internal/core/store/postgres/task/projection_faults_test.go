package task_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type taskReaderFault struct {
	name, ddl, restore, state string
	scanColumn                int
}

const hideTaskProjection = `ALTER VIEW task_resource_rows RENAME TO resource_source;
 ALTER TABLE tasks RENAME TO tasks_source`
const restoreTaskProjection = `ALTER TABLE tasks_source RENAME TO tasks;
 ALTER VIEW resource_source RENAME TO task_resource_rows`
const restoreTaskProjectionView = `DROP VIEW task_resource_rows;
 ALTER VIEW resource_source RENAME TO task_resource_rows`

func taskProjectionView(title, createdAt, updatedAt string) string {
	return `ALTER VIEW task_resource_rows RENAME TO resource_source;
 CREATE VIEW task_resource_rows AS SELECT id,project_id,type,parent_id,` + title + `,status,version,` +
		createdAt + `,` + updatedAt + `,started_at,completed_at,cancelled_at,allow_agents,
 required_platform,assigned_to,deleted_at,effective_deleted_at FROM resource_source`
}

func TestTaskGraphStoreFailuresPreserveCauses(t *testing.T) {
	runTaskProjectionFaults(t, "read task graph", func(ctx context.Context, reader store.TaskReader, projectID string) ([]model.GraphTask, error) {
		return reader.TaskGraphTasks(ctx, projectID, readerID(11), readerGraphSelection(), 160)
	}, []taskReaderFault{
		{name: "query", ddl: hideTaskProjection, restore: restoreTaskProjection, state: "42P01"},
		{name: "decode", ddl: taskProjectionView("title", "1::bigint AS created_at", "updated_at"), restore: restoreTaskProjectionView, scanColumn: 7},
		{
			name: "iteration", state: "P1003",
			ddl: `CREATE FUNCTION fail_graph_stamp() RETURNS timestamptz LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='private graph failure'; END $$;` +
				taskProjectionView("title", "created_at", "fail_graph_stamp() AS updated_at"),
			restore: restoreTaskProjectionView + "; DROP FUNCTION fail_graph_stamp()",
		},
	})
}

func TestTaskSyncStoreFailuresPreserveCauses(t *testing.T) {
	runTaskProjectionFaults(t, "read task sync", func(ctx context.Context, reader store.TaskReader, projectID string) ([]model.TaskViewRecord, error) {
		return reader.TaskSyncTasks(ctx, projectID, nil, 160)
	}, []taskReaderFault{
		{name: "query", ddl: hideTaskProjection, restore: restoreTaskProjection, state: "42P01"},
		{name: "missing-title", ddl: taskProjectionView("NULL::text AS title", "created_at", "updated_at"), restore: restoreTaskProjectionView, scanColumn: 3},
		{name: "decode", ddl: taskProjectionView("title", "1::bigint AS created_at", "updated_at"), restore: restoreTaskProjectionView, scanColumn: 8},
		{
			name: "iteration", state: "P1003",
			ddl: `CREATE FUNCTION fail_sync_stamp() RETURNS timestamptz LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='private sync failure'; END $$;` +
				taskProjectionView("title", "created_at", "fail_sync_stamp() AS updated_at"),
			restore: restoreTaskProjectionView + "; DROP FUNCTION fail_sync_stamp()",
		},
	})
}

func taskProjectionRelations(t *testing.T, ctx context.Context, db *postgres.Store) [2]uint32 {
	t.Helper()
	var oids [2]uint32
	var intact bool
	err := db.Pool.QueryRow(ctx, `SELECT 'tasks'::regclass::oid,'task_resource_rows'::regclass::oid,
 to_regclass('tasks_source') IS NULL AND to_regclass('resource_source') IS NULL
 AND to_regprocedure('fail_graph_stamp()') IS NULL AND to_regprocedure('fail_sync_stamp()') IS NULL`).
		Scan(&oids[0], &oids[1], &intact)
	if err != nil || !intact {
		t.Fatalf("task projection catalog is not intact: %v, %v", intact, err)
	}
	return oids
}

func runTaskProjectionFaults[T any](t *testing.T, phase string, read func(context.Context, store.TaskReader, string) ([]T, error), faults []taskReaderFault) {
	t.Helper()
	db := readerStore(t)
	project := readerProject(t, db, 1)
	readerTask(t, db, project.ID, 11, model.TaskTodo)
	snapshot := func(ctx context.Context) ([]T, error) {
		var rows []T
		err := db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
			var err error
			rows, err = read(ctx, scope.TaskDAO(), project.ID)
			return err
		})
		return rows, err
	}
	before, err := snapshot(t.Context())
	if err != nil || len(before) != 1 {
		t.Fatalf("task projection fixture: %v, %v", before, err)
	}
	oids := taskProjectionRelations(t, t.Context(), db)
	for _, fault := range faults {
		if !t.Run(fault.name, func(t *testing.T) {
			fault.run(t, db, func(ctx context.Context) {
				rows, err := snapshot(ctx)
				if len(rows) != 0 {
					t.Fatalf("faulted task projection returned partial rows: %v", rows)
				}
				fault.requireCause(t, err, phase)
			}, func(ctx context.Context) {
				if restored := taskProjectionRelations(t, ctx, db); restored != oids {
					t.Fatalf("restored task projection relation OIDs = %v, want %v", restored, oids)
				}
				after, err := snapshot(ctx)
				if err != nil || !reflect.DeepEqual(after, before) {
					t.Fatalf("task projection after restoration = %v, %v, want %v", after, err, before)
				}
			})
		}) {
			return
		}
	}
}

func (fault taskReaderFault) run(t *testing.T, db *postgres.Store, check, verifyRestored func(context.Context)) {
	t.Helper()
	ctx, stop := context.WithTimeout(t.Context(), 15*time.Second)
	defer stop()
	if _, err := db.Pool.Exec(ctx, fault.ddl); err != nil {
		t.Fatalf("install %s fault: %v", fault.name, err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := db.Pool.Exec(cleanup, fault.restore); err != nil {
			t.Fatalf("restore %s fault: %v", fault.name, err)
		}
		db.Pool.Reset()
		verifyRestored(cleanup)
	}()
	// A replacement view can change the result type of an already prepared query.
	db.Pool.Reset()
	check(ctx)
}

func (fault taskReaderFault) requireCause(t *testing.T, err error, phase string) {
	t.Helper()
	var transaction *store.TransactionError
	var cause *store.Error
	if !errors.As(err, &transaction) || !errors.As(transaction.Cause, &cause) ||
		cause.Phase != phase || errors.Is(err, model.ErrNotFound) || strings.Contains(err.Error(), "private") {
		t.Fatalf("%s failure was hidden or leaked: %v", fault.name, err)
	}
	if fault.state != "" {
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != fault.state {
			t.Fatalf("%s error = %v, want SQLSTATE %s", fault.name, err, fault.state)
		}
	} else {
		var scan pgx.ScanArgError
		if !errors.As(err, &scan) || scan.ColumnIndex != fault.scanColumn {
			t.Fatalf("%s error = %v, want scan error at column %d", fault.name, err, fault.scanColumn)
		}
	}
}
