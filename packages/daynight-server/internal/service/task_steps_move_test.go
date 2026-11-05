package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

var moveStepIDs = []string{"00000000", "11111111", "abcdef01", "fedcba98"}

func seedMoveSteps(t *testing.T, database *store.Store, taskID string) {
	t.Helper()
	for index, id := range moveStepIDs {
		if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,'same',$4,$5,'2026-01-02T03:04:05.123456Z'::timestamptz+$3::bigint*interval '1 day','2026-02-03T04:05:06.654321Z'::timestamptz+$3::bigint*interval '1 day')`, taskID, id, index, "  # "+id+"\n<原值&>  ", []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index]); err != nil {
			t.Fatal(err)
		}
	}
}

func assertMoveResource(t *testing.T, actual, original tasksteps.StepsResource, order []string) {
	t.Helper()
	if len(actual.Steps) != len(order) || actual.ProjectID != original.ProjectID || actual.TaskID != original.TaskID {
		t.Fatal("move resource scope/count changed")
	}
	byID := make(map[string]tasksteps.Step, len(original.Steps))
	for _, step := range original.Steps {
		byID[step.ID] = step
	}
	for index, id := range order {
		if actual.Steps[index].ID != id || actual.Steps[index] != byID[id] {
			t.Fatalf("move changed a non-position field or wrong order at %d: %+v", index, actual.Steps[index])
		}
	}
}

func TestTaskStepsMovePreservesAllStepTimesAndParentPolicies(t *testing.T) {
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
				input  MoveTaskStep
				order  []string
			}{
				{moveStepIDs[0], MoveTaskStep{After: pointer("ABCDEF01")}, []string{moveStepIDs[1], moveStepIDs[2], moveStepIDs[0], moveStepIDs[3]}},
				{"FEDCBA98", MoveTaskStep{Before: pointer("ABCDEF01")}, []string{moveStepIDs[1], moveStepIDs[3], moveStepIDs[2], moveStepIDs[0]}},
				{"ABCDEF01", MoveTaskStep{Position: pointer("first")}, []string{moveStepIDs[2], moveStepIDs[1], moveStepIDs[3], moveStepIDs[0]}},
				{"ABCDEF01", MoveTaskStep{Position: pointer("last")}, []string{moveStepIDs[1], moveStepIDs[3], moveStepIDs[0], moveStepIDs[2]}},
			} {
				tc.input.Version = version
				result, err := steps.Move(context.Background(), editor, strings.ToUpper(project.ID), strings.ToUpper(task.ID), tc.target, tc.input)
				requireChangeCommitted(t, result, err, true)
				if result.Resource.Version != version+1 {
					t.Fatal("move did not advance parent exactly once")
				}
				assertMoveResource(t, result.Resource, original.Resource, tc.order)
				version = result.Resource.Version
				if parentState() != beforeParent {
					t.Fatal("move changed parent business/timing/ownership fields")
				}
				current, err := steps.List(context.Background(), editor, project.ID, task.ID)
				if err != nil || !bytes.Equal(current.JSON, result.JSON) {
					t.Fatal("frozen move response differs from current persisted resource")
				}
			}
		})
	}
}

func TestTaskStepsMoveNoOpBeforeExhaustionClockAndSQL(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, version); err != nil {
				t.Fatal(err)
			}
			before := stepsStoredState(t, database, task.ID, false)
			original, err := NewTaskSteps(database).List(context.Background(), principal, project.ID, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			var forbidden atomic.Int64
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
				return sql == "SELECT statement_timestamp()" || strings.HasPrefix(sql, "UPDATE task_steps") || strings.HasPrefix(sql, "UPDATE tasks SET version=version+1,updated_at=$3")
			}, start: func() { forbidden.Add(1) }})
			steps := NewTaskSteps(traced.store)
			for _, tc := range []struct {
				target string
				input  MoveTaskStep
			}{
				{moveStepIDs[0], MoveTaskStep{Position: pointer("first")}},
				{moveStepIDs[3], MoveTaskStep{Position: pointer("last")}},
				{moveStepIDs[1], MoveTaskStep{Before: pointer("ABCDEF01")}},
				{"ABCDEF01", MoveTaskStep{After: &moveStepIDs[1]}},
			} {
				tc.input.Version = version
				result, err := steps.Move(context.Background(), principal, project.ID, task.ID, tc.target, tc.input)
				requireChangeCommitted(t, result, err, false)
				if !bytes.Equal(result.JSON, original.JSON) || before != stepsStoredState(t, database, task.ID, false) || forbidden.Load() != 0 {
					t.Fatal("no-op changed full bytes/state or sampled clock/wrote rows")
				}
				tc.input.Version = version - 1
				_, err = steps.Move(context.Background(), principal, project.ID, task.ID, tc.target, tc.input)
				requireThreadFault(t, err, "version_conflict")
			}
			if version == math.MaxInt64 {
				_, err = steps.Move(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: version, Position: pointer("last")})
				requireThreadFault(t, err, "version_exhausted")
				_, err = steps.Move(context.Background(), principal, project.ID, task.ID, "ffffffff", MoveTaskStep{Version: version, Before: pointer("eeeeeeee")})
				requireThreadFault(t, err, "not_found")
				_, err = steps.Move(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: version, Before: pointer("ffffffff")})
				requireThreadFault(t, err, "not_found")
			}
			if forbidden.Load() != 0 || before != stepsStoredState(t, database, task.ID, false) {
				t.Fatal("refusal passed identity/exhaustion to clock or SQL")
			}
		})
	}
	singleton := createTask(t, tasks, principal, project.ID, "Singleton")
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps SELECT $1,id,0,title,description,status,created_at,updated_at FROM task_steps WHERE task_id=$2 AND id='00000000'`, singleton.ID, task.ID); err != nil {
		t.Fatal(err)
	}
	before := stepsStoredState(t, database, singleton.ID, false)
	for _, position := range []string{"first", "last"} {
		result, err := NewTaskSteps(database).Move(context.Background(), principal, project.ID, singleton.ID, "00000000", MoveTaskStep{Version: 1, Position: &position})
		requireChangeCommitted(t, result, err, false)
		if before != stepsStoredState(t, database, singleton.ID, false) {
			t.Fatal("singleton no-op changed storage")
		}
	}
}

func TestTaskStepsMoveAdmissionPlacementAndTaskLocalErrors(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	steps := NewTaskSteps(database)
	other := createTask(t, tasks, principal, project.ID, "Other")
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'ffffffff',0,'other','other','todo','2026-01-01','2026-01-01')`, other.ID); err != nil {
		t.Fatal(err)
	}
	for _, input := range []MoveTaskStep{{Version: 1}, {Version: 1, Before: pointer("bad")}, {Version: 1, After: pointer("bad")}, {Version: 1, Position: pointer("")}, {Version: 1, Position: pointer("FIRST")}, {Version: 1, Position: pointer("middle")}, {Version: 1, Before: &moveStepIDs[1], After: &moveStepIDs[2]}, {Version: 1, Before: &moveStepIDs[1], Position: pointer("first")}, {Version: 1, After: &moveStepIDs[1], Position: pointer("last")}} {
		_, err := steps.Move(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], input)
		requireThreadFault(t, err, "invalid_input")
	}
	for _, tc := range []struct {
		principal                   model.Principal
		project, task, target, code string
		version                     int64
	}{
		{model.Principal{}, project.ID, task.ID, moveStepIDs[0], "unauthenticated", 1}, {principal, "bad", task.ID, moveStepIDs[0], "invalid_input", 1}, {principal, project.ID, "bad", moveStepIDs[0], "invalid_input", 1}, {principal, project.ID, task.ID, "bad", "invalid_input", 1}, {principal, project.ID, task.ID, moveStepIDs[0], "invalid_input", 0},
		{principal, uuid.NewString(), task.ID, moveStepIDs[0], "not_found", 1}, {principal, project.ID, uuid.NewString(), moveStepIDs[0], "not_found", 1}, {servicePrincipal(t, database), project.ID, task.ID, moveStepIDs[0], "not_found", 1},
	} {
		_, err := steps.Move(context.Background(), tc.principal, tc.project, tc.task, tc.target, MoveTaskStep{Version: tc.version, Position: pointer("first")})
		requireThreadFault(t, err, tc.code)
	}
	before, otherBefore := stepsStoredState(t, database, task.ID, false), stepsStoredState(t, database, other.ID, false)
	_, err := steps.Move(context.Background(), principal, project.ID, task.ID, "ffffffff", MoveTaskStep{Version: 1, Before: pointer("ffffffff")})
	requireThreadFault(t, err, "not_found")
	var absence *StepAbsence
	if !errors.As(err, &absence) || absence.Version != 1 {
		t.Fatal("missing target did not retain admitted parent version")
	}
	_, err = steps.Move(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: 1, Before: pointer("ffffffff")})
	requireThreadFault(t, err, "not_found")
	if errors.As(err, &absence) {
		t.Fatal("missing anchor was mislabeled as missing target")
	}
	for _, input := range []MoveTaskStep{{Version: 1, Before: pointer("ABCDEF01")}, {Version: 1, After: pointer("ABCDEF01")}} {
		_, err = steps.Move(context.Background(), principal, project.ID, task.ID, "abcdef01", input)
		requireThreadFault(t, err, "invalid_input")
	}
	if before != stepsStoredState(t, database, task.ID, false) || otherBefore != stepsStoredState(t, database, other.ID, false) {
		t.Fatal("identity/anchor refusal changed a Task")
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err = steps.Move(context.Background(), principal, project.ID, task.ID, "ffffffff", MoveTaskStep{Version: 99, Before: pointer("ffffffff")})
	requireThreadFault(t, err, "task_deleted")
}

func TestTaskStepsMoveQueryAndStoredCollectionFailuresStayInternal(t *testing.T) {
	for _, query := range []string{`DROP TABLE task_steps`, `ALTER TABLE tasks RENAME COLUMN version TO invalid_version`, `UPDATE task_steps SET position=9 WHERE id='abcdef01'`} {
		t.Run(query, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedMoveSteps(t, database, task.ID)
			if _, err := database.Pool.Exec(context.Background(), query); err != nil {
				t.Fatal(err)
			}
			result, err := NewTaskSteps(database).Move(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: 1, Position: pointer("last")})
			if err == nil || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("query/corrupt collection concealed")
			}
			if _, pure := TaskStepsFault(err); pure {
				t.Fatal("query/corrupt collection became business refusal")
			}
		})
	}
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	database.Close()
	if _, err := NewTaskSteps(database).Move(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: 1, Position: pointer("last")}); err == nil {
		t.Fatal("closed database succeeded")
	}
}

func TestTaskStepsMoveConfirmedRollbackAfterPositionAndParentWrites(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	before := stepsStoredState(t, database, task.ID, false)
	for _, fragment := range []string{"UPDATE task_steps SET position=CASE", "UPDATE tasks SET version=version+1,updated_at=$3"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			observed := false
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.HasPrefix(sql, fragment) }, end: func() { observed = true; cancel() }})
			result, err := NewTaskSteps(traced.store).Move(ctx, principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: 1, Position: pointer("last")})
			var failure *store.TransactionError
			if !observed || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted || result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil {
				t.Fatalf("move cancellation completion: %+v %v", failure, err)
			}
			if before != stepsStoredState(t, database, task.ID, false) {
				t.Fatal("completed interval/parent change survived confirmed rollback")
			}
		})
	}
}

func TestTaskStepsMovePartialIntervalAndParentSQLFailuresRollBack(t *testing.T) {
	for _, mode := range []string{"partial_interval", "parent_touch", "suppressed_interval"} {
		t.Run(mode, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedMoveSteps(t, database, task.ID)
			switch mode {
			case "partial_interval":
				if _, err := database.Pool.Exec(context.Background(), `CREATE SEQUENCE move_attempts; CREATE FUNCTION fail_partial_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('move_attempts')=2 THEN RAISE EXCEPTION 'partial-move-sentinel' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_partial_move AFTER UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION fail_partial_move()`); err != nil {
					t.Fatal(err)
				}
			case "parent_touch":
				if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION refuse_move_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'move-touch-sentinel' USING ERRCODE='P0001'; END $$; CREATE TRIGGER refuse_move_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_move_touch()`); err != nil {
					t.Fatal(err)
				}
			default:
				if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION suppress_move_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='11111111' THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER suppress_move_row BEFORE UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION suppress_move_row()`); err != nil {
					t.Fatal(err)
				}
			}
			before := stepsStoredState(t, database, task.ID, false)
			result, err := NewTaskSteps(database).Move(context.Background(), principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: 1, Position: pointer("last")})
			var failure *store.TransactionError
			if !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted || result.JSON != nil {
				t.Fatalf("move SQL completion: %+v %v", failure, err)
			}
			if mode == "suppressed_interval" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("suppressed interval count mismatch cause lost")
				}
			} else {
				var driver *pgconn.PgError
				if !errors.As(err, &driver) || driver.Code != "P0001" {
					t.Fatal("original trigger SQLSTATE lost")
				}
			}
			if _, pure := TaskStepsFault(err); pure {
				t.Fatal("persistence fault became child visibility refusal")
			}
			if before != stepsStoredState(t, database, task.ID, false) {
				t.Fatal("partial interval or failed touch left stored changes")
			}
			if mode == "partial_interval" {
				var count int64
				if err := database.Pool.QueryRow(context.Background(), `SELECT last_value FROM move_attempts`).Scan(&count); err != nil || count != 2 {
					t.Fatalf("partial interval was not entered: count=%d %v", count, err)
				}
			}
		})
	}
}

func TestTaskStepsMoveSameVersionCompetition(t *testing.T) {
	for _, kind := range []string{"move", "add", "task"} {
		t.Run(kind, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			seedMoveSteps(t, database, task.ID)
			steps := NewTaskSteps(database)
			move := func(ctx context.Context) (model.Task, error) {
				result, err := steps.Move(ctx, principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: 1, Position: pointer("last")})
				return model.Task{Version: result.Resource.Version}, err
			}
			other := func(ctx context.Context) (model.Task, error) {
				result, err := steps.Move(ctx, principal, project.ID, task.ID, moveStepIDs[3], MoveTaskStep{Version: 1, Position: pointer("first")})
				return model.Task{Version: result.Resource.Version}, err
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
			results := competeTaskWrites(t, database, project.ID, move, other)
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
				t.Fatalf("invalid competing move results: %+v", results)
			}
			current, err := steps.List(context.Background(), principal, project.ID, task.ID)
			if err != nil || current.Resource.Version != 2 {
				t.Fatal("competition did not advance parent once")
			}
			var title string
			if err := database.Pool.QueryRow(context.Background(), `SELECT title FROM tasks WHERE id=$1`, task.ID).Scan(&title); err != nil {
				t.Fatal(err)
			}
			order := make([]string, len(current.Resource.Steps))
			for index, step := range current.Resource.Steps {
				order[index] = step.ID
			}
			movedFirst := len(order) == 4 && order[3] == moveStepIDs[0]
			if kind == "move" {
				movedOther := len(order) == 4 && order[0] == moveStepIDs[3]
				if movedFirst == movedOther {
					t.Fatal("both competing orders or neither survived")
				}
			}
			if kind == "add" {
				added := len(order) == 5 && order[4] == "12345678"
				if movedFirst == added {
					t.Fatal("both Move/Add effects or neither survived")
				}
			}
			if kind == "task" {
				if movedFirst == (title == "Parent changed") {
					t.Fatal("both Move/metadata effects or neither survived")
				}
			}
		})
	}
}

func TestTaskStepsMoveNoOpVersusRealChange(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedMoveSteps(t, database, task.ID)
	steps := NewTaskSteps(database)
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			result, err := steps.Move(ctx, principal, project.ID, task.ID, moveStepIDs[0], MoveTaskStep{Version: 1, Position: pointer("first")})
			return model.Task{Version: result.Resource.Version}, err
		},
		func(ctx context.Context) (model.Task, error) {
			result, err := steps.Move(ctx, principal, project.ID, task.ID, moveStepIDs[3], MoveTaskStep{Version: 1, Position: pointer("first")})
			return model.Task{Version: result.Resource.Version}, err
		})
	successes := 0
	for _, result := range results {
		if result.err == nil {
			successes++
		} else {
			requireThreadFault(t, result.err, "version_conflict")
		}
	}
	if successes < 1 || successes > 2 {
		t.Fatal("invalid no-op competition completion")
	}
	current, err := steps.List(context.Background(), principal, project.ID, task.ID)
	if err != nil || current.Resource.Version != 2 || current.Resource.Steps[0].ID != moveStepIDs[3] {
		t.Fatal("no-op advanced parent or overwrote the real move")
	}
}
