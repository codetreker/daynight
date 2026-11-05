package service

import (
	"bytes"
	"context"
	"errors"
	"math"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func assertDeleteResource(t *testing.T, actual, original tasksteps.StepsResource, order []string) {
	t.Helper()
	if actual.Steps == nil || len(actual.Steps) != len(order) || actual.ProjectID != original.ProjectID || actual.TaskID != original.TaskID {
		t.Fatal("delete resource scope/count/empty representation changed")
	}
	byID := make(map[string]tasksteps.Step, len(original.Steps))
	for _, step := range original.Steps {
		byID[step.ID] = step
	}
	for index, id := range order {
		if actual.Steps[index].ID != id || actual.Steps[index] != byID[id] {
			t.Fatalf("delete changed survivor identity/content/time or order at %d", index)
		}
	}
}

func TestTaskStepsDeletePreservesSurvivorsParentAndExecutionPolicies(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	editor, owner := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	dependency := finishTask(t, tasks, admin, createTask(t, tasks, admin, project.ID, "Dependency"))
	steps := NewTaskSteps(database)
	for _, policy := range []string{"todo", "in_progress", "done", "active_worker", "invalid_worker"} {
		t.Run(policy, func(t *testing.T) {
			task := createTask(t, tasks, admin, project.ID, "Parent", dependency.ID)
			task = updateTask(t, tasks, admin, task, UpdateTask{Description: pointer("Parent description"), Properties: propertyPatch(model.PullRequestProperty{URL: "opaque\x00url", Title: "Evidence"}), ExternalDependsOn: pointer([]string{dependency.ID}), RequiredPlatform: platformChange(pointer(model.PlatformLinux))})
			if policy == "active_worker" {
				task = updateTask(t, tasks, admin, task, UpdateTask{AssignedTo: pointer(pointer(owner.UserID))})
				task = updateTask(t, tasks, admin, task, UpdateTask{AllowAgents: pointer(true)})
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
			seedMoveSteps(t, database, task.ID)
			if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET updated_at='2026-01-01' WHERE id=$1`, task.ID); err != nil {
				t.Fatal(err)
			}
			parentState := func() string {
				t.Helper()
				var result string
				if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('task',to_jsonb(t)-'version'-'updated_at','properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=t.id),'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=t.id),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&result); err != nil {
					t.Fatal(err)
				}
				return result
			}
			beforeParent := parentState()
			original, err := steps.List(context.Background(), editor, project.ID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			version := task.Version
			for _, tc := range []struct {
				target string
				order  []string
			}{
				{"ABCDEF01", []string{moveStepIDs[0], moveStepIDs[1], moveStepIDs[3]}},
				{moveStepIDs[0], []string{moveStepIDs[1], moveStepIDs[3]}},
				{"FEDCBA98", []string{moveStepIDs[1]}},
				{moveStepIDs[1], []string{}},
			} {
				result, err := steps.Delete(context.Background(), editor, strings.ToUpper(project.ID), strings.ToUpper(task.ID), tc.target, DeleteTaskStep{Version: version})
				requireChangeCommitted(t, result, err, true)
				if result.Resource.Version != version+1 {
					t.Fatal("delete did not advance parent exactly once")
				}
				assertDeleteResource(t, result.Resource, original.Resource, tc.order)
				version = result.Resource.Version
				if parentState() != beforeParent {
					t.Fatal("delete changed parent business/timing/ownership fields")
				}
				current, err := steps.List(context.Background(), editor, project.ID, task.ID)
				if err != nil || !bytes.Equal(current.JSON, result.JSON) {
					t.Fatal("frozen delete result differs from persisted remaining resource")
				}
				var count int
				var parentStamp time.Time
				if err := database.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM task_steps WHERE task_id=$1 AND id=$2),updated_at FROM tasks WHERE id=$1`, task.ID, strings.ToLower(tc.target)).Scan(&count, &parentStamp); err != nil || count != 0 || parentStamp.Equal(time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)) || parentStamp.Nanosecond()%1000 != 0 {
					t.Fatalf("target removal/parent clock: count=%d stamp=%s error=%v", count, parentStamp, err)
				}
			}
		})
	}
}

func TestTaskStepsDeleteMissingStaleExhaustionAndLocalIdentity(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	other := createTask(t, tasks, principal, project.ID, "Other")
	seedMoveSteps(t, database, other.ID)
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'ffffffff',4,'other','other','todo','2026-01-01','2026-01-01')`, other.ID); err != nil {
		t.Fatal(err)
	}
	var forbidden atomic.Int64
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
		return sql == "SELECT statement_timestamp()" || strings.HasPrefix(sql, "DELETE FROM task_steps") || strings.HasPrefix(sql, "UPDATE task_steps") || strings.HasPrefix(sql, "UPDATE tasks SET version=version+1,updated_at=$3")
	}, start: func() { forbidden.Add(1) }})
	steps := NewTaskSteps(traced.store)
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, version); err != nil {
			t.Fatal(err)
		}
		before, otherBefore := stepsStoredState(t, database, task.ID, false), stepsStoredState(t, database, other.ID, false)
		_, err := steps.Delete(context.Background(), principal, project.ID, task.ID, "ffffffff", DeleteTaskStep{Version: version - 1})
		requireThreadFault(t, err, "version_conflict")
		_, err = steps.Delete(context.Background(), principal, project.ID, task.ID, "ffffffff", DeleteTaskStep{Version: version})
		requireThreadFault(t, err, "not_found")
		var absent *StepAbsence
		if !errors.As(err, &absent) || absent.Version != version {
			t.Fatal("target absence lost admitted parent version")
		}
		if version == math.MaxInt64 {
			_, err = steps.Delete(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], DeleteTaskStep{Version: version})
			requireThreadFault(t, err, "version_exhausted")
		}
		if forbidden.Load() != 0 || before != stepsStoredState(t, database, task.ID, false) || otherBefore != stepsStoredState(t, database, other.ID, false) {
			t.Fatal("refusal queried clock/wrote rows or crossed Task identity")
		}
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err := steps.Delete(context.Background(), principal, project.ID, task.ID, "ffffffff", DeleteTaskStep{Version: 1})
	requireThreadFault(t, err, "task_deleted")
}

func TestTaskStepsDeleteReleasesIdentityForANewRecord(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	other := createTask(t, tasks, principal, project.ID, "Other Task")
	seedMoveSteps(t, database, other.ID)
	otherBefore := stepsStoredState(t, database, other.ID, false)
	steps := NewTaskSteps(database)
	original, err := steps.List(context.Background(), principal, project.ID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := steps.Delete(context.Background(), principal, project.ID, task.ID, "ABCDEF01", DeleteTaskStep{Version: 1})
	requireChangeCommitted(t, result, err, true)
	_, err = steps.Get(context.Background(), principal, project.ID, task.ID, "abcdef01")
	requireThreadFault(t, err, "not_found")
	_, err = steps.Delete(context.Background(), principal, project.ID, task.ID, "abcdef01", DeleteTaskStep{Version: 2})
	requireThreadFault(t, err, "not_found")
	_, err = steps.Delete(context.Background(), principal, project.ID, task.ID, "abcdef01", DeleteTaskStep{Version: 1})
	requireThreadFault(t, err, "version_conflict")
	recreated, err := steps.Add(context.Background(), principal, project.ID, task.ID, AddTaskStep{Version: 2, ID: "ABCDEF01", Title: "New record"})
	requireChangeCommitted(t, recreated, err, true)
	if recreated.Resource.Version != 3 || len(recreated.Resource.Steps) != 4 {
		t.Fatal("reused ID did not create an independent current record")
	}
	fresh := recreated.Resource.Steps[3]
	if fresh.ID != "abcdef01" || fresh.Title != "New record" || fresh.Description != "" || fresh.Status != model.TaskStepTodo || fresh.CreatedAt != fresh.UpdatedAt || fresh.CreatedAt == original.Resource.Steps[2].CreatedAt || fresh.UpdatedAt == original.Resource.Steps[2].UpdatedAt {
		t.Fatal("reused ID restored old content/status/times")
	}
	for index, source := range []int{0, 1, 3} {
		if recreated.Resource.Steps[index] != original.Resource.Steps[source] {
			t.Fatal("recreation changed a retained record")
		}
	}
	if otherBefore != stepsStoredState(t, database, other.ID, false) {
		t.Fatal("delete/reuse crossed Task-local identity")
	}
}

func TestTaskStepsDeleteAdmissionAndStorageFailuresStayExplicit(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	steps := NewTaskSteps(database)
	for _, tc := range []struct {
		principal                   model.Principal
		project, task, target, code string
		version                     int64
	}{
		{model.Principal{}, project.ID, task.ID, moveStepIDs[0], "unauthenticated", 1}, {principal, "bad", task.ID, moveStepIDs[0], "invalid_input", 1}, {principal, project.ID, "bad", moveStepIDs[0], "invalid_input", 1}, {principal, project.ID, task.ID, "bad", "invalid_input", 1}, {principal, project.ID, task.ID, moveStepIDs[0], "invalid_input", 0},
		{principal, uuid.NewString(), task.ID, moveStepIDs[0], "not_found", 1}, {principal, project.ID, uuid.NewString(), moveStepIDs[0], "not_found", 1}, {servicePrincipal(t, database), project.ID, task.ID, moveStepIDs[0], "not_found", 1},
	} {
		_, err := steps.Delete(context.Background(), tc.principal, tc.project, tc.task, tc.target, DeleteTaskStep{Version: tc.version})
		requireThreadFault(t, err, tc.code)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET position=9 WHERE task_id=$1 AND id='abcdef01'`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err := steps.Delete(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], DeleteTaskStep{Version: 1})
	if err == nil {
		t.Fatal("corrupt collection became successful delete")
	}
	if _, pure := TaskStepsFault(err); pure {
		t.Fatal("corrupt collection became business refusal")
	}
	database.Close()
	if _, err := steps.Delete(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], DeleteTaskStep{Version: 1}); err == nil {
		t.Fatal("closed database succeeded")
	}
}

func TestTaskStepsDeleteQueryFailuresRemainInternal(t *testing.T) {
	for _, query := range []string{`DROP TABLE task_steps`, `ALTER TABLE tasks RENAME COLUMN version TO invalid_version`} {
		t.Run(query, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedMoveSteps(t, database, task.ID)
			if _, err := database.Pool.Exec(context.Background(), query); err != nil {
				t.Fatal(err)
			}
			result, err := NewTaskSteps(database).Delete(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], DeleteTaskStep{Version: 1})
			if err == nil || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("query failure concealed")
			}
			if _, pure := TaskStepsFault(err); pure {
				t.Fatal("query failure became business refusal")
			}
		})
	}
}

func TestTaskStepsDeleteConfirmedRollbackAfterEachWrite(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	before := stepsStoredState(t, database, task.ID, false)
	for _, fragment := range []string{"DELETE FROM task_steps", "UPDATE task_steps SET position=position-1", "UPDATE tasks SET version=version+1,updated_at=$3"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			observed := false
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.HasPrefix(sql, fragment) }, end: func() { observed = true; cancel() }})
			result, err := NewTaskSteps(traced.store).Delete(ctx, principal, project.ID, task.ID, moveStepIDs[0], DeleteTaskStep{Version: 1})
			var failure *store.TransactionError
			if !observed || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted || result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil {
				t.Fatalf("delete cancellation completion: %+v %v", failure, err)
			}
			if before != stepsStoredState(t, database, task.ID, false) {
				t.Fatal("deleted target/tail/parent change survived confirmed rollback")
			}
		})
	}
}

func TestTaskStepsDeletePartialTailAndSuppressedWritesRollBack(t *testing.T) {
	for _, mode := range []string{"partial_tail", "parent_touch", "suppressed_delete", "suppressed_tail"} {
		t.Run(mode, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedMoveSteps(t, database, task.ID)
			switch mode {
			case "partial_tail":
				if _, err := database.Pool.Exec(context.Background(), `CREATE SEQUENCE delete_tail_attempts; CREATE FUNCTION fail_delete_tail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('delete_tail_attempts')=2 THEN RAISE EXCEPTION 'partial-tail-sentinel' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_delete_tail AFTER UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION fail_delete_tail()`); err != nil {
					t.Fatal(err)
				}
			case "parent_touch":
				if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION refuse_delete_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delete-touch-sentinel' USING ERRCODE='P0001'; END $$; CREATE TRIGGER refuse_delete_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_delete_touch()`); err != nil {
					t.Fatal(err)
				}
			case "suppressed_delete":
				if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION suppress_delete_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_delete_target BEFORE DELETE ON task_steps FOR EACH ROW EXECUTE FUNCTION suppress_delete_target()`); err != nil {
					t.Fatal(err)
				}
			default:
				if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION suppress_delete_tail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='11111111' THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER suppress_delete_tail BEFORE UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION suppress_delete_tail()`); err != nil {
					t.Fatal(err)
				}
			}
			before := stepsStoredState(t, database, task.ID, false)
			result, err := NewTaskSteps(database).Delete(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], DeleteTaskStep{Version: 1})
			var failure *store.TransactionError
			if !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted || result.JSON != nil {
				t.Fatalf("delete SQL completion: %+v %v", failure, err)
			}
			if strings.HasPrefix(mode, "suppressed") {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("suppressed persistence count mismatch cause lost")
				}
			} else {
				var driver *pgconn.PgError
				if !errors.As(err, &driver) || driver.Code != "P0001" {
					t.Fatal("original trigger SQLSTATE lost")
				}
			}
			if _, pure := TaskStepsFault(err); pure {
				t.Fatal("delete persistence fault became child visibility refusal")
			}
			if before != stepsStoredState(t, database, task.ID, false) {
				t.Fatal("partial target/tail/parent changes survived rollback")
			}
			if mode == "partial_tail" {
				var count int64
				if err := database.Pool.QueryRow(context.Background(), `SELECT last_value FROM delete_tail_attempts`).Scan(&count); err != nil || count != 2 {
					t.Fatalf("partial tail was not reached: %d %v", count, err)
				}
			}
		})
	}
}

func TestTaskStepsDeleteSameVersionCompetition(t *testing.T) {
	for _, kind := range []string{"same_target", "different_target", "add", "task"} {
		t.Run(kind, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedMoveSteps(t, database, task.ID)
			steps := NewTaskSteps(database)
			remove := func(ctx context.Context) (model.Task, error) {
				result, err := steps.Delete(ctx, principal, project.ID, task.ID, moveStepIDs[0], DeleteTaskStep{Version: 1})
				return model.Task{Version: result.Resource.Version}, err
			}
			other := remove
			if kind == "different_target" {
				other = func(ctx context.Context) (model.Task, error) {
					result, err := steps.Delete(ctx, principal, project.ID, task.ID, moveStepIDs[3], DeleteTaskStep{Version: 1})
					return model.Task{Version: result.Resource.Version}, err
				}
			}
			if kind == "add" {
				other = func(ctx context.Context) (model.Task, error) {
					result, err := steps.Add(ctx, principal, project.ID, task.ID, AddTaskStep{Version: 1, ID: "12345678", Title: "Added"})
					return model.Task{Version: result.Resource.Version}, err
				}
			}
			if kind == "task" {
				other = func(ctx context.Context) (model.Task, error) {
					return tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: 1, Title: pointer("Parent changed")})
				}
			}
			results := competeTaskWrites(t, database, project.ID, remove, other)
			success, refused := 0, 0
			for _, result := range results {
				if result.err == nil {
					success++
				} else {
					requireThreadFault(t, result.err, "version_conflict")
					refused++
				}
			}
			if success != 1 || refused != 1 {
				t.Fatalf("delete competition completion: %+v", results)
			}
			current, err := steps.List(context.Background(), principal, project.ID, task.ID)
			if err != nil || current.Resource.Version != 2 {
				t.Fatal("delete competition did not advance parent once")
			}
			if kind == "same_target" || kind == "different_target" {
				if len(current.Resource.Steps) != 3 {
					t.Fatal("both deletes or neither took effect")
				}
			} else {
				deleted := len(current.Resource.Steps) == 3 && current.Resource.Steps[0].ID == moveStepIDs[1]
				if kind == "add" {
					added := len(current.Resource.Steps) == 5 && current.Resource.Steps[4].ID == "12345678"
					if deleted == added {
						t.Fatal("both delete/add effects or neither survived")
					}
				} else {
					var title string
					if err := database.Pool.QueryRow(context.Background(), `SELECT title FROM tasks WHERE id=$1`, task.ID).Scan(&title); err != nil {
						t.Fatal(err)
					}
					if deleted == (title == "Parent changed") {
						t.Fatal("both delete/metadata effects or neither survived")
					}
				}
			}
		})
	}
}
