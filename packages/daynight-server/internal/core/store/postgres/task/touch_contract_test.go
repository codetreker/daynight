package task_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestTouchTaskPreservesParentAcrossExecutionPolicies(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "TouchTaskPreservesParentAcrossExecutionPolicies", testTouchTaskPreservesParentAcrossExecutionPolicies)
}

func testTouchTaskPreservesParentAcrossExecutionPolicies(t *testing.T, database *postgres.Store) {
	project := writerProject(t, database, 1)
	dependency := writerTask(t, database, project.ID, 10, model.TaskDone)
	for index, policy := range []string{"todo", "in_progress", "done", "active_worker", "invalid_worker"} {
		t.Run(policy, func(t *testing.T) {
			task := writerTask(t, database, project.ID, 20+index, model.TaskTodo, dependency.ID)
			testutil.MustExec(t, database.Pool, `UPDATE tasks SET required_platform='linux',assigned_to=$2,allow_agents=true WHERE id=$1`, task.ID, testutil.QueryID(500))
			testutil.MustExec(t, database.Pool, `UPDATE task_dependencies SET external=true WHERE task_id=$1`, task.ID)
			testutil.MustExec(t, database.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, task.ID, `[{"url":"opaque\u0000url","title":"Evidence"}]`)
			if policy == "active_worker" {
				testutil.MustExec(t, database.Pool, `UPDATE tasks SET status='in_progress',started_at='2026-01-01' WHERE id=$1`, task.ID)
				testutil.MustExec(t, database.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task.ID, fmt.Sprintf(`{"claimId":%q,"state":"active","userId":%q,"workerId":%q,"machine":{"id":%q,"name":"Build machine"},"platform":"linux","agent":"codex","agentControlMode":"herdr","worktreeId":%q,"phase":"preparing","claimedAt":"2026-01-01T00:00:00Z"}`, testutil.QueryID(501+index), testutil.QueryID(500), testutil.QueryID(510), testutil.QueryID(511), testutil.QueryID(512)))
				testutil.MustExec(t, database.Pool, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,grant_kind) VALUES($1,$2,$3,$4,$5,$6,'{}','{}','secret','2099-01-01','connect')`, testutil.QueryID(520+index), project.ID, task.ID, testutil.QueryID(501+index), testutil.QueryID(500), testutil.QueryID(530+index))
			} else if policy == "invalid_worker" {
				testutil.MustExec(t, database.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{"claimId":1}')`, task.ID)
			} else if policy != "todo" {
				testutil.MustExec(t, database.Pool, `UPDATE tasks SET status=$2,started_at='2026-01-01',completed_at=CASE WHEN $2='done' THEN '2026-01-02'::timestamptz ELSE NULL END WHERE id=$1`, task.ID, policy)
			}
			state := func() string {
				var value string
				err := database.Pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
 'task',(SELECT to_jsonb(t)-'version'-'updated_at' FROM tasks t WHERE id=$1),
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=$1),
 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=$1),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=$1))::text`, task.ID).Scan(&value)
				if err != nil {
					t.Fatal(err)
				}
				return value
			}
			before := state()
			var header model.TaskHeader
			var timestamp string
			if err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
				var err error
				header, err = dao.TaskHeader(t.Context(), task.ID)
				if err != nil {
					return err
				}
				observed, err := dao.ObservedAt(t.Context())
				if err != nil {
					return err
				}
				timestamp = observed.Format("2006-01-02T15:04:05.000000Z07:00")
				return dao.TouchTask(t.Context(), task.ID, observed)
			}); err != nil {
				t.Fatal(err)
			}
			var version int64
			var updated string
			if err := database.Pool.QueryRow(t.Context(), `SELECT version,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM tasks WHERE id=$1`, task.ID).Scan(&version, &updated); err != nil {
				t.Fatal(err)
			}
			if version != header.Version+1 || updated != timestamp || state() != before {
				t.Fatalf("touch changed unrelated facts or lost revision/clock: version=%d updated=%s expected=%s", version, updated, timestamp)
			}
		})
	}
}

func TestTaskHeaderStorageErrorsPropagate(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 10, model.TaskTodo)
	testutil.MustExec(t, database.Pool, `DROP VIEW task_resource_rows`)
	if err := writerRead(t, database, func(dao store.TaskReader) error {
		_, err := dao.TaskHeader(ctx, project.ID, task.ID)
		return err
	}); err == nil {
		t.Fatal("parent query failure concealed")
	}
}
