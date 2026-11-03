package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func assignmentChange(value *string) **string { return &value }

func createAssignedTask(t *testing.T, tasks *Tasks, actor core.Principal, projectID string, assigned *string) core.Task {
	t.Helper()
	created, err := tasks.Create(context.Background(), actor, projectID, CreateTask{
		Title: "Assigned responsibility", Description: "Preserved material", AssignedTo: assigned,
		Properties: propertyPatch(core.PullRequestProperty{URL: "opaque\x00", Title: "Evidence"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func assertAssignmentChanged(t *testing.T, before, after core.Task, assigned *string) {
	t.Helper()
	if !equalOptional(after.AssignedTo, assigned) || after.AllowAgents || after.Version != before.Version+1 || !after.UpdatedAt.After(before.UpdatedAt) {
		t.Fatalf("assignment transition: before %#v, after %#v", before, after)
	}
	preserved := after
	preserved.AssignedTo, preserved.AllowAgents, preserved.Version, preserved.UpdatedAt = before.AssignedTo, before.AllowAgents, before.Version, before.UpdatedAt
	if !reflect.DeepEqual(preserved, before) {
		t.Fatalf("assignment changed unrelated task facts: before %#v, after %#v", before, after)
	}
}

func TestTaskAssignmentCreateAndTransitions(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice, bob := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	for _, assigned := range []*string{nil, pointer(alice.UserID), pointer(strings.ToUpper(alice.UserID))} {
		created := createAssignedTask(t, tasks, admin, project.ID, assigned)
		want := assigned
		if want != nil {
			want = &alice.UserID
		}
		if !equalOptional(created.AssignedTo, want) || created.AllowAgents || created.Version != 1 || created.Status != core.TaskTodo {
			t.Fatalf("creation assignment: %#v", created)
		}
	}
	for _, bad := range []string{"", " ", "not-a-uuid", " " + alice.UserID, alice.UserID + " "} {
		_, err := tasks.Create(ctx, admin, project.ID, CreateTask{Title: "Invalid assignment", AssignedTo: &bad})
		requireFault(t, err, "invalid_input")
	}
	outsider := servicePrincipal(t, database)
	_, err := tasks.Create(ctx, admin, project.ID, CreateTask{Title: "Ineligible assignment", AssignedTo: &outsider.UserID})
	requireFault(t, err, "invalid_input")
	for _, status := range []core.TaskStatus{core.TaskTodo, core.TaskDone} {
		for _, transition := range []struct{ before, after *string }{
			{nil, &alice.UserID}, {&alice.UserID, &bob.UserID}, {&alice.UserID, nil},
		} {
			before := createAssignedTask(t, tasks, admin, project.ID, transition.before)
			before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true)})
			before = setStatusTask(t, tasks, admin, before, status)
			after := updateTask(t, tasks, admin, before, UpdateTask{AssignedTo: assignmentChange(transition.after), AllowAgents: pointer(true)})
			assertAssignmentChanged(t, before, after, transition.after)
		}
	}
}

func TestTaskAssignmentNoOpsAndExecutionLocks(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice, bob := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	for _, assigned := range []*string{nil, &alice.UserID} {
		for _, status := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
			before := createAssignedTask(t, tasks, admin, project.ID, assigned)
			before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true)})
			before = setStatusTask(t, tasks, admin, before, status)
			equal := assigned
			if assigned != nil {
				equal = pointer(strings.ToUpper(*assigned))
			}
			after := updateTask(t, tasks, admin, before, UpdateTask{AssignedTo: assignmentChange(equal)})
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("same assignment changed status=%s: before %#v, after %#v", status, before, after)
			}
			_, err := tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version - 1, AssignedTo: assignmentChange(equal)})
			requireFault(t, err, "version_conflict")
			if status == core.TaskInProgress {
				for _, value := range []*string{&bob.UserID, nil} {
					if equalOptional(value, assigned) {
						continue
					}
					_, err := tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(value), Description: pointer("Must not partly save")})
					requireFault(t, err, "invalid_transition")
					assertTaskUnchanged(t, tasks, admin, before)
				}
			}
		}
	}
	before := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
	for _, bad := range []string{"", "bad", " " + alice.UserID} {
		_, err := tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&bad), Title: pointer("Must not save")})
		requireFault(t, err, "invalid_input")
		assertTaskUnchanged(t, tasks, admin, before)
	}
	outsider := servicePrincipal(t, database)
	_, err := tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&outsider.UserID)})
	requireFault(t, err, "invalid_input")
	assertTaskUnchanged(t, tasks, admin, before)
}

func TestTaskAssignmentSurvivesMemberLossAndUnrelatedWrites(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice := workerMember(t, database, project.ID)
	before := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
	before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true)})
	if err := database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error { return tx.RemoveMember(ctx, alice.UserID) }); err != nil {
		t.Fatal(err)
	}
	assertTaskUnchanged(t, tasks, admin, before)
	if same := updateTask(t, tasks, admin, before, UpdateTask{AssignedTo: assignmentChange(pointer(strings.ToUpper(alice.UserID)))}); !reflect.DeepEqual(same, before) {
		t.Fatal("historical same assignment changed the task")
	}
	current := updateTask(t, tasks, admin, before, UpdateTask{AssignedTo: assignmentChange(&alice.UserID), Title: pointer("Legitimate metadata"), RequiredPlatform: platformChange(pointer(core.PlatformLinux))})
	if !equalOptional(current.AssignedTo, &alice.UserID) || !current.AllowAgents {
		t.Fatal("unrelated metadata requalified or cleared a former assignee")
	}
	current, err := tasks.SetProperty(ctx, admin, project.ID, current.ID, "paused", "true", current.Version)
	if err != nil {
		t.Fatal(err)
	}
	current, err = tasks.RemoveProperty(ctx, admin, project.ID, current.ID, "paused", current.Version)
	if err != nil {
		t.Fatal(err)
	}
	if same, err := tasks.RemoveProperty(ctx, admin, project.ID, current.ID, "paused", current.Version); err != nil || !reflect.DeepEqual(same, current) {
		t.Fatal("absent property removal changed assignment", err)
	}
	for _, status := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskInProgress, core.TaskDone, core.TaskTodo} {
		current = setStatusTask(t, tasks, admin, current, status)
		if !equalOptional(current.AssignedTo, &alice.UserID) || !current.AllowAgents {
			t.Fatalf("status %s lost historical responsibility", status)
		}
	}
	cleared := updateTask(t, tasks, admin, current, UpdateTask{AssignedTo: assignmentChange(nil)})
	assertAssignmentChanged(t, current, cleared, nil)
}

func TestTaskAssignmentSurvivesEveryWorkerWrite(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice, owner, bob := workerMember(t, database, project.ID), workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	current := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
	current = updateTask(t, tasks, admin, current, UpdateTask{AllowAgents: pointer(true)})
	descriptor := workerDescriptor()
	current = claimWorkerTask(t, tasks, owner, current, descriptor)
	if testWorker(t, current.Properties).UserID != owner.UserID || !equalOptional(current.AssignedTo, &alice.UserID) {
		t.Fatal("responsibility restricted another member's eligible worker")
	}
	_, err := tasks.Update(ctx, admin, project.ID, current.ID, UpdateTask{Version: current.Version, AssignedTo: assignmentChange(&bob.UserID)})
	requireFault(t, err, "invalid_transition")
	assertTaskUnchanged(t, tasks, admin, current)
	phase := core.WorkerExecuting
	current, err = tasks.UpdateWorker(ctx, owner, project.ID, current.ID, UpdateWorker{Version: current.Version, ClaimID: descriptor.ClaimID, Phase: &phase})
	if err != nil {
		t.Fatal(err)
	}
	if same, err := tasks.UpdateWorker(ctx, owner, project.ID, current.ID, UpdateWorker{Version: current.Version, ClaimID: descriptor.ClaimID, Phase: &phase}); err != nil || !reflect.DeepEqual(same, current) {
		t.Fatal("equal worker summary was treated as clearing responsibility", err)
	}
	current, err = tasks.SetProperty(ctx, admin, project.ID, current.ID, "paused", "true", current.Version)
	if err != nil {
		t.Fatal(err)
	}
	current, err = tasks.RemoveProperty(ctx, admin, project.ID, current.ID, "paused", current.Version)
	if err != nil || !equalOptional(current.AssignedTo, &alice.UserID) {
		t.Fatal("active property mutation lost responsibility", err)
	}
	current, err = tasks.ReleaseWorker(ctx, owner, project.ID, current.ID, ReleaseWorker{Version: current.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil || !equalOptional(current.AssignedTo, &alice.UserID) {
		t.Fatal("release lost responsibility", err)
	}
	current = updateTask(t, tasks, admin, current, UpdateTask{AssignedTo: assignmentChange(&bob.UserID)})
	if testWorker(t, current.Properties).UserID != owner.UserID || current.AllowAgents {
		t.Fatal("reassignment transferred retained execution ownership")
	}
	next := workerDescriptor()
	resume := ResumeWorker{ClaimWorker: ClaimWorker{Version: current.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID}
	_, err = tasks.ResumeWorker(ctx, bob, project.ID, current.ID, resume)
	requireFault(t, err, "forbidden")
	current, err = tasks.ResumeWorker(ctx, owner, project.ID, current.ID, resume)
	if err != nil || !equalOptional(current.AssignedTo, &bob.UserID) || current.AllowAgents {
		t.Fatal("manual resume lost responsibility or reset its permission", err)
	}
	current, err = tasks.SetStatus(ctx, owner, project.ID, current.ID, SetTaskStatus{Version: current.Version, Status: core.TaskDone, ClaimID: &next.ClaimID})
	if err != nil || !equalOptional(current.AssignedTo, &bob.UserID) {
		t.Fatal("claim completion lost responsibility", err)
	}
	current = startTask(t, tasks, admin, current)
	if !equalOptional(current.AssignedTo, &bob.UserID) || testWorker(t, current.Properties).State != core.WorkerCompleted {
		t.Fatal("reopening changed responsibility or historical ownership")
	}
	withdrawn := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
	withdrawn = updateTask(t, tasks, admin, withdrawn, UpdateTask{AllowAgents: pointer(true)})
	claim := workerDescriptor()
	withdrawn = claimWorkerTask(t, tasks, owner, withdrawn, claim)
	withdrawn, err = tasks.WithdrawWorker(ctx, owner, project.ID, withdrawn.ID, WithdrawWorker{Version: withdrawn.Version, ClaimID: claim.ClaimID})
	if err != nil || !equalOptional(withdrawn.AssignedTo, &alice.UserID) || withdrawn.AllowAgents || testWorker(t, withdrawn.Properties) != nil {
		t.Fatal("withdrawal lost responsibility or kept the claim", err)
	}
}

func TestTaskAssignmentCompetesWithExecutionAndPermission(t *testing.T) {
	for _, competitor := range []string{"start", "claim", "enable"} {
		t.Run(competitor, func(t *testing.T) {
			tasks, database, project, _, admin := taskService(t)
			alice, bob := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
			before := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
			if competitor != "enable" {
				before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true)})
			}
			results := competeTaskWrites(t, database, project.ID,
				func(ctx context.Context) (core.Task, error) {
					return tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&bob.UserID)})
				},
				func(ctx context.Context) (core.Task, error) {
					switch competitor {
					case "start":
						return tasks.SetStatus(ctx, admin, project.ID, before.ID, SetTaskStatus{Version: before.Version, Status: core.TaskInProgress})
					case "claim":
						return tasks.ClaimWorker(ctx, bob, project.ID, before.ID, ClaimWorker{Version: before.Version, WorkerDescriptor: workerDescriptor()})
					default:
						return tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AllowAgents: pointer(true)})
					}
				})
			assertOneTaskWinner(t, results, "version_conflict")
			after, err := tasks.Get(context.Background(), admin, project.ID, before.ID)
			if err != nil || after.Version != before.Version+1 {
				t.Fatal("race did not commit exactly one mutation", err)
			}
			if equalOptional(after.AssignedTo, &bob.UserID) {
				if after.AllowAgents || after.Status != core.TaskTodo || testWorker(t, after.Properties) != nil {
					t.Fatal("winning assignment admitted execution or permission")
				}
			} else if !equalOptional(after.AssignedTo, &alice.UserID) || !after.AllowAgents {
				t.Fatal("winning execution/permission changed the assignee")
			}
		})
	}
}

func TestTaskAssignmentNoOpAndClaimCanBothSucceed(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	alice, owner := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	before := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
	before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true)})
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&alice.UserID)})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.ClaimWorker(ctx, owner, project.ID, before.ID, ClaimWorker{Version: before.Version, WorkerDescriptor: workerDescriptor()})
		})
	for _, result := range results {
		if result.err != nil {
			requireFault(t, result.err, "version_conflict")
		} else if result.task.Status == core.TaskTodo && !reflect.DeepEqual(result.task, before) {
			t.Fatal("successful equal assignment was not a no-op")
		}
	}
	after, err := tasks.Get(context.Background(), admin, project.ID, before.ID)
	if err != nil || after.Status != core.TaskInProgress || after.Version != before.Version+1 || !after.AllowAgents || !equalOptional(after.AssignedTo, &alice.UserID) || testWorker(t, after.Properties).UserID != owner.UserID {
		t.Fatalf("equal assignment interfered with claim: %#v, %v", after, err)
	}
}

func TestTaskAssignmentRechecksMemberRemoval(t *testing.T) {
	for _, removeActor := range []bool{false, true} {
		tasks, database, project, _, admin := taskService(t)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		actor, target := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
		before := createAssignedTask(t, tasks, admin, project.ID, nil)
		result := make(chan taskResult, 1)
		if err := database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error {
			go func() {
				task, err := tasks.Update(ctx, actor, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&target.UserID)})
				result <- taskResult{task: task, err: err}
			}()
			waitForTaskWriters(t, ctx, database, 1)
			removed := target.UserID
			if removeActor {
				removed = actor.UserID
			}
			return tx.RemoveMember(ctx, removed)
		}); err != nil {
			t.Fatal(err)
		}
		code := "invalid_input"
		if removeActor {
			code = "not_found"
		}
		requireFault(t, receiveTaskResult(t, ctx, result).err, code)
		assertTaskUnchanged(t, tasks, admin, before)
	}
}

func TestTaskAssignmentFailuresPreserveAtomicityAndCause(t *testing.T) {
	t.Run("target lookup failure", func(t *testing.T) {
		tasks, database, project, _, admin := taskService(t)
		ctx := context.Background()
		target := workerMember(t, database, project.ID)
		before := createAssignedTask(t, tasks, admin, project.ID, nil)
		statement := fmt.Sprintf(`CREATE FUNCTION refuse_assignment_target() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1030',MESSAGE='private assignment target'; END $$;
			ALTER TABLE project_members RENAME TO assignment_member_source;
			CREATE VIEW project_members AS SELECT project_id,user_id,CASE WHEN user_id='%s'::uuid THEN refuse_assignment_target() ELSE role END AS role,version,created_at,updated_at FROM assignment_member_source`, target.UserID)
		if _, err := database.Pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
		_, err := tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&target.UserID)})
		assertOperational(t, err)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "P1030" || strings.Contains(err.Error(), "private assignment") {
			t.Fatalf("target lookup failure was masked or leaked: %v", err)
		}
		if _, err := database.Pool.Exec(ctx, `DROP VIEW project_members; ALTER TABLE assignment_member_source RENAME TO project_members`); err != nil {
			t.Fatal(err)
		}
		assertTaskUnchanged(t, tasks, admin, before)
	})
	t.Run("cancel after update", func(t *testing.T) {
		tasks, database, project, databaseURL, admin := taskService(t)
		alice, bob := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
		before := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
		before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true)})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "UPDATE tasks SET") }, end: cancel})
		_, err := traced.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&bob.UserID)})
		assertOperational(t, err)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("assignment cancellation lost its cause: %v", err)
		}
		assertTaskUnchanged(t, tasks, admin, before)
	})
	t.Run("commit failure dominates target refusal", func(t *testing.T) {
		tasks, database, project, databaseURL, admin := taskService(t)
		before := createAssignedTask(t, tasks, admin, project.ID, nil)
		outsider := servicePrincipal(t, database)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var memberships atomic.Int32
		traced := tracedTasks(t, databaseURL, taskQueryAction{
			match: func(sql string) bool {
				return strings.Contains(sql, "FROM project_members m") && memberships.Add(1) == 2
			}, end: cancel,
		})
		_, err := traced.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&outsider.UserID)})
		assertOperational(t, err)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("target refusal masked transaction failure: %v", err)
		}
		assertTaskUnchanged(t, tasks, admin, before)
	})
	t.Run("later edge failure", func(t *testing.T) {
		tasks, database, project, _, admin := taskService(t)
		ctx := context.Background()
		alice, bob := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
		dependency := finishTask(t, tasks, admin, createTask(t, tasks, admin, project.ID, "Dependency"))
		before := createAssignedTask(t, tasks, admin, project.ID, &alice.UserID)
		before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true), DependsOn: pointer([]string{dependency.ID})})
		if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION refuse_assignment_edge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1028',MESSAGE='private assignment edge'; END $$; CREATE TRIGGER refuse_assignment_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION refuse_assignment_edge()`); err != nil {
			t.Fatal(err)
		}
		_, err := tasks.Update(ctx, admin, project.ID, before.ID, UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&bob.UserID), Description: pointer("Must not save"), Properties: propertyPatch(core.PullRequestProperty{URL: "new", Title: "new"})})
		assertOperational(t, err)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "P1028" || strings.Contains(err.Error(), "private assignment") {
			t.Fatalf("assignment rollback lost its safe error chain: %v", err)
		}
		assertTaskUnchanged(t, tasks, admin, before)
	})
}
