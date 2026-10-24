package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func workerDescriptor() WorkerDescriptor {
	return WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: core.WorkerMachine{ID: uuid.NewString(), Name: "Build machine"}, Platform: core.PlatformLinux, Agent: core.AgentCodex, WorktreeID: uuid.NewString()}
}

func workerMember(t *testing.T, database *store.Store, projectID string) core.Principal {
	t.Helper()
	principal := servicePrincipal(t, database)
	if err := database.WriteProject(context.Background(), projectID, func(tx *store.ProjectTx) error {
		_, err := tx.AddInvitedMember(context.Background(), principal.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return principal
}

func claimableTask(t *testing.T, tasks *Tasks, principal core.Principal, projectID string) core.Task {
	t.Helper()
	return updateTask(t, tasks, principal, createTask(t, tasks, principal, projectID, "Worker task"), UpdateTask{AllowAgents: pointer(true)})
}

func claimWorkerTask(t *testing.T, tasks *Tasks, principal core.Principal, task core.Task, descriptor WorkerDescriptor) core.Task {
	t.Helper()
	claimed, err := tasks.ClaimWorker(context.Background(), principal, task.ProjectID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	return claimed
}

func TestWorkerClaimHasOneWinnerAndPreservesTaskData(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	first, second := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	prerequisite := finishTask(t, tasks, admin, startTask(t, tasks, admin, createTask(t, tasks, admin, project.ID, "Dependency")))
	task := claimableTask(t, tasks, admin, project.ID)
	task = updateTask(t, tasks, admin, task, UpdateTask{DependsOn: pointer([]string{prerequisite.ID}), ExternalDependsOn: pointer([]string{prerequisite.ID}), Properties: propertyPatch(core.PullRequestProperty{URL: "opaque\x00\n", Title: "Evidence"}), RequiredPlatform: platformChange(pointer(core.PlatformLinux))})
	a, b := workerDescriptor(), workerDescriptor()
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return tasks.ClaimWorker(ctx, first, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: a})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.ClaimWorker(ctx, second, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: b})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	actual, err := tasks.Get(context.Background(), admin, project.ID, task.ID)
	if err != nil || actual.Status != core.TaskInProgress || actual.Ready || actual.StartedAt == nil || actual.CompletedAt != nil || actual.Version != task.Version+1 {
		t.Fatalf("claim result: %#v, %v", actual, err)
	}
	worker := actual.Properties.Worker
	if worker == nil || worker.State != core.WorkerActive || worker.Phase != core.WorkerPreparing || worker.Herdr != nil || worker.NativeSessionID != nil || worker.ClaimedAt.IsZero() || worker.ClaimedAt.Before(task.UpdatedAt) {
		t.Fatalf("missing server execution facts: %#v", worker)
	}
	if (worker.ClaimID != a.ClaimID || worker.UserID != first.UserID) && (worker.ClaimID != b.ClaimID || worker.UserID != second.UserID) {
		t.Fatal("claim identity does not identify the successful caller")
	}
	preserved := actual
	preserved.Status, preserved.Version, preserved.UpdatedAt, preserved.StartedAt, preserved.Ready, preserved.Properties.Worker = task.Status, task.Version, task.UpdatedAt, task.StartedAt, task.Ready, nil
	if !reflect.DeepEqual(preserved, task) {
		t.Fatal("claim changed unrelated task data")
	}
}

func TestWorkerClaimEligibilityAndPermissionRaces(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	descriptor := workerDescriptor()
	task := createTask(t, tasks, admin, project.ID, "Manual only")
	_, err := tasks.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "invalid_transition")
	task = updateTask(t, tasks, admin, task, UpdateTask{AllowAgents: pointer(true), RequiredPlatform: platformChange(pointer(core.PlatformWindows))})
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "invalid_transition")
	task = updateTask(t, tasks, admin, task, UpdateTask{RequiredPlatform: platformChange(nil)})
	pre := createTask(t, tasks, admin, project.ID, "Unfinished")
	task = updateTask(t, tasks, admin, task, UpdateTask{DependsOn: pointer([]string{pre.ID})})
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "dependency_unsatisfied")
	task = updateTask(t, tasks, admin, task, UpdateTask{DependsOn: pointer([]string{})})
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return tasks.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.Update(ctx, admin, project.ID, task.ID, UpdateTask{Version: task.Version, AllowAgents: pointer(false)})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	after, err := tasks.Get(ctx, admin, project.ID, task.ID)
	if err != nil || (after.Properties.Worker != nil && !after.AllowAgents) {
		t.Fatalf("permission race admitted a forbidden claim: %#v, %v", after, err)
	}
	active := claimWorkerTask(t, tasks, admin, claimableTask(t, tasks, admin, project.ID), workerDescriptor())
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, active.ID, ClaimWorker{Version: active.Version, WorkerDescriptor: workerDescriptor()})
	requireFault(t, err, "invalid_transition")
	_, err = tasks.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "version_conflict")
}

func TestWorkerSessionUpdatesAndClaimBoundCompletion(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, admin, project.ID), workerDescriptor())
	original := *task.Properties.Worker
	phase, native := core.WorkerExecuting, "native-session"
	herdr := &core.WorkerHerdr{Session: "w", WorkspaceID: "workspace-1", PaneID: "pane-1"}
	updated, err := tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: original.ClaimID, Phase: &phase, Herdr: &herdr, NativeSessionID: pointer(&native)})
	if err != nil || updated.Version != task.Version+1 || updated.Properties.Worker.Phase != phase || updated.Properties.Worker.NativeSessionID == nil || !reflect.DeepEqual(updated.StartedAt, task.StartedAt) {
		t.Fatalf("session update: %#v, %v", updated, err)
	}
	if got, err := tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: updated.Version, ClaimID: original.ClaimID, Phase: &phase, Herdr: &herdr, NativeSessionID: pointer(&native)}); err != nil || !reflect.DeepEqual(got, updated) {
		t.Fatalf("same-value update mutated execution: %#v, %v", got, err)
	}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: original.ClaimID, Phase: &phase})
	requireFault(t, err, "version_conflict")
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: updated.Version, ClaimID: uuid.NewString(), Phase: &phase})
	requireFault(t, err, "claim_conflict")
	for _, caller := range []core.Principal{other, admin} {
		_, err = tasks.UpdateWorker(ctx, caller, project.ID, task.ID, UpdateWorker{Version: updated.Version, ClaimID: original.ClaimID, Phase: &phase})
		requireFault(t, err, "forbidden")
		_, err = tasks.SetStatus(ctx, caller, project.ID, task.ID, SetTaskStatus{Version: updated.Version, Status: core.TaskDone, ClaimID: &original.ClaimID})
		requireFault(t, err, "forbidden")
	}
	updated = updateTask(t, tasks, admin, updated, UpdateTask{Properties: propertyPatch(core.PullRequestProperty{URL: "PR", Title: "Result"})})
	if updated.Properties.Worker.ClaimID != original.ClaimID || *updated.Properties.Worker.NativeSessionID != native {
		t.Fatal("ordinary property update discarded worker execution")
	}
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: updated.Version, Status: core.TaskDone})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: updated.Version, Status: core.TaskTodo})
	requireFault(t, err, "invalid_transition")
	if got, err := tasks.SetStatus(ctx, other, project.ID, task.ID, SetTaskStatus{Version: updated.Version, Status: core.TaskInProgress}); err != nil || !reflect.DeepEqual(got, updated) {
		t.Fatal("same-status no-op changed ownership or timing")
	}
	var noHerdr *core.WorkerHerdr
	var noNative *string
	updated, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: updated.Version, ClaimID: original.ClaimID, Herdr: &noHerdr, NativeSessionID: &noNative})
	if err != nil || updated.Properties.Worker.Herdr != nil || updated.Properties.Worker.NativeSessionID != nil {
		t.Fatal("nullable session update was lost")
	}
	completed, err := tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: updated.Version, Status: core.TaskDone, ClaimID: &original.ClaimID})
	if err != nil || completed.Properties.Worker.State != core.WorkerCompleted || completed.CompletedAt == nil || !reflect.DeepEqual(completed.StartedAt, task.StartedAt) {
		t.Fatalf("worker completion: %#v, %v", completed, err)
	}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: completed.Version, ClaimID: original.ClaimID, Phase: &phase})
	requireFault(t, err, "claim_conflict")
	reopened, err := tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: completed.Version, Status: core.TaskInProgress})
	if err != nil || reopened.Properties.Worker.State != core.WorkerCompleted || reopened.CompletedAt != nil {
		t.Fatal("reopening reactivated historical worker ownership")
	}
}

func TestWorkerReleaseAndManualResumePreserveContinuity(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	descriptor := workerDescriptor()
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, admin, project.ID), descriptor)
	for _, input := range []ReleaseWorker{{Version: task.Version, ClaimID: descriptor.ClaimID}, {Version: task.Version, ClaimID: "invalid", StoppedConfirmed: true}} {
		_, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, input)
		requireFault(t, err, "invalid_input")
	}
	_, err := tasks.ReleaseWorker(ctx, other, project.ID, task.ID, ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	requireFault(t, err, "forbidden")
	released, err := tasks.ReleaseWorker(ctx, admin, project.ID, task.ID, ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil || released.Status != core.TaskTodo || released.StartedAt != nil || released.CompletedAt != nil || released.Properties.Worker.State != core.WorkerReleased || released.Properties.Worker.WorktreeID != descriptor.WorktreeID || !released.AllowAgents {
		t.Fatalf("release: %#v, %v", released, err)
	}
	for _, status := range []core.TaskStatus{core.TaskInProgress, core.TaskDone} {
		_, err := tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: released.Version, Status: status})
		requireFault(t, err, "invalid_transition")
	}
	_, err = tasks.ClaimWorker(ctx, owner, project.ID, task.ID, ClaimWorker{Version: released.Version, WorkerDescriptor: workerDescriptor(), ContinuityConfirmed: true})
	requireFault(t, err, "invalid_transition")
	_, err = tasks.ClaimWorker(ctx, owner, project.ID, task.ID, ClaimWorker{Version: released.Version, WorkerDescriptor: descriptor, ContinuityConfirmed: true})
	requireFault(t, err, "claim_conflict")
	released = updateTask(t, tasks, admin, released, UpdateTask{AllowAgents: pointer(false), RequiredPlatform: platformChange(pointer(core.PlatformWindows))})
	next := descriptor
	next.ClaimID, next.WorkerID = uuid.NewString(), uuid.NewString()
	resume := ResumeWorker{ClaimWorker: ClaimWorker{Version: released.Version, WorkerDescriptor: next, ContinuityConfirmed: true}, PreviousClaimID: descriptor.ClaimID}
	_, err = tasks.ResumeWorker(ctx, other, project.ID, task.ID, resume)
	requireFault(t, err, "forbidden")
	_, err = tasks.ResumeWorker(ctx, owner, project.ID, task.ID, ResumeWorker{ClaimWorker: resume.ClaimWorker, PreviousClaimID: uuid.NewString()})
	requireFault(t, err, "claim_conflict")
	resumed, err := tasks.ResumeWorker(ctx, owner, project.ID, task.ID, resume)
	if err != nil || resumed.Status != core.TaskInProgress || resumed.AllowAgents || resumed.Properties.Worker.ClaimID != next.ClaimID || resumed.Properties.Worker.Platform != core.PlatformLinux || resumed.StartedAt == nil || !resumed.StartedAt.After(*task.StartedAt) {
		t.Fatalf("explicit manual resume did not preserve manual permission/platform semantics: %#v, %v", resumed, err)
	}
	_, err = tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, ReleaseWorker{Version: resumed.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: resumed.Version, Status: core.TaskDone, ClaimID: &descriptor.ClaimID})
	requireFault(t, err, "claim_conflict")
	manual := createTask(t, tasks, admin, project.ID, "Ordinary manual task")
	manual = updateTask(t, tasks, admin, manual, UpdateTask{RequiredPlatform: platformChange(pointer(core.PlatformWindows))})
	manual = startTask(t, tasks, owner, manual)
	manual = finishTask(t, tasks, owner, manual)
	if manual.AllowAgents || manual.Properties.Worker != nil {
		t.Fatal("ordinary manual lifecycle unexpectedly became worker-managed")
	}
}

func TestWorkerTransferReplacesOwnerAndRetainsExecutionInterval(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner, target, other := workerMember(t, database, project.ID), workerMember(t, database, project.ID), workerMember(t, database, project.ID)
	descriptor := workerDescriptor()
	candidate := updateTask(t, tasks, admin, claimableTask(t, tasks, admin, project.ID), UpdateTask{RequiredPlatform: platformChange(pointer(core.PlatformLinux))})
	task := claimWorkerTask(t, tasks, owner, candidate, descriptor)
	next := workerDescriptor()
	input := TransferWorker{Version: task.Version, ClaimID: descriptor.ClaimID, NewClaimID: next.ClaimID, Target: WorkerTarget{UserID: target.UserID, WorkerID: next.WorkerID, Machine: next.Machine, Platform: next.Platform, Agent: next.Agent}, WorktreeID: descriptor.WorktreeID, StoppedConfirmed: true, ContinuityConfirmed: true}
	_, err := tasks.TransferWorker(ctx, target, project.ID, task.ID, input)
	requireFault(t, err, "forbidden")
	_, err = tasks.TransferWorker(ctx, other, project.ID, task.ID, input)
	requireFault(t, err, "forbidden")
	for name, change := range map[string]func(*TransferWorker){
		"unknown target": func(value *TransferWorker) { value.Target.UserID = uuid.NewString() },
		"worktree":       func(value *TransferWorker) { value.WorktreeID = uuid.NewString() },
		"agent":          func(value *TransferWorker) { value.Target.Agent = core.AgentCopilot },
		"reused ID":      func(value *TransferWorker) { value.NewClaimID = descriptor.ClaimID },
	} {
		t.Run(name, func(t *testing.T) {
			invalid := input
			change(&invalid)
			_, err := tasks.TransferWorker(ctx, owner, project.ID, task.ID, invalid)
			if name == "unknown target" {
				requireFault(t, err, "invalid_input")
			} else {
				requireFault(t, err, "invalid_transition")
			}
			assertTaskUnchanged(t, tasks, admin, task)
		})
	}
	for name, change := range map[string]func(*TransferWorker){
		"invalid target UUID":    func(value *TransferWorker) { value.Target.UserID = "invalid" },
		"invalid new claim UUID": func(value *TransferWorker) { value.NewClaimID = "invalid" },
		"unconfirmed stop":       func(value *TransferWorker) { value.StoppedConfirmed = false },
		"unconfirmed continuity": func(value *TransferWorker) { value.ContinuityConfirmed = false },
		"different claim":        func(value *TransferWorker) { value.ClaimID = uuid.NewString() },
		"incompatible platform":  func(value *TransferWorker) { value.Target.Platform = core.PlatformWindows },
	} {
		t.Run(name, func(t *testing.T) {
			invalid := input
			change(&invalid)
			_, err := tasks.TransferWorker(ctx, owner, project.ID, task.ID, invalid)
			switch name {
			case "different claim":
				requireFault(t, err, "claim_conflict")
			case "incompatible platform":
				requireFault(t, err, "invalid_transition")
			default:
				requireFault(t, err, "invalid_input")
			}
			assertTaskUnchanged(t, tasks, admin, task)
		})
	}
	transferred, err := tasks.TransferWorker(ctx, owner, project.ID, task.ID, input)
	if err != nil || transferred.Status != core.TaskInProgress || !reflect.DeepEqual(transferred.StartedAt, task.StartedAt) || transferred.CompletedAt != nil || transferred.Properties.Worker.ClaimID != next.ClaimID || transferred.Properties.Worker.UserID != target.UserID || transferred.Properties.Worker.WorktreeID != descriptor.WorktreeID || !transferred.Properties.Worker.ClaimedAt.After(task.Properties.Worker.ClaimedAt) {
		t.Fatalf("transfer: %#v, %v", transferred, err)
	}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: transferred.Version, ClaimID: descriptor.ClaimID, Phase: pointer(core.WorkerExecuting)})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: transferred.Version, ClaimID: next.ClaimID, Phase: pointer(core.WorkerExecuting)})
	requireFault(t, err, "forbidden")
	input.Version, input.ClaimID, input.NewClaimID = transferred.Version, next.ClaimID, uuid.NewString()
	input.Target.UserID = admin.UserID
	if _, err := tasks.TransferWorker(ctx, admin, project.ID, task.ID, input); err != nil {
		t.Fatalf("administrator could not transfer current execution: %v", err)
	}
}

func TestWorkerOperationsRejectInvalidInputsAndMissingResources(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	task := claimableTask(t, tasks, admin, project.ID)
	base := workerDescriptor()
	for name, change := range map[string]func(*WorkerDescriptor){
		"claim": func(d *WorkerDescriptor) { d.ClaimID = "bad" }, "worker": func(d *WorkerDescriptor) { d.WorkerID = "bad" },
		"machine": func(d *WorkerDescriptor) { d.Machine.ID = "bad" }, "worktree": func(d *WorkerDescriptor) { d.WorktreeID = "bad" },
		"platform": func(d *WorkerDescriptor) { d.Platform = "darwin" }, "agent": func(d *WorkerDescriptor) { d.Agent = "other" },
		"machine name": func(d *WorkerDescriptor) { d.Machine.Name = "\x00" },
	} {
		t.Run(name, func(t *testing.T) {
			input := base
			change(&input)
			_, err := tasks.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: input})
			requireFault(t, err, "invalid_input")
		})
	}
	for _, invoke := range []func() error{
		func() error {
			_, err := tasks.ClaimWorker(ctx, core.Principal{}, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.ClaimWorker(ctx, admin, "bad", task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.ClaimWorker(ctx, admin, project.ID, "bad", ClaimWorker{Version: task.Version, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: 0, WorkerDescriptor: base})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: "bad"})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: base.ClaimID})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: base.ClaimID, Phase: pointer(core.WorkerPhase("invalid"))})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: base.ClaimID, Herdr: pointer(&core.WorkerHerdr{})})
			return err
		},
		func() error {
			_, err := tasks.UpdateWorker(ctx, admin, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: base.ClaimID, NativeSessionID: pointer(pointer(" "))})
			return err
		},
		func() error {
			_, err := tasks.ResumeWorker(ctx, admin, project.ID, task.ID, ResumeWorker{ClaimWorker: ClaimWorker{Version: task.Version, WorkerDescriptor: base}, PreviousClaimID: "bad"})
			return err
		},
		func() error {
			_, err := tasks.TransferWorker(ctx, admin, project.ID, task.ID, TransferWorker{Version: task.Version, ClaimID: "bad"})
			return err
		},
		func() error {
			_, err := tasks.Create(ctx, admin, project.ID, CreateTask{Title: "Forbidden", Properties: core.TaskProperties{Worker: &core.WorkerClaim{}}})
			return err
		},
		func() error {
			_, err := tasks.SetStatus(ctx, admin, project.ID, task.ID, SetTaskStatus{Version: task.Version, Status: core.TaskInProgress, ClaimID: &base.ClaimID})
			return err
		},
		func() error {
			_, err := tasks.SetStatus(ctx, admin, project.ID, task.ID, SetTaskStatus{Version: task.Version, Status: core.TaskDone, ClaimID: pointer("bad")})
			return err
		},
	} {
		if invoke() == nil {
			t.Fatal("invalid worker input was accepted")
		}
	}
	_, err := tasks.ClaimWorker(ctx, admin, project.ID, uuid.NewString(), ClaimWorker{Version: 1, WorkerDescriptor: base})
	requireFault(t, err, "not_found")
	_, err = tasks.ClaimWorker(ctx, admin, uuid.NewString(), task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: base})
	requireFault(t, err, "not_found")
	outsider := servicePrincipal(t, database)
	_, err = tasks.ClaimWorker(ctx, outsider, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: base})
	requireFault(t, err, "not_found")
	_, err = tasks.SetStatus(ctx, admin, project.ID, task.ID, SetTaskStatus{Version: task.Version, Status: core.TaskDone, ClaimID: &base.ClaimID})
	requireFault(t, err, "claim_conflict")
}

func TestWorkerClaimRechecksMembershipAndRollsBackUnknownWrites(t *testing.T) {
	tasks, database, project, databaseURL, admin := taskService(t)
	ctx := context.Background()
	member := workerMember(t, database, project.ID)
	task := claimableTask(t, tasks, admin, project.ID)
	descriptor := workerDescriptor()
	result := make(chan taskResult, 1)
	lockContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := database.WriteProject(lockContext, project.ID, func(tx *store.ProjectTx) error {
		go func() {
			claimed, err := tasks.ClaimWorker(lockContext, member, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
			result <- taskResult{task: claimed, err: err}
		}()
		waitForTaskWriters(t, lockContext, database, 1)
		return tx.RemoveMember(lockContext, member.UserID)
	}); err != nil {
		t.Fatal(err)
	}
	requireFault(t, receiveTaskResult(t, lockContext, result).err, "not_found")
	assertTaskUnchanged(t, tasks, admin, task)
	for _, fragment := range []string{"SELECT statement_timestamp()", "UPDATE tasks SET"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel})
			_, err := traced.ClaimWorker(ctx, admin, project.ID, task.ID, ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("claim lost cancellation cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, admin, task)
		})
	}
}

func TestWorkerAutomaticReclaimRequiresOriginalResourcesAndNewIdentity(t *testing.T) {
	tasks, _, project, _, owner := taskService(t)
	ctx := context.Background()
	descriptor := workerDescriptor()
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	released, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	next := descriptor
	next.ClaimID = uuid.NewString()
	_, err = tasks.ClaimWorker(ctx, owner, project.ID, task.ID, ClaimWorker{Version: released.Version, WorkerDescriptor: next})
	requireFault(t, err, "invalid_transition")
	resumed, err := tasks.ClaimWorker(ctx, owner, project.ID, task.ID, ClaimWorker{Version: released.Version, WorkerDescriptor: next, ContinuityConfirmed: true})
	if err != nil || resumed.Properties.Worker.ClaimID != next.ClaimID || resumed.Properties.Worker.WorktreeID != descriptor.WorktreeID {
		t.Fatalf("original work could not be reclaimed: %#v, %v", resumed, err)
	}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, task.ID, UpdateWorker{Version: resumed.Version, ClaimID: descriptor.ClaimID, Phase: pointer(core.WorkerExecuting)})
	requireFault(t, err, "claim_conflict")
	_, err = tasks.SetStatus(ctx, owner, project.ID, task.ID, SetTaskStatus{Version: resumed.Version, Status: core.TaskDone, ClaimID: &descriptor.ClaimID})
	requireFault(t, err, "claim_conflict")
}
