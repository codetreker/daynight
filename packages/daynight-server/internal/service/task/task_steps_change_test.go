package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"

	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync/atomic"
	"testing"

	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func seedChangeSteps(t *testing.T, database *store.Store, taskID string) {
	t.Helper()
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES
 ($1,'00000000',0,'same','original body','todo','2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z'),
 ($1,'abcdef01',1,'same','other body','in_progress','2026-01-03T03:04:05.123456Z','2026-02-04T04:05:06.654321Z')`, taskID); err != nil {
		t.Fatal(err)
	}
}

func requireChangeCommitted(t *testing.T, result taskservice.StepsWriteResult, err error, changed bool) {
	t.Helper()
	if err != nil || result.Changed != changed || result.TransactionOutcome != store.TransactionCommitted || result.Phase != "commit" || result.CleanupFailed || len(result.JSON) == 0 {
		t.Fatalf("change receipt: %+v %v", result, err)
	}
}

func TestTaskStepsChangeNoOpPreservesAllBytesBeforeClockAndWrites(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, version); err != nil {
				t.Fatal(err)
			}
			before := stepsStoredState(t, database, task.ID, false)
			document, err := taskservice.NewTaskSteps(database).List(context.Background(), principal, project.ID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			var forbidden atomic.Int64
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
				return sql == "SELECT statement_timestamp()" || strings.HasPrefix(sql, "UPDATE task_steps") || strings.HasPrefix(sql, "UPDATE tasks SET version=version+1,updated_at=$3")
			}, start: func() { forbidden.Add(1) }})
			steps := taskservice.NewTaskSteps(traced.store)
			for _, operation := range []func() (taskservice.StepsWriteResult, error){
				func() (taskservice.StepsWriteResult, error) {
					return steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: version, Title: pointer("same")})
				},
				func() (taskservice.StepsWriteResult, error) {
					return steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: version, Description: pointer("original body")})
				},
				func() (taskservice.StepsWriteResult, error) {
					return steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: version, Title: pointer("same"), Description: pointer("original body")})
				},
				func() (taskservice.StepsWriteResult, error) {
					return steps.SetStatus(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: version, Status: model.TaskStepTodo})
				},
			} {
				result, err := operation()
				requireChangeCommitted(t, result, err, false)
				if !bytes.Equal(result.JSON, document.JSON) || before != stepsStoredState(t, database, task.ID, false) || forbidden.Load() != 0 {
					t.Fatal("no-op changed full resource/state or sampled the clock/wrote rows")
				}
			}
			_, err = steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: version - 1, Title: pointer("same")})
			requireThreadFault(t, err, "version_conflict")
			_, err = steps.SetStatus(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: version - 1, Status: model.TaskStepTodo})
			requireThreadFault(t, err, "version_conflict")
			if version == math.MaxInt64 {
				_, err = steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: version, Title: pointer("changed")})
				requireThreadFault(t, err, "version_exhausted")
				_, err = steps.SetStatus(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: version, Status: model.TaskStepDone})
				requireThreadFault(t, err, "version_exhausted")
				_, err = steps.Update(context.Background(), principal, project.ID, task.ID, "ffffffff", taskservice.UpdateTaskStep{Version: version, Title: pointer("changed")})
				requireThreadFault(t, err, "not_found")
			}
			if before != stepsStoredState(t, database, task.ID, false) || forbidden.Load() != 0 {
				t.Fatal("refusal changed data or passed exhaustion/identity to clock/write")
			}
		})
	}
}

func TestTaskStepsChangePreservesOtherRowsParentAndExecutionPolicies(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	editor, owner := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	dependency := finishTask(t, tasks, admin, createTask(t, tasks, admin, project.ID, "Dependency"))
	steps := taskservice.NewTaskSteps(database)
	for _, policy := range []string{"todo", "in_progress", "done", "active_worker", "invalid_worker"} {
		t.Run(policy, func(t *testing.T) {
			task := createTask(t, tasks, admin, project.ID, "Parent", dependency.ID)
			task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{Description: pointer("Parent description"), Properties: propertyPatch(model.PullRequestProperty{URL: "opaque\x00url", Title: "Evidence"}), ExternalDependsOn: pointer([]string{dependency.ID}), RequiredPlatform: platformChange(pointer(model.PlatformLinux))})
			if policy == "active_worker" {
				task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{AssignedTo: pointer(pointer(owner.UserID))})
				task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{AllowAgents: pointer(true)})
				descriptor := workerDescriptor()
				task = claimWorkerTask(t, tasks, owner, task, descriptor)
				if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,grant_kind) VALUES($1,$2,$3,$4,$5,$6,'{}','{}','secret','2099-01-01','connect')`, uuid.NewString(), project.ID, task.ID, descriptor.ClaimID, owner.UserID, uuid.NewString()); err != nil {
					t.Fatal(err)
				}
			} else if policy == "in_progress" || policy == "done" {
				if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET status=$2,started_at='2026-01-01',completed_at=CASE WHEN $2='done' THEN '2026-01-02'::timestamptz ELSE NULL END WHERE id=$1`, task.ID, policy); err != nil {
					t.Fatal(err)
				}
			} else if policy == "invalid_worker" {
				if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','invalid JSON')`, task.ID); err != nil {
					t.Fatal(err)
				}
			}
			seedChangeSteps(t, database, task.ID)
			parentSnapshot := func() string {
				t.Helper()
				var result string
				if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('task',to_jsonb(t)-'version'-'updated_at','properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=t.id),'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=t.id),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&result); err != nil {
					t.Fatal(err)
				}
				return result
			}
			beforeParent := parentSnapshot()
			initial, err := steps.List(context.Background(), editor, project.ID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			title, description := "  <原值&> 😀 \uFEFF  ", "  # Markdown\n\"\\\u2028\u2029  "
			result, err := steps.Update(context.Background(), editor, strings.ToUpper(project.ID), strings.ToUpper(task.ID), "00000000", taskservice.UpdateTaskStep{Version: task.Version, Title: &title, Description: &description})
			requireChangeCommitted(t, result, err, true)
			target := result.Resource.Steps[0]
			if target.Title != title || target.Description != description || target.CreatedAt != initial.Resource.Steps[0].CreatedAt || target.UpdatedAt == initial.Resource.Steps[0].UpdatedAt || result.Resource.Steps[1] != initial.Resource.Steps[1] || result.Resource.Version != task.Version+1 {
				t.Fatal("paired change changed unrelated fields/time")
			}
			var sameClock bool
			if err := database.Pool.QueryRow(context.Background(), `SELECT t.updated_at=s.updated_at FROM tasks t JOIN task_steps s ON s.task_id=t.id AND s.id='00000000' WHERE t.id=$1`, task.ID).Scan(&sameClock); err != nil || !sameClock {
				t.Fatal("target and parent do not share actual database clock", err)
			}
			version := result.Resource.Version
			for _, status := range []model.TaskStepStatus{model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped, model.TaskStepTodo} {
				result, err = steps.SetStatus(context.Background(), editor, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: version, Status: status})
				requireChangeCommitted(t, result, err, true)
				if result.Resource.Version != version+1 || result.Resource.Steps[0].Status != status || result.Resource.Steps[0].Title != title || result.Resource.Steps[0].Description != description || result.Resource.Steps[0].CreatedAt != target.CreatedAt || result.Resource.Steps[1] != initial.Resource.Steps[1] {
					t.Fatal("status change changed identity/content/other row")
				}
				version = result.Resource.Version
			}
			result, err = steps.Update(context.Background(), editor, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: version, Description: pointer("")})
			requireChangeCommitted(t, result, err, true)
			if result.Resource.Steps[0].Description != "" || result.Resource.Steps[0].Title != title || parentSnapshot() != beforeParent {
				t.Fatal("clear altered omitted title or parent/execution state")
			}
		})
	}
}

func TestTaskStepsChangeAdmissionInputAndStorageFailures(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	steps := taskservice.NewTaskSteps(database)
	other := createTask(t, tasks, principal, project.ID, "Other parent")
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'ffffffff',0,'other','other','todo','2026-01-01','2026-01-01')`, other.ID); err != nil {
		t.Fatal(err)
	}
	for _, input := range []taskservice.UpdateTaskStep{{Version: 1}, {Version: 1, Title: pointer("\u0085")}, {Version: 1, Title: pointer("\x00")}, {Version: 1, Title: pointer(string([]byte{0xff}))}, {Version: 1, Description: pointer("\x00")}, {Version: 1, Description: pointer(string([]byte{0xff}))}} {
		_, err := steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", input)
		requireThreadFault(t, err, "invalid_input")
	}
	_, err := steps.SetStatus(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: 1, Status: "invalid"})
	requireThreadFault(t, err, "invalid_input")
	for _, tc := range []struct {
		principal                 model.Principal
		project, task, step, code string
		version                   int64
	}{
		{model.Principal{}, project.ID, task.ID, "00000000", "unauthenticated", 1}, {principal, "bad", task.ID, "00000000", "invalid_input", 1}, {principal, project.ID, "bad", "00000000", "invalid_input", 1}, {principal, project.ID, task.ID, "bad", "invalid_input", 1}, {principal, project.ID, task.ID, "00000000", "invalid_input", 0},
		{principal, uuid.NewString(), task.ID, "00000000", "not_found", 1}, {principal, project.ID, uuid.NewString(), "00000000", "not_found", 1}, {servicePrincipal(t, database), project.ID, task.ID, "00000000", "not_found", 1}, {principal, project.ID, task.ID, "ffffffff", "not_found", 1},
	} {
		_, err := steps.Update(context.Background(), tc.principal, tc.project, tc.task, tc.step, taskservice.UpdateTaskStep{Version: tc.version, Title: pointer("changed")})
		requireThreadFault(t, err, tc.code)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err = steps.Update(context.Background(), principal, project.ID, task.ID, "ffffffff", taskservice.UpdateTaskStep{Version: 99, Title: pointer("changed")})
	requireThreadFault(t, err, "task_deleted")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=NULL WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET position=3 WHERE task_id=$1 AND id='abcdef01'`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err = steps.SetStatus(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: 1, Status: model.TaskStepDone})
	if err == nil {
		t.Fatal("corrupt storage concealed")
	}
	if _, pure := taskservice.TaskStepsFault(err); pure {
		t.Fatal("corrupt storage became business refusal")
	}
	database.Close()
	_, err = steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("changed")})
	if err == nil {
		t.Fatal("closed database succeeded")
	}
}

func TestTaskStepsChangeQueryFailuresRemainInternal(t *testing.T) {
	for _, query := range []string{`DROP TABLE task_steps`, `ALTER TABLE tasks RENAME COLUMN version TO invalid_version`} {
		t.Run(query, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedChangeSteps(t, database, task.ID)
			if _, err := database.Pool.Exec(context.Background(), query); err != nil {
				t.Fatal(err)
			}
			result, err := taskservice.NewTaskSteps(database).Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("changed")})
			if err == nil || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("query failure concealed")
			}
			if _, pure := taskservice.TaskStepsFault(err); pure {
				t.Fatal("query failure became business refusal")
			}
		})
	}
}

func TestTaskStepsChangeConfirmedRollbackAfterTargetAndParentWrites(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	before := stepsStoredState(t, database, task.ID, false)
	for _, status := range []bool{false, true} {
		for _, fragment := range []string{"UPDATE task_steps SET title=", "UPDATE tasks SET version=version+1,updated_at=$3"} {
			t.Run(fmt.Sprintf("status=%t/%s", status, fragment), func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				observed := false
				traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.HasPrefix(sql, fragment) }, end: func() { observed = true; cancel() }})
				steps := taskservice.NewTaskSteps(traced.store)
				var result taskservice.StepsWriteResult
				var err error
				if status {
					result, err = steps.SetStatus(ctx, principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: 1, Status: model.TaskStepDone})
				} else {
					result, err = steps.Update(ctx, principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("new title"), Description: pointer("new description")})
				}
				var failure *store.TransactionError
				if !observed || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted || result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil {
					t.Fatalf("rollback: observed=%t result=%+v tx=%+v err=%v", observed, result, failure, err)
				}
				if before != stepsStoredState(t, database, task.ID, false) {
					t.Fatal("partial target/parent change survived confirmed rollback")
				}
			})
		}
	}
}

func TestTaskStepsChangeTouchSQLFailureRollsBackPairedFields(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION refuse_step_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'touch-failure-sentinel' USING ERRCODE='P0001'; END $$; CREATE TRIGGER refuse_step_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_step_touch()`); err != nil {
		t.Fatal(err)
	}
	before := stepsStoredState(t, database, task.ID, false)
	result, err := taskservice.NewTaskSteps(database).Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("new title"), Description: pointer("new description")})
	var driver *pgconn.PgError
	var failure *store.TransactionError
	if !errors.As(err, &driver) || driver.Code != "P0001" || !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted || result.JSON != nil {
		t.Fatalf("touch failure cause/completion lost: %v", err)
	}
	if _, pure := taskservice.TaskStepsFault(err); pure {
		t.Fatal("touch failure became business refusal")
	}
	if before != stepsStoredState(t, database, task.ID, false) {
		t.Fatal("paired fields partly survived failed parent touch")
	}
}

func TestTaskStepsChangeSameVersionSerializesWithOtherWrites(t *testing.T) {
	for _, kind := range []string{"status", "add", "task"} {
		t.Run(kind, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedChangeSteps(t, database, task.ID)
			steps := taskservice.NewTaskSteps(database)
			update := func(ctx context.Context) (model.Task, error) {
				result, err := steps.Update(ctx, principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("changed")})
				return model.Task{Version: result.Resource.Version}, err
			}
			other := func(ctx context.Context) (model.Task, error) {
				result, err := steps.SetStatus(ctx, principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: 1, Status: model.TaskStepDone})
				return model.Task{Version: result.Resource.Version}, err
			}
			if kind == "add" {
				other = func(ctx context.Context) (model.Task, error) {
					result, err := steps.Add(ctx, principal, project.ID, task.ID, taskservice.AddTaskStep{Version: 1, ID: "12345678", Title: "added"})
					return model.Task{Version: result.Resource.Version}, err
				}
			}
			if kind == "task" {
				other = func(ctx context.Context) (model.Task, error) {
					return tasks.Update(ctx, principal, project.ID, task.ID, taskcore.UpdateTask{Version: 1, Title: pointer("Parent changed")})
				}
			}
			results := competeTaskWrites(t, database, project.ID, update, other)
			successes, refused := 0, 0
			for _, result := range results {
				if result.err == nil {
					successes++
				} else {
					requireThreadFault(t, result.err, "version_conflict")
					refused++
				}
			}
			if successes != 1 || refused != 1 {
				t.Fatalf("concurrency winners: %+v", results)
			}
			var version int64
			if err := database.Pool.QueryRow(context.Background(), `SELECT version FROM tasks WHERE id=$1`, task.ID).Scan(&version); err != nil || version != 2 {
				t.Fatal("competition did not make exactly one change", err)
			}
		})
	}
}

func TestTaskStepsChangeNoOpAndRealChangeOrdering(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	steps := taskservice.NewTaskSteps(database)
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			result, err := steps.Update(ctx, principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("same")})
			return model.Task{Version: result.Resource.Version}, err
		},
		func(ctx context.Context) (model.Task, error) {
			result, err := steps.SetStatus(ctx, principal, project.ID, task.ID, "00000000", taskservice.SetTaskStepStatus{Version: 1, Status: model.TaskStepDone})
			return model.Task{Version: result.Resource.Version}, err
		})
	success := 0
	for _, result := range results {
		if result.err == nil {
			success++
		} else {
			requireThreadFault(t, result.err, "version_conflict")
		}
	}
	if success < 1 || success > 2 {
		t.Fatal("invalid no-op/change outcome")
	}
	current, err := steps.List(context.Background(), principal, project.ID, task.ID)
	if err != nil || current.Resource.Version != 2 || current.Resource.Steps[0].Title != "same" || current.Resource.Steps[0].Status != model.TaskStepDone {
		t.Fatal("no-op advanced version or replaced real state")
	}
}

func TestTaskStepsChangeUnexpectedTargetDisappearanceStaysInternal(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION suppress_step_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_step_update BEFORE UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION suppress_step_update()`); err != nil {
		t.Fatal(err)
	}
	before := stepsStoredState(t, database, task.ID, false)
	result, err := taskservice.NewTaskSteps(database).Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("changed")})
	if !errors.Is(err, model.ErrNotFound) || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
		t.Fatalf("unexpected target update result lost: %+v %v", result, err)
	}
	if _, pure := taskservice.TaskStepsFault(err); pure {
		t.Fatal("unexpected zero-row persistence became a child visibility refusal")
	}
	if before != stepsStoredState(t, database, task.ID, false) {
		t.Fatal("zero-row persistence advanced parent or changed collection")
	}
}
