package task_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func claimWorkerMode(t *testing.T, current model.Task, owner model.Principal, descriptor taskcore.WorkerDescriptor) model.Task {
	t.Helper()
	observed := current.UpdatedAt.Add(time.Second)
	mode := descriptor.AgentControlMode
	if mode == "" {
		mode = model.AgentControlModeHerdr
	}
	worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, WorkerID: descriptor.WorkerID, UserID: owner.UserID,
		Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: mode,
		WorktreeID: descriptor.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: observed}
	want := workerTestResult(current)
	want.Status, want.Ready, want.StartedAt, want.CompletedAt = model.TaskInProgress, false, &observed, nil
	want.Properties = testWithWorker(t, current.Properties, worker)
	delete(want.Properties, "sessionStartup")
	f := workerMockWrite(t, current, owner)
	f.Task.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		if ctx != f.Context {
			t.Fatal("claim clock escaped its operation context")
		}
		return observed, nil
	}
	workerExpectUpdate(t, f, workerTestValues(want), want)
	got, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("requested control mode was not acquired: got %#v want %#v err=%v", got, want, err)
	}
	return got
}

func TestWorkerWebModeSurvivesSummaryReleaseAndReclaim(t *testing.T) {
	for _, provider := range []model.WorkerAgent{model.AgentClaude, model.AgentCopilot, model.AgentCodex} {
		t.Run(string(provider), func(t *testing.T) {
			current, owner, descriptor := workerTestCurrent(t, "")
			descriptor.Agent, descriptor.AgentControlMode = provider, model.AgentControlModeWeb
			claimed := claimWorkerMode(t, current, owner, descriptor)
			worker := *testWorker(t, claimed.Properties)
			native := "web-native-session"
			next := worker
			next.Phase, next.NativeSessionID = model.WorkerExecuting, &native
			updated := workerTestResult(claimed)
			updated.Properties = testWithWorker(t, claimed.Properties, &next)
			f := workerMockWrite(t, claimed, owner)
			workerExpectUpdate(t, f, workerTestValues(updated), updated)
			got, err := f.Tasks.UpdateWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.UpdateWorker{
				Version: claimed.Version, ClaimID: worker.ClaimID, Phase: &next.Phase, NativeSessionID: pointer(&native),
			})
			if err != nil || !reflect.DeepEqual(got, updated) || testWorker(t, got.Properties).AgentControlMode != model.AgentControlModeWeb {
				t.Fatalf("summary replaced frozen web mode: %#v %v", got, err)
			}
			t.Run("Herdr resources refused", func(t *testing.T) {
				f := workerMockWrite(t, updated, owner)
				herdr := &model.WorkerHerdr{Session: "s", WorkspaceID: "w", PaneID: "p"}
				_, err := f.Tasks.UpdateWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: updated.Version, ClaimID: worker.ClaimID, Herdr: &herdr})
				requireFault(t, err, "invalid_input")
			})
			released := workerTestResult(updated)
			released.Status, released.Ready, released.StartedAt, released.CompletedAt = model.TaskTodo, true, nil, nil
			released.Properties = testWithWorker(t, updated.Properties, nil)
			f = workerMockWrite(t, updated, owner)
			workerExpectUpdate(t, f, workerTestValues(released), released)
			got, err = f.Tasks.ReleaseWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: updated.Version, ClaimID: worker.ClaimID, StoppedConfirmed: true})
			if err != nil || !reflect.DeepEqual(got, released) {
				t.Fatalf("release did not clear execution: %#v %v", got, err)
			}
			fresh := workerDescriptor()
			fresh.Agent, fresh.AgentControlMode = provider, model.AgentControlModeWeb
			resumed := claimWorkerMode(t, released, owner, fresh)
			actual := testWorker(t, resumed.Properties)
			if actual.Agent != provider || actual.AgentControlMode != model.AgentControlModeWeb || actual.ClaimID == worker.ClaimID || actual.WorktreeID == worker.WorktreeID || actual.NativeSessionID != nil || actual.Herdr != nil || !resumed.AllowAgents {
				t.Fatalf("web reclaim inherited resources or changed eligibility: %#v", actual)
			}
		})
	}
}

func TestWorkerFreshExecutionsSelectTheirRequestedControlMode(t *testing.T) {
	current, owner, _ := workerTestCurrent(t, "")
	fresh := workerDescriptor()
	resumed := claimWorkerMode(t, current, owner, fresh)
	worker := *testWorker(t, resumed.Properties)
	if worker.Agent != model.AgentCodex || worker.AgentControlMode != model.AgentControlModeHerdr || worker.Herdr != nil || worker.NativeSessionID != nil {
		t.Fatalf("new default execution inherited old provider, mode or resources: %#v", worker)
	}
	withdrawn := workerTestResult(resumed)
	withdrawn.Status, withdrawn.Ready, withdrawn.AllowAgents, withdrawn.StartedAt, withdrawn.CompletedAt = model.TaskTodo, true, false, nil, nil
	withdrawn.Properties = testWithWorker(t, resumed.Properties, nil)
	f := workerMockWrite(t, resumed, owner)
	workerExpectUpdate(t, f, workerTestValues(withdrawn), withdrawn)
	got, err := f.Tasks.WithdrawWorker(f.Context, owner, resumed.ProjectID, resumed.ID, taskcore.WithdrawWorker{Version: resumed.Version, ClaimID: worker.ClaimID})
	if err != nil || !reflect.DeepEqual(got, withdrawn) {
		t.Fatalf("withdrawal did not release execution history: %#v %v", got, err)
	}
	withdrawn.AllowAgents = true
	web := workerDescriptor()
	web.AgentControlMode = model.AgentControlModeWeb
	claimed := claimWorkerMode(t, withdrawn, owner, web)
	active := *testWorker(t, claimed.Properties)
	if active.AgentControlMode != model.AgentControlModeWeb || active.ClaimID == worker.ClaimID || active.WorktreeID == worker.WorktreeID || active.Herdr != nil || active.NativeSessionID != nil {
		t.Fatalf("fresh web execution inherited released mode or resources: %#v", active)
	}
	completed := workerTestResult(claimed)
	completed.Status, completed.Ready, completed.CompletedAt = model.TaskDone, false, pointer(completed.UpdatedAt)
	finished := active
	finished.State = model.WorkerCompleted
	completed.Properties = testWithWorker(t, claimed.Properties, &finished)
	f = workerMockWrite(t, claimed, owner)
	workerExpectUpdate(t, f, workerTestValues(completed), completed)
	got, err = f.Tasks.SetStatus(f.Context, owner, claimed.ProjectID, claimed.ID, taskcore.SetTaskStatus{Version: claimed.Version, Status: model.TaskDone, ClaimID: &active.ClaimID})
	if err != nil || !reflect.DeepEqual(got, completed) || testWorker(t, got.Properties).AgentControlMode != model.AgentControlModeWeb {
		t.Fatalf("completion changed selected control mode: %#v %v", got, err)
	}
}
