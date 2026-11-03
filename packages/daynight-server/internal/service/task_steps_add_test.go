package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func stepsStoredState(t *testing.T, database *store.Store, taskID string, excludeParentRevision bool) string {
	t.Helper()
	var state string
	err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
 'task',(SELECT CASE WHEN $2 THEN to_jsonb(t)-'version'-'updated_at' ELSE to_jsonb(t) END FROM tasks t WHERE id=$1),
 'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=$1),
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=$1),
 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=$1),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=$1))::text`, taskID, excludeParentRevision).Scan(&state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func addServiceStep(t *testing.T, steps *TaskSteps, principal core.Principal, task core.Task, input AddTaskStep) StepsWriteResult {
	t.Helper()
	result, err := steps.Add(context.Background(), principal, task.ProjectID, task.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.TransactionOutcome != store.TransactionCommitted || result.Phase != "commit" || result.CleanupFailed || len(result.JSON) == 0 {
		t.Fatalf("unconfirmed success: %+v", result)
	}
	return result
}

func TestTaskStepsAddPreservesParentAndExistingContentAcrossTaskPolicies(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	member := workerMember(t, database, project.ID)
	dependency := finishTask(t, tasks, admin, createTask(t, tasks, admin, project.ID, "Dependency"))
	steps := NewTaskSteps(database)
	for _, mode := range []string{"todo", "in_progress", "done", "active_worker", "invalid_worker"} {
		t.Run(mode, func(t *testing.T) {
			task := createTask(t, tasks, admin, project.ID, "Parent", dependency.ID)
			task = updateTask(t, tasks, admin, task, UpdateTask{Description: pointer("Parent description"), Properties: propertyPatch(core.PullRequestProperty{URL: "opaque\x00url", Title: "Evidence"}), AssignedTo: pointer(pointer(member.UserID))})
			if mode == "active_worker" {
				task = updateTask(t, tasks, admin, task, UpdateTask{AllowAgents: pointer(true)})
				descriptor := workerDescriptor()
				task = claimWorkerTask(t, tasks, member, task, descriptor)
				if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,grant_kind) VALUES($1,$2,$3,$4,$5,$6,'{}','{}','secret','2099-01-01','connect')`, uuid.NewString(), project.ID, task.ID, descriptor.ClaimID, member.UserID, uuid.NewString()); err != nil {
					t.Fatal(err)
				}
			} else if mode == "in_progress" || mode == "done" {
				if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET status=$2,started_at='2026-01-01',completed_at=CASE WHEN $2='done' THEN '2026-01-02'::timestamptz ELSE NULL END WHERE id=$1`, task.ID, mode); err != nil {
					t.Fatal(err)
				}
			} else if mode == "invalid_worker" {
				if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','invalid JSON')`, task.ID); err != nil {
					t.Fatal(err)
				}
			}
			// Exclude only the intentional parent revision fields from this snapshot.
			var before, after string
			query := `SELECT jsonb_build_object('task',to_jsonb(t)-'version'-'updated_at','properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=t.id),'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=t.id),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`
			if err := database.Pool.QueryRow(context.Background(), query, task.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			first := addServiceStep(t, steps, member, task, AddTaskStep{Version: task.Version, ID: "ABCDEF01", Title: "same"})
			existing := first.Resource.Steps[0]
			result := addServiceStep(t, steps, member, task, AddTaskStep{Version: first.Resource.Version, ID: "00000000", Title: "same", Description: "  # 原值\n<>&  ", Status: pointer(core.TaskStepSkipped), Before: pointer("ABCDEF01")})
			if result.Resource.Version != task.Version+2 || len(result.Resource.Steps) != 2 || result.Resource.Steps[1] != existing || result.Resource.Steps[0].Status != core.TaskStepSkipped || result.Resource.Steps[0].CreatedAt != result.Resource.Steps[0].UpdatedAt {
				t.Fatalf("add contract: %+v", result.Resource)
			}
			if err := database.Pool.QueryRow(context.Background(), query, task.ID).Scan(&after); err != nil || before != after {
				t.Fatalf("parent or ownership changed: %v\n%s\n%s", err, before, after)
			}
			var version int64
			var sameClock bool
			if err := database.Pool.QueryRow(context.Background(), `SELECT t.version,t.updated_at=s.created_at AND s.created_at=s.updated_at FROM tasks t JOIN task_steps s ON s.task_id=t.id AND s.id='00000000' WHERE t.id=$1`, task.ID).Scan(&version, &sameClock); err != nil || version != result.Resource.Version || !sameClock {
				t.Fatalf("shared revision/time: %d %v %v", version, sameClock, err)
			}
		})
	}
}

func TestTaskStepsAddAdmissionAndRefusalOrder(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	steps := NewTaskSteps(database)
	addServiceStep(t, steps, principal, task, AddTaskStep{Version: 1, ID: "00000000", Title: "same"})
	for _, tc := range []struct {
		version int64
		id      string
		before  *string
		code    string
	}{
		{1, "00000000", pointer("ffffffff"), "version_conflict"},
		{2, "00000000", pointer("ffffffff"), "step_id_conflict"},
		{2, "12345678", pointer("ffffffff"), "not_found"},
	} {
		before := stepsStoredState(t, database, task.ID, false)
		result, err := steps.Add(context.Background(), principal, project.ID, task.ID, AddTaskStep{Version: tc.version, ID: tc.id, Title: "x", Before: tc.before})
		requireThreadFault(t, err, tc.code)
		if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil || before != stepsStoredState(t, database, task.ID, false) {
			t.Fatal("refusal was not an unchanged confirmed rollback")
		}
	}
	for _, tc := range []struct {
		principal           core.Principal
		project, task, code string
	}{
		{core.Principal{}, project.ID, task.ID, "unauthenticated"}, {principal, "bad", task.ID, "invalid_input"}, {principal, project.ID, "bad", "invalid_input"},
		{principal, uuid.NewString(), task.ID, "not_found"}, {principal, project.ID, uuid.NewString(), "not_found"}, {servicePrincipal(t, database), project.ID, task.ID, "not_found"},
	} {
		_, err := steps.Add(context.Background(), tc.principal, tc.project, tc.task, AddTaskStep{Version: 2, ID: "12345678", Title: "x"})
		requireThreadFault(t, err, tc.code)
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$2 WHERE id=$1`, task.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		version int64
		id      string
		anchor  *string
		code    string
	}{
		{2, "00000000", nil, "version_conflict"}, {math.MaxInt64, "00000000", nil, "step_id_conflict"}, {math.MaxInt64, "12345678", pointer("ffffffff"), "not_found"}, {math.MaxInt64, "12345678", nil, "version_exhausted"},
	} {
		before := stepsStoredState(t, database, task.ID, false)
		_, err := steps.Add(context.Background(), principal, project.ID, task.ID, AddTaskStep{Version: tc.version, ID: tc.id, Title: "x", Before: tc.anchor})
		requireThreadFault(t, err, tc.code)
		if before != stepsStoredState(t, database, task.ID, false) {
			t.Fatal("exhaustion refusal changed stored state")
		}
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err := steps.Add(context.Background(), principal, project.ID, task.ID, AddTaskStep{Version: 2, ID: "12345678", Title: "x"})
	requireThreadFault(t, err, "task_deleted")
}

func TestTaskStepsAddSameVersionSerializesWithAddsAndTaskMetadata(t *testing.T) {
	for _, metadata := range []bool{false, true} {
		t.Run(fmt.Sprintf("metadata=%t", metadata), func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			steps := NewTaskSteps(database)
			add := func(id string) func(context.Context) (core.Task, error) {
				return func(ctx context.Context) (core.Task, error) {
					result, err := steps.Add(ctx, principal, project.ID, task.ID, AddTaskStep{Version: task.Version, ID: id, Title: "same"})
					return core.Task{Version: result.Resource.Version}, err
				}
			}
			other := add("abcdef01")
			if metadata {
				other = func(ctx context.Context) (core.Task, error) {
					return tasks.Update(ctx, principal, project.ID, task.ID, UpdateTask{Version: task.Version, Title: pointer("Changed")})
				}
			}
			results := competeTaskWrites(t, database, project.ID, add("00000000"), other)
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
				t.Fatalf("concurrent winners: %+v", results)
			}
			actual, err := tasks.Get(context.Background(), principal, project.ID, task.ID)
			if err != nil || actual.Version != task.Version+1 {
				t.Fatalf("parent revision: %+v %v", actual, err)
			}
			document, err := steps.List(context.Background(), principal, project.ID, task.ID)
			if err != nil || document.Resource.Version != actual.Version {
				t.Fatal(err)
			}
			expected := 1
			if metadata && actual.Title == "Changed" {
				expected = 0
			}
			if len(document.Resource.Steps) != expected {
				t.Fatal("both concurrent changes committed")
			}
		})
	}
}

func TestTaskStepsAddConfirmedRollbackAfterEveryActualWrite(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	addServiceStep(t, NewTaskSteps(database), principal, task, AddTaskStep{Version: task.Version, ID: "00000000", Title: "existing"})
	before := stepsStoredState(t, database, task.ID, false)
	for _, fragment := range []string{"UPDATE task_steps SET position=position+1", "INSERT INTO task_steps", "UPDATE tasks SET version=version+1,updated_at=$3"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			observed := false
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: func() { observed = true; cancel() }})
			result, err := NewTaskSteps(traced.store).Add(ctx, principal, project.ID, task.ID, AddTaskStep{Version: 2, ID: "abcdef01", Title: "new", Before: pointer("00000000")})
			var transaction *store.TransactionError
			if !observed || !errors.Is(err, context.Canceled) || !errors.As(err, &transaction) || transaction.CommitAttempted || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted || result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil {
				t.Fatalf("rollback completion: observed=%t result=%+v tx=%+v err=%v", observed, result, transaction, err)
			}
			if after := stepsStoredState(t, database, task.ID, false); after != before {
				t.Fatalf("partial write survived rollback\n%s\n%s", before, after)
			}
		})
	}
}

func TestTaskStepsAddInputAndStorageFailures(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	steps := NewTaskSteps(database)
	good := AddTaskStep{Version: 1, ID: "00000000", Title: "x"}
	for _, input := range []AddTaskStep{{Version: 0, ID: "00000000", Title: "x"}, {Version: 1, ID: "bad", Title: "x"}, {Version: 1, ID: "00000000", Title: "\u0085"}, {Version: 1, ID: "00000000", Title: "x", Description: "\x00"}, {Version: 1, ID: "00000000", Title: "x", Status: pointer(core.TaskStepStatus(""))}, {Version: 1, ID: "00000000", Title: "x", Before: pointer("00000001"), After: pointer("00000002")}, {Version: 1, ID: "00000000", Title: "x", Before: pointer("bad")}} {
		result, err := steps.Add(context.Background(), principal, project.ID, task.ID, input)
		requireThreadFault(t, err, "invalid_input")
		if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil {
			t.Fatal(result)
		}
	}
	addServiceStep(t, steps, principal, task, good)
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET position=2 WHERE task_id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	result, err := steps.Add(context.Background(), principal, project.ID, task.ID, AddTaskStep{Version: 2, ID: "abcdef01", Title: "x"})
	if err == nil || result.JSON != nil {
		t.Fatal("corrupt storage was repaired or ignored")
	}
	if _, pure := TaskStepsFault(err); pure {
		t.Fatal("corrupt storage became a business refusal")
	}
	database.Close()
	_, err = steps.Add(context.Background(), principal, project.ID, task.ID, good)
	if err == nil {
		t.Fatal("closed store succeeded")
	}
}

func TestTaskStepsFaultRejectsTypedCompletionFailures(t *testing.T) {
	refusal := &Fault{Code: "step_id_conflict", Message: "private business refusal"}
	for _, failure := range []*store.TransactionError{
		{Phase: "cleanup", Cause: refusal, Outcome: store.TransactionNotCommitted, CleanupFailed: true},
		{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
		{Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown},
	} {
		if _, pure := TaskStepsFault(failure); pure {
			t.Fatal("transaction completion fault concealed")
		}
		if _, pure := TaskStepsFault(&Fault{Code: "not_found", Message: "wrapped refusal", Cause: failure}); pure {
			t.Fatal("business wrapper concealed typed completion failure")
		}

	}
	failure := &store.TransactionError{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted}
	if actual, pure := TaskStepsFault(failure); !pure || !reflect.DeepEqual(actual, refusal) {
		t.Fatal("confirmed pure refusal lost")
	}
}

func TestTaskStepsChildAbsenceKeepsIdentityAndCause(t *testing.T) {
	absence := &StepAbsence{Version: 9007199254740993, Cause: core.ErrNotFound}
	if absence.Error() != "step is currently absent" || !errors.Is(absence, core.ErrNotFound) {
		t.Fatal("child absence lost safe diagnostic or exact cause")
	}
}

func TestTaskStepsAddQueryFailuresRemainInternal(t *testing.T) {
	for _, query := range []string{`DROP TABLE task_steps`, `ALTER TABLE tasks RENAME COLUMN version TO invalid_version`} {
		t.Run(query, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			task := createTask(t, tasks, principal, project.ID, "Parent")
			if _, err := database.Pool.Exec(context.Background(), query); err != nil {
				t.Fatal(err)
			}
			result, err := NewTaskSteps(database).Add(context.Background(), principal, project.ID, task.ID, AddTaskStep{Version: 1, ID: "00000000", Title: "x"})
			if err == nil || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatalf("query failure concealed: %+v %v", result, err)
			}
			if _, pure := TaskStepsFault(err); pure {
				t.Fatal("query failure became a visibility/business refusal")
			}
		})
	}
}
