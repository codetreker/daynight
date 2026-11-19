package task_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func taskPriorityAssigneeRelations(t *testing.T, ctx context.Context, db *postgres.Store) [4]uint32 {
	t.Helper()
	var oids [4]uint32
	var intact bool
	err := db.Pool.QueryRow(ctx, `SELECT 'tasks'::regclass::oid,'task_resource_rows'::regclass::oid,
 'task_dependencies'::regclass::oid,'users'::regclass::oid,
 to_regclass('tasks_source') IS NULL AND to_regclass('resource_source') IS NULL
 AND to_regclass('dependencies_source') IS NULL AND to_regclass('assignee_user_source') IS NULL
 AND to_regprocedure('fail_priority_title()') IS NULL AND to_regprocedure('refuse_assignee_profile(uuid)') IS NULL`).
		Scan(&oids[0], &oids[1], &oids[2], &oids[3], &intact)
	if err != nil || !intact {
		t.Fatalf("task reader catalog is not intact: %v, %v", intact, err)
	}
	return oids
}

func TestTaskPriorityListStorageFailures(t *testing.T) {
	db := readerStore(t)
	project := readerProject(t, db, 1)
	item := readerTask(t, db, project.ID, 11, model.TaskTodo)
	oids := taskPriorityAssigneeRelations(t, t.Context(), db)
	query := store.TaskPriorityQuery{Limit: 1}
	type priorityState struct {
		fence store.TaskListFence
		page  store.TaskPriorityPage
	}
	read := func(ctx context.Context) (priorityState, error) {
		var state priorityState
		err := db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
			var err error
			state.fence, err = scope.TaskDAO().TaskListFence(ctx, project.ID)
			if err != nil {
				return err
			}
			state.page, err = scope.TaskDAO().TaskPriorityList(ctx, project.ID, query)
			return err
		})
		return state, err
	}
	before, err := read(t.Context())
	if err != nil || before.fence.Count != "1" || len(before.page.Items) != 1 || before.page.Items[0].Task.ID != item.ID {
		t.Fatalf("priority read fixture: %+v, %v", before, err)
	}

	for _, fault := range []taskReaderFault{
		{name: "fence query", ddl: hideTaskProjection, restore: restoreTaskProjection, state: "42P01"},
		{name: "list query", ddl: `ALTER TABLE task_dependencies RENAME TO dependencies_source`, restore: `ALTER TABLE dependencies_source RENAME TO task_dependencies`, state: "42P01"},
		{
			name: "decode", scanColumn: 7, restore: restoreTaskProjectionView,
			ddl: `ALTER VIEW task_resource_rows RENAME TO resource_source;
 CREATE VIEW task_resource_rows AS SELECT id,project_id,type,parent_id,title,status,'bad version'::text AS version,
 created_at,allow_agents,required_platform,assigned_to,deleted_at,effective_deleted_at FROM resource_source`,
		},
		{
			name: "iteration", state: "P1003", restore: restoreTaskProjectionView + "; DROP FUNCTION fail_priority_title()",
			ddl: `CREATE FUNCTION fail_priority_title() RETURNS text LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='private list failure'; END $$;
 ALTER VIEW task_resource_rows RENAME TO resource_source;
 CREATE VIEW task_resource_rows AS SELECT id,project_id,type,parent_id,fail_priority_title() AS title,status,version,
 created_at,allow_agents,required_platform,assigned_to,deleted_at,effective_deleted_at FROM resource_source`,
		},
	} {
		if !t.Run(fault.name, func(t *testing.T) {
			fault.run(t, db, func(ctx context.Context) {
				phase := "list priority tasks"
				err := db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
					if fault.name == "fence query" {
						phase = "read task list fence"
						_, err := scope.TaskDAO().TaskListFence(ctx, project.ID)
						return err
					}
					_, err := scope.TaskDAO().TaskPriorityList(ctx, project.ID, query)
					return err
				})
				fault.requireCause(t, err, phase)
			}, func(ctx context.Context) {
				if restored := taskPriorityAssigneeRelations(t, ctx, db); restored != oids {
					t.Fatalf("priority relation OIDs = %v, want %v", restored, oids)
				}
				after, err := read(ctx)
				if err != nil || !reflect.DeepEqual(after, before) {
					t.Fatalf("recovered priority fixture = %+v, %v, want %+v", after, err, before)
				}
			})
		}) {
			return
		}
	}
}

func TestTaskAssigneeStoreQueryAndRowFailuresPreserveCauses(t *testing.T) {
	db := readerStore(t)
	project := readerProject(t, db, 1)
	readerAssigneeUser(t, db, project.ID, 101, true)
	readerAssigneeUser(t, db, project.ID, 102, true)
	oids := taskPriorityAssigneeRelations(t, t.Context(), db)
	modes := []struct {
		ids   []string
		phase string
	}{
		{phase: "list task assignees"},
		{ids: []string{readerID(101), readerID(102)}, phase: "resolve task assignees"},
	}
	var before [2][]model.TaskAssigneeFact
	for i, mode := range modes {
		rows, err := readTaskAssignees(t.Context(), db, project.ID, mode.ids)
		if err != nil || len(rows) < 2 {
			t.Fatalf("assignee fixture %s: %v, %v", mode.phase, rows, err)
		}
		before[i] = rows
	}

	const restoreUsers = `DROP VIEW users; ALTER TABLE assignee_user_source RENAME TO users`
	for _, fault := range []taskReaderFault{
		{name: "query", ddl: hideTaskProjection, restore: restoreTaskProjection, state: "42P01"},
		{
			name: "scan", scanColumn: 2, restore: restoreUsers,
			ddl: `ALTER TABLE users RENAME TO assignee_user_source;
 CREATE VIEW users AS SELECT id,uniauth_id,email,email_verified,'\x01'::bytea AS name,avatar_url,created_at,updated_at FROM assignee_user_source`,
		},
		{
			name: "iteration", state: "P1032", restore: restoreUsers + "; DROP FUNCTION refuse_assignee_profile(uuid)",
			ddl: `CREATE FUNCTION refuse_assignee_profile(id uuid) RETURNS text LANGUAGE plpgsql AS $$
 BEGIN IF id='00000000-0000-4000-8000-000000000102'::uuid THEN
 RAISE EXCEPTION USING ERRCODE='P1032', MESSAGE='private profile diagnostic';
 END IF; RETURN 'Visible'; END $$;
 ALTER TABLE users RENAME TO assignee_user_source;
 CREATE VIEW users AS SELECT id,uniauth_id,email,email_verified,refuse_assignee_profile(id) AS name,
 avatar_url,created_at,updated_at FROM assignee_user_source`,
		},
	} {
		fault.run(t, db, func(ctx context.Context) {
			for _, mode := range modes {
				rows, err := readTaskAssignees(ctx, db, project.ID, mode.ids)
				if len(rows) != 0 {
					t.Fatalf("%s failure returned partial assignees: %v", fault.name, rows)
				}
				fault.requireCause(t, err, mode.phase)
			}
		}, func(ctx context.Context) {
			if restored := taskPriorityAssigneeRelations(t, ctx, db); restored != oids {
				t.Fatalf("assignee relation OIDs = %v, want %v", restored, oids)
			}
			for i, mode := range modes {
				after, err := readTaskAssignees(ctx, db, project.ID, mode.ids)
				if err != nil || !reflect.DeepEqual(after, before[i]) {
					t.Fatalf("recovered assignee fixture %s = %v, %v, want %v", mode.phase, after, err, before[i])
				}
			}
		})
	}
}
