package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func workerDescriptor() taskcore.WorkerDescriptor {
	return taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Build machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
}

func workerMember(t *testing.T, database *postgres.Store, projectID string) model.Principal {
	t.Helper()
	principal := servicePrincipal(t, database)
	if err := writeProjectForTest(database, context.Background(), projectID, func(tx store.ProjectWriteScope) error {
		_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), principal.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return principal
}

func claimableTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, projectID string) model.Task {
	t.Helper()
	created, err := tasks.Create(context.Background(), principal, projectID, taskcore.CreateTask{Title: "Worker task", AssignedTo: &principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	return updateTask(t, tasks, principal, created, taskcore.UpdateTask{AllowAgents: pointer(true)})
}

func claimWorkerTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task, descriptor taskcore.WorkerDescriptor) model.Task {
	t.Helper()
	claimed, err := tasks.ClaimWorker(context.Background(), principal, task.ProjectID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	return claimed
}

func TestWorkerClaimHasOneWinnerAndPreservesTaskData(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	owner := workerMember(t, database, project.ID)
	prerequisite := finishTask(t, tasks, admin, startTask(t, tasks, admin, createTask(t, tasks, admin, project.ID, "Dependency")))
	task := claimableTask(t, tasks, owner, project.ID)
	task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{DependsOn: pointer([]string{prerequisite.ID}), ExternalDependsOn: pointer([]string{prerequisite.ID}), Properties: propertyPatch(model.PullRequestProperty{URL: "opaque\x00\n", Title: "Evidence"}), RequiredPlatform: platformChange(pointer(model.PlatformLinux))})
	a, b := workerDescriptor(), workerDescriptor()
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: a})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: b})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	actual, err := tasks.Get(context.Background(), admin, project.ID, task.ID)
	if err != nil || actual.Status != model.TaskInProgress || actual.Ready || actual.StartedAt == nil || actual.CompletedAt != nil || actual.Version != task.Version+1 {
		t.Fatalf("claim result: %#v, %v", actual, err)
	}
	worker := testWorker(t, actual.Properties)
	if worker == nil || worker.State != model.WorkerActive || worker.Phase != model.WorkerPreparing || worker.Herdr != nil || worker.NativeSessionID != nil || worker.ClaimedAt.IsZero() || worker.ClaimedAt.Before(task.UpdatedAt) {
		t.Fatalf("missing server execution facts: %#v", worker)
	}
	if (worker.ClaimID != a.ClaimID || worker.UserID != owner.UserID) && (worker.ClaimID != b.ClaimID || worker.UserID != owner.UserID) {
		t.Fatal("claim identity does not identify the successful caller")
	}
	preserved := actual
	preserved.Status, preserved.Version, preserved.UpdatedAt, preserved.StartedAt, preserved.Ready = task.Status, task.Version, task.UpdatedAt, task.StartedAt, task.Ready
	preserved.Properties = testWithWorker(t, preserved.Properties, nil)
	if !reflect.DeepEqual(preserved, task) {
		t.Fatal("claim changed unrelated task data")
	}
}

func TestWorkerClaimEligibilityAndPermissionRaces(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	descriptor := workerDescriptor()
	task := createAssignedTask(t, tasks, admin, project.ID, &admin.UserID)
	_, err := tasks.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "invalid_transition")
	task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{AllowAgents: pointer(true), RequiredPlatform: platformChange(pointer(model.PlatformWindows))})
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "invalid_transition")
	task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{RequiredPlatform: platformChange(nil)})
	pre := createTask(t, tasks, admin, project.ID, "Unfinished")
	task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{DependsOn: pointer([]string{pre.ID})})
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "dependency_unsatisfied")
	task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{DependsOn: pointer([]string{})})
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, admin, project.ID, task.ID, taskcore.UpdateTask{Version: task.Version, AllowAgents: pointer(false)})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	after, err := tasks.Get(ctx, admin, project.ID, task.ID)
	if err != nil || (testWorker(t, after.Properties) != nil && !after.AllowAgents) {
		t.Fatalf("permission race admitted a forbidden claim: %#v, %v", after, err)
	}
	active := claimWorkerTask(t, tasks, admin, claimableTask(t, tasks, admin, project.ID), workerDescriptor())
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, active.ID, taskcore.ClaimWorker{Version: active.Version, WorkerDescriptor: workerDescriptor()})
	requireFault(t, err, "invalid_transition")
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "version_conflict")
}

func TestWorkerSessionUpdatesAndClaimBoundCompletion(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), workerDescriptor())
	original := *testWorker(t, task.Properties)
	phase, native := model.WorkerExecuting, "native-session"
	herdr := &model.WorkerHerdr{Session: "w", WorkspaceID: "workspace-1", PaneID: "pane-1"}
	updated, err := tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: original.ClaimID, Phase: &phase, Herdr: &herdr, NativeSessionID: pointer(&native)})
	if err != nil || updated.Version != task.Version+1 || testWorker(t, updated.Properties).Phase != phase || testWorker(t, updated.Properties).NativeSessionID == nil || !reflect.DeepEqual(updated.StartedAt, task.StartedAt) {
		t.Fatalf("session update: %#v, %v", updated, err)
	}
	if got, err := tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: updated.Version, ClaimID: original.ClaimID, Phase: &phase, Herdr: &herdr, NativeSessionID: pointer(&native)}); err != nil || !reflect.DeepEqual(got, updated) {
		t.Fatalf("same-value update mutated execution: %#v, %v", got, err)
	}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: original.ClaimID, Phase: &phase})
	requireFault(t, err, "version_conflict")
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: updated.Version, ClaimID: uuid.NewString(), Phase: &phase})
	requireFault(t, err, "claim_conflict")
	for _, caller := range []model.Principal{other, admin} {
		_, err = tasks.UpdateWorker(ctx, caller, project.ID, task.ID, taskcore.UpdateWorker{Version: updated.Version, ClaimID: original.ClaimID, Phase: &phase})
		requireFault(t, err, "forbidden")
		_, err = tasks.SetStatus(ctx, caller, project.ID, task.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: model.TaskDone, ClaimID: &original.ClaimID})
		requireFault(t, err, "forbidden")
	}
	updated = updateTask(t, tasks, admin, updated, taskcore.UpdateTask{Properties: propertyPatch(model.PullRequestProperty{URL: "PR", Title: "Result"})})
	if testWorker(t, updated.Properties).ClaimID != original.ClaimID || *testWorker(t, updated.Properties).NativeSessionID != native {
		t.Fatal("ordinary property update discarded worker execution")
	}
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: model.TaskDone})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: model.TaskTodo})
	requireFault(t, err, "invalid_transition")
	if got, err := tasks.SetStatus(ctx, other, project.ID, task.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: model.TaskInProgress}); err != nil || !reflect.DeepEqual(got, updated) {
		t.Fatal("same-status no-op changed ownership or timing")
	}
	var noHerdr *model.WorkerHerdr
	var noNative *string
	updated, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: updated.Version, ClaimID: original.ClaimID, Herdr: &noHerdr, NativeSessionID: &noNative})
	if err != nil || testWorker(t, updated.Properties).Herdr != nil || testWorker(t, updated.Properties).NativeSessionID != nil {
		t.Fatal("nullable session update was lost")
	}
	completed, err := tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: model.TaskDone, ClaimID: &original.ClaimID})
	if err != nil || testWorker(t, completed.Properties).State != model.WorkerCompleted || completed.CompletedAt == nil || !reflect.DeepEqual(completed.StartedAt, task.StartedAt) {
		t.Fatalf("worker completion: %#v, %v", completed, err)
	}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: completed.Version, ClaimID: original.ClaimID, Phase: &phase})
	requireFault(t, err, "claim_conflict")
	reopened, err := tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: completed.Version, Status: model.TaskInProgress})
	if err != nil || testWorker(t, reopened.Properties).State != model.WorkerCompleted || reopened.CompletedAt != nil {
		t.Fatal("reopening reactivated historical worker ownership")
	}
}

func TestWorkerReleaseAndManualResumeCreateFreshExecution(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	descriptor := workerDescriptor()
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	resource := &model.WorkerHerdr{Session: "w", WorkspaceID: "source-workspace", PaneID: "source-pane"}
	task, err := tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: descriptor.ClaimID, Herdr: &resource, NativeSessionID: pointer(pointer("source-native"))})
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []taskcore.ReleaseWorker{{Version: task.Version, ClaimID: descriptor.ClaimID}, {Version: task.Version, ClaimID: "invalid", StoppedConfirmed: true}} {
		_, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, input)
		requireFault(t, err, "invalid_input")
	}
	_, err = tasks.ReleaseWorker(ctx, other, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	requireFault(t, err, "forbidden")
	released, err := tasks.ReleaseWorker(ctx, admin, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil || released.Status != model.TaskTodo || released.StartedAt != nil || released.CompletedAt != nil || testWorker(t, released.Properties).State != model.WorkerReleased || testWorker(t, released.Properties).WorktreeID != descriptor.WorktreeID || !released.AllowAgents {
		t.Fatalf("release: %#v, %v", released, err)
	}
	for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
		_, err := tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: released.Version, Status: status})
		requireFault(t, err, "invalid_transition")
	}
	_, err = tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, WorktreeID: descriptor.WorktreeID}})
	requireFault(t, err, "invalid_transition")
	_, err = tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "claim_conflict")
	released = updateTask(t, tasks, admin, released, taskcore.UpdateTask{AllowAgents: pointer(false), RequiredPlatform: platformChange(pointer(model.PlatformWindows))})
	next := workerDescriptor()
	next.Agent = model.AgentCopilot
	resume := taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID}
	_, err = tasks.ResumeWorker(ctx, other, project.ID, task.ID, resume)
	requireFault(t, err, "forbidden")
	_, err = tasks.ResumeWorker(ctx, owner, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: resume.ClaimWorker, PreviousClaimID: uuid.NewString()})
	requireFault(t, err, "claim_conflict")
	resumed, err := tasks.ResumeWorker(ctx, owner, project.ID, task.ID, resume)
	if err != nil || resumed.Status != model.TaskInProgress || resumed.AllowAgents || testWorker(t, resumed.Properties).ClaimID != next.ClaimID || testWorker(t, resumed.Properties).Platform != model.PlatformLinux || testWorker(t, resumed.Properties).WorktreeID != next.WorktreeID || testWorker(t, resumed.Properties).Agent != model.AgentCopilot || testWorker(t, resumed.Properties).Herdr != nil || testWorker(t, resumed.Properties).NativeSessionID != nil || resumed.StartedAt == nil || !resumed.StartedAt.After(*task.StartedAt) {
		t.Fatalf("explicit manual resume did not preserve manual permission/platform semantics: %#v, %v", resumed, err)
	}
	_, err = tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: resumed.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: resumed.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: resumed.Version, ClaimID: descriptor.ClaimID})
	requireFault(t, err, "claim_conflict")
	manual := createTask(t, tasks, admin, project.ID, "Ordinary manual task")
	manual = updateTask(t, tasks, admin, manual, taskcore.UpdateTask{RequiredPlatform: platformChange(pointer(model.PlatformWindows))})
	manual = startTask(t, tasks, owner, manual)
	manual = finishTask(t, tasks, owner, manual)
	if manual.AllowAgents || testWorker(t, manual.Properties) != nil {
		t.Fatal("ordinary manual lifecycle unexpectedly became worker-managed")
	}
}

func TestWorkerWithdrawalResetsClaimAndDisablesAutomation(t *testing.T) {
	for _, state := range []model.WorkerState{model.WorkerActive, model.WorkerReleased} {
		for _, operator := range []string{"owner", "administrator"} {
			t.Run(string(state)+"/"+operator, func(t *testing.T) {
				tasks, database, project, _, admin := taskService(t)
				ctx := context.Background()
				owner, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
				descriptor := workerDescriptor()
				dependency := finishTask(t, tasks, admin, startTask(t, tasks, admin, createTask(t, tasks, admin, project.ID, "Prerequisite")))
				candidate := updateTask(t, tasks, admin, claimableTask(t, tasks, owner, project.ID), taskcore.UpdateTask{RequiredPlatform: platformChange(pointer(model.PlatformLinux)), DependsOn: pointer([]string{dependency.ID}), ExternalDependsOn: pointer([]string{dependency.ID}), Properties: propertyPatch(model.PullRequestProperty{URL: "opaque\x00", Title: "Evidence"})})
				task := claimWorkerTask(t, tasks, owner, candidate, descriptor)
				if state == model.WorkerReleased {
					var err error
					task, err = tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
					if err != nil {
						t.Fatal(err)
					}
				}
				input := taskcore.WithdrawWorker{Version: task.Version, ClaimID: descriptor.ClaimID}
				_, err := tasks.WithdrawWorker(ctx, other, project.ID, task.ID, input)
				requireFault(t, err, "forbidden")
				_, err = tasks.WithdrawWorker(ctx, servicePrincipal(t, database), project.ID, task.ID, input)
				requireFault(t, err, "not_found")
				_, err = tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version - 1, ClaimID: descriptor.ClaimID})
				requireFault(t, err, "version_conflict")
				_, err = tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: uuid.NewString()})
				requireFault(t, err, "claim_conflict")
				assertTaskUnchanged(t, tasks, admin, task)
				caller := owner
				if operator == "administrator" {
					caller = admin
				}
				withdrawn, err := tasks.WithdrawWorker(ctx, caller, project.ID, task.ID, input)
				if err != nil || withdrawn.Status != model.TaskTodo || withdrawn.AllowAgents || testWorker(t, withdrawn.Properties) != nil || withdrawn.StartedAt != nil || withdrawn.CompletedAt != nil || withdrawn.Version != task.Version+1 || !withdrawn.UpdatedAt.After(task.UpdatedAt) {
					t.Fatalf("withdrawal did not atomically reset execution: %#v, %v", withdrawn, err)
				}
				preserved := withdrawn
				preserved.Status, preserved.AllowAgents = task.Status, task.AllowAgents
				preserved.Properties = testWithWorker(t, preserved.Properties, testWorker(t, task.Properties))
				preserved.StartedAt, preserved.CompletedAt, preserved.UpdatedAt, preserved.Version, preserved.Ready = task.StartedAt, task.CompletedAt, task.UpdatedAt, task.Version, task.Ready
				if !reflect.DeepEqual(preserved, task) {
					t.Fatal("withdrawal changed unrelated task data")
				}
				_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: withdrawn.Version, ClaimID: descriptor.ClaimID, Phase: pointer(model.WorkerExecuting)})
				requireFault(t, err, "claim_conflict")
				_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: withdrawn.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
				requireFault(t, err, "claim_conflict")
				_, err = tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: withdrawn.Version, WorkerDescriptor: workerDescriptor()})
				requireFault(t, err, "invalid_transition")
				started := startTask(t, tasks, owner, withdrawn)
				if testWorker(t, started.Properties) != nil {
					t.Fatal("manual execution retained withdrawn ownership")
				}
			})
		}
	}
}

func TestWorkerWithdrawalRequiresAnUnfinishedClaim(t *testing.T) {
	tasks, _, project, _, owner := taskService(t)
	ctx := context.Background()
	task := claimableTask(t, tasks, owner, project.ID)
	_, err := tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: uuid.NewString()})
	requireFault(t, err, "claim_conflict")
	task = claimWorkerTask(t, tasks, owner, task, workerDescriptor())
	claimID := testWorker(t, task.Properties).ClaimID
	task, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: &claimID})
	if err != nil {
		t.Fatal(err)
	}
	_, err = tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: claimID})
	requireFault(t, err, "claim_conflict")
	assertTaskUnchanged(t, tasks, owner, task)
}

func TestWorkerOperationsRejectInvalidInputsAndMissingResources(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	task := claimableTask(t, tasks, admin, project.ID)
	base := workerDescriptor()
	for name, change := range map[string]func(*taskcore.WorkerDescriptor){
		"claim": func(d *taskcore.WorkerDescriptor) { d.ClaimID = "bad" }, "worker": func(d *taskcore.WorkerDescriptor) { d.WorkerID = "bad" },
		"machine": func(d *taskcore.WorkerDescriptor) { d.Machine.ID = "bad" }, "worktree": func(d *taskcore.WorkerDescriptor) { d.WorktreeID = "bad" },
		"platform": func(d *taskcore.WorkerDescriptor) { d.Platform = "darwin" }, "agent": func(d *taskcore.WorkerDescriptor) { d.Agent = "other" },
		"machine name": func(d *taskcore.WorkerDescriptor) { d.Machine.Name = "\x00" },
	} {
		t.Run(name, func(t *testing.T) {
			input := base
			change(&input)
			_, err := tasks.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: input})
			requireFault(t, err, "invalid_input")
		})
	}
	for _, invoke := range []func() error{
		func() error {
			_, err := tasks.ClaimWorker(ctx, model.Principal{}, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.ClaimWorker(ctx, admin, "bad", task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.ClaimWorker(ctx, admin, project.ID, "bad", taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: 0, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: "bad"})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: base.ClaimID})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: base.ClaimID, Phase: pointer(model.WorkerPhase("invalid"))})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: base.ClaimID, Herdr: pointer(&model.WorkerHerdr{})})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, taskcore.UpdateWorker{Version: task.Version, ClaimID: base.ClaimID, NativeSessionID: pointer(pointer(" "))})
			return err
		},
		func() error {
			_, err := tasks.ResumeWorker(ctx, admin, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: base}, PreviousClaimID: "bad"})
			return err
		},
		func() error {
			_, err := tasks.WithdrawWorker(ctx, admin, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: "bad"})
			return err
		},
		func() error {
			_, err := tasks.Create(ctx, admin, project.ID, taskcore.CreateTask{Title: "Forbidden", Properties: model.TaskProperties{"worker": propertyJSON(map[string]any{})}})
			return err
		},
		func() error {
			_, err := tasks.SetStatus(ctx, admin, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskInProgress, ClaimID: &base.ClaimID})
			return err
		},
		func() error {
			_, err := tasks.SetStatus(ctx, admin, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: pointer("bad")})
			return err
		},
	} {
		if invoke() == nil {
			t.Fatal("invalid worker input was accepted")
		}
	}
	_, err := tasks.ClaimWorker(ctx, admin, project.ID, uuid.NewString(), taskcore.ClaimWorker{Version: 1, WorkerDescriptor: base})
	requireFault(t, err, "not_found")
	_, err = tasks.ClaimWorker(ctx, admin, uuid.NewString(), task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: base})
	requireFault(t, err, "not_found")
	outsider := servicePrincipal(t, database)
	_, err = tasks.ClaimWorker(ctx, outsider, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: base})
	requireFault(t, err, "not_found")
	_, err = tasks.SetStatus(ctx, admin, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: &base.ClaimID})
	requireFault(t, err, "claim_conflict")
}

func TestWorkerClaimRechecksMembershipAndRollsBackUnknownWrites(t *testing.T) {
	tasks, database, project, databaseURL, admin := taskService(t)
	ctx := context.Background()
	member := workerMember(t, database, project.ID)
	task := claimableTask(t, tasks, member, project.ID)
	descriptor := workerDescriptor()
	result := make(chan taskResult, 1)
	lockContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := writeProjectForTest(database, lockContext, project.ID, func(tx store.ProjectWriteScope) error {
		go func() {
			claimed, err := tasks.ClaimWorker(lockContext, member, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
			result <- taskResult{task: claimed, err: err}
		}()
		waitForTaskWriters(t, lockContext, database, 1)
		return tx.ProjectDAO().RemoveMember(lockContext, member.UserID)
	}); err != nil {
		t.Fatal(err)
	}
	requireFault(t, receiveTaskResult(t, lockContext, result).err, "not_found")
	assertTaskUnchanged(t, tasks, admin, task)
	task = claimableTask(t, tasks, admin, project.ID)
	for _, fragment := range []string{"SELECT statement_timestamp()", "UPDATE tasks SET"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel})
			_, err := traced.ClaimWorker(ctx, admin, project.ID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("claim lost cancellation cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, admin, task)
		})
	}
}

func TestWorkerAutomaticReclaimCreatesFreshResourcesAndKeepsEligibility(t *testing.T) {
	tasks, _, project, _, owner := taskService(t)
	ctx := context.Background()
	descriptor := workerDescriptor()
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	released, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	next := workerDescriptor()
	next.Agent = model.AgentCopilot
	for _, reused := range []taskcore.WorkerDescriptor{descriptor, {ClaimID: next.ClaimID, WorkerID: next.WorkerID, Machine: next.Machine, Platform: next.Platform, Agent: next.Agent, WorktreeID: descriptor.WorktreeID}} {
		_, err := tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: reused})
		if reused.ClaimID == descriptor.ClaimID {
			requireFault(t, err, "claim_conflict")
		} else {
			requireFault(t, err, "invalid_transition")
		}
		assertTaskUnchanged(t, tasks, owner, released)
	}
	resumed, err := tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: next})
	if err != nil || testWorker(t, resumed.Properties).ClaimID != next.ClaimID || testWorker(t, resumed.Properties).WorktreeID != next.WorktreeID || testWorker(t, resumed.Properties).Agent != model.AgentCopilot || testWorker(t, resumed.Properties).Herdr != nil || testWorker(t, resumed.Properties).NativeSessionID != nil {
		t.Fatalf("new automatic execution did not start with fresh resources: %#v, %v", resumed, err)
	}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, taskcore.UpdateWorker{Version: resumed.Version, ClaimID: descriptor.ClaimID, Phase: pointer(model.WorkerExecuting)})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: resumed.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: resumed.Version, ClaimID: descriptor.ClaimID})
	requireFault(t, err, "claim_conflict")
	released, err = tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: resumed.Version, ClaimID: next.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, update := range []taskcore.UpdateTask{{AllowAgents: pointer(false)}, {AllowAgents: pointer(true), RequiredPlatform: platformChange(pointer(model.PlatformWindows))}} {
		released = updateTask(t, tasks, owner, released, update)
		_, err := tasks.ClaimWorker(ctx, owner, project.ID, task.ID, taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: workerDescriptor()})
		requireFault(t, err, "invalid_transition")
		assertTaskUnchanged(t, tasks, owner, released)
	}
}

func TestWorkerManagementRacesKeepOneDecision(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner := workerMember(t, database, project.ID)
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), workerDescriptor())
	claimID := testWorker(t, task.Properties).ClaimID
	assertOneTaskWinner(t, competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: claimID})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.WithdrawWorker(ctx, admin, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: claimID})
		}), "version_conflict")
	withdrawn, err := tasks.Get(ctx, admin, project.ID, task.ID)
	if err != nil || testWorker(t, withdrawn.Properties) != nil || withdrawn.AllowAgents || withdrawn.Status != model.TaskTodo || withdrawn.StartedAt != nil || withdrawn.CompletedAt != nil {
		t.Fatalf("withdrawal race left partial execution state: %#v, %v", withdrawn, err)
	}
	task = claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), workerDescriptor())
	released, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	resume := func(descriptor taskcore.WorkerDescriptor) func(context.Context) (model.Task, error) {
		return func(ctx context.Context) (model.Task, error) {
			return tasks.ResumeWorker(ctx, admin, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: descriptor}, PreviousClaimID: testWorker(t, released.Properties).ClaimID})
		}
	}
	assertOneTaskWinner(t, competeTaskWrites(t, database, project.ID, resume(workerDescriptor()), resume(workerDescriptor())), "version_conflict")
	resumed, err := tasks.Get(ctx, admin, project.ID, task.ID)
	if err != nil || testWorker(t, resumed.Properties).UserID != admin.UserID || testWorker(t, resumed.Properties).WorktreeID == testWorker(t, released.Properties).WorktreeID || resumed.StartedAt == nil || !resumed.StartedAt.After(*task.StartedAt) {
		t.Fatalf("resume race lost caller ownership, new resources or timing: %#v %v", resumed, err)
	}
}

func TestWorkerManagementRollsBackCanceledWrites(t *testing.T) {
	tasks, _, project, databaseURL, owner := taskService(t)
	ctx := context.Background()
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), workerDescriptor())
	for _, operation := range []string{"release", "withdraw", "resume"} {
		if operation == "resume" {
			var err error
			task, err = tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID, StoppedConfirmed: true})
			if err != nil {
				t.Fatal(err)
			}
		}
		for _, fragment := range []string{"SELECT statement_timestamp()", "UPDATE tasks SET"} {
			if operation != "resume" && fragment == "SELECT statement_timestamp()" {
				continue
			}
			t.Run(operation+"/"+fragment, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel})
				descriptor := workerDescriptor()
				var err error
				switch operation {
				case "release":
					_, err = traced.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID, StoppedConfirmed: true})
				case "withdraw":
					_, err = traced.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID})
				case "resume":
					_, err = traced.ResumeWorker(ctx, owner, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor}, PreviousClaimID: testWorker(t, task.Properties).ClaimID})
				}
				assertOperational(t, err)
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("management lost cancellation cause: %v", err)
				}
				assertTaskUnchanged(t, tasks, owner, task)
			})
		}
	}
}

func TestWorkerManagementRechecksOperatorMembership(t *testing.T) {
	for _, operation := range []string{"release", "withdraw", "resume"} {
		for _, permission := range []string{"removed owner", "demoted administrator"} {
			t.Run(operation+"/"+permission, func(t *testing.T) {
				tasks, database, project, _, admin := taskService(t)
				ctx := context.Background()
				owner, manager := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
				if err := writeProjectForTest(database, ctx, project.ID, func(tx store.ProjectWriteScope) error {
					_, err := tx.ProjectDAO().SetMemberRole(ctx, manager.UserID, model.ProjectAdmin)
					return err
				}); err != nil {
					t.Fatal(err)
				}
				task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), workerDescriptor())
				if operation == "resume" {
					var err error
					task, err = tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID, StoppedConfirmed: true})
					if err != nil {
						t.Fatal(err)
					}
				}
				caller := owner
				if permission == "demoted administrator" {
					caller = manager
				}
				result := make(chan taskResult, 1)
				lockContext, cancel := context.WithTimeout(ctx, 10*time.Second)
				defer cancel()
				if err := writeProjectForTest(database, lockContext, project.ID, func(tx store.ProjectWriteScope) error {
					go func() {
						descriptor := workerDescriptor()
						var actual model.Task
						var err error
						switch operation {
						case "release":
							actual, err = tasks.ReleaseWorker(lockContext, caller, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID, StoppedConfirmed: true})
						case "withdraw":
							actual, err = tasks.WithdrawWorker(lockContext, caller, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID})
						case "resume":
							actual, err = tasks.ResumeWorker(lockContext, caller, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor}, PreviousClaimID: testWorker(t, task.Properties).ClaimID})
						}
						result <- taskResult{task: actual, err: err}
					}()
					waitForTaskWriters(t, lockContext, database, 1)
					switch permission {
					case "removed owner":
						return tx.ProjectDAO().RemoveMember(lockContext, owner.UserID)
					default:
						_, err := tx.ProjectDAO().SetMemberRole(lockContext, manager.UserID, model.ProjectMemberRole)
						return err
					}
				}); err != nil {
					t.Fatal(err)
				}
				want := map[string]string{"removed owner": "not_found", "demoted administrator": "forbidden"}[permission]
				requireFault(t, receiveTaskResult(t, lockContext, result).err, want)
				assertTaskUnchanged(t, tasks, admin, task)
			})
		}
	}
}

func TestWorkerManualResumeRetainsDependencyProtection(t *testing.T) {
	tasks, _, project, _, owner := taskService(t)
	ctx := context.Background()
	prerequisite := finishTask(t, tasks, owner, startTask(t, tasks, owner, createTask(t, tasks, owner, project.ID, "Prerequisite")))
	task := updateTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), taskcore.UpdateTask{DependsOn: pointer([]string{prerequisite.ID})})
	task = claimWorkerTask(t, tasks, owner, task, workerDescriptor())
	released, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, taskcore.ReleaseWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	setStatusTask(t, tasks, owner, prerequisite, model.TaskTodo)
	released, err = tasks.Get(ctx, owner, project.ID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tasks.ResumeWorker(ctx, owner, project.ID, task.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: workerDescriptor()}, PreviousClaimID: testWorker(t, released.Properties).ClaimID})
	requireFault(t, err, "dependency_unsatisfied")
	assertTaskUnchanged(t, tasks, owner, released)
}

func TestWorkerWithdrawalRollsBackPartialDatabaseFailure(t *testing.T) {
	tasks, database, project, _, owner := taskService(t)
	ctx := context.Background()
	prerequisite := finishTask(t, tasks, owner, createTask(t, tasks, owner, project.ID, "Completed prerequisite"))
	task := updateTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), taskcore.UpdateTask{DependsOn: pointer([]string{prerequisite.ID})})
	task = claimWorkerTask(t, tasks, owner, task, workerDescriptor())
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_withdrawal_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'private withdrawal edge diagnostic'; END $$;
		CREATE TRIGGER reject_withdrawal_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_edge()`); err != nil {
		t.Fatal(err)
	}
	_, err := tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: testWorker(t, task.Properties).ClaimID})
	assertOperational(t, err)
	if errors.Unwrap(err) == nil || strings.Contains(err.Error(), "private withdrawal edge") {
		t.Fatalf("withdrawal lost its error chain or exposed private diagnostics: %v", err)
	}
	assertTaskUnchanged(t, tasks, owner, task)
}

func TestWorkerWithdrawalAndCompletionRaceKeepsOneOutcome(t *testing.T) {
	tasks, database, project, _, owner := taskService(t)
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), workerDescriptor())
	claimID := testWorker(t, task.Properties).ClaimID
	assertOneTaskWinner(t, competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.WithdrawWorker(ctx, owner, project.ID, task.ID, taskcore.WithdrawWorker{Version: task.Version, ClaimID: claimID})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: &claimID})
		}), "version_conflict")
	actual, err := tasks.Get(context.Background(), owner, project.ID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if actual.Status == model.TaskTodo {
		if testWorker(t, actual.Properties) != nil || actual.AllowAgents || actual.StartedAt != nil || actual.CompletedAt != nil {
			t.Fatal("withdrawal committed a partial reset")
		}
	} else if actual.Status != model.TaskDone || testWorker(t, actual.Properties) == nil || testWorker(t, actual.Properties).State != model.WorkerCompleted || !actual.AllowAgents || actual.StartedAt == nil || actual.CompletedAt == nil {
		t.Fatalf("completion race committed mixed outcomes: %#v", actual)
	}
}
