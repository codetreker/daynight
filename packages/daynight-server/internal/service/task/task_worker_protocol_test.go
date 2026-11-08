package task_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func workerProtocolTask(t *testing.T, principal model.Principal, descriptor taskcore.WorkerDescriptor, state model.WorkerState) model.Task {
	t.Helper()
	current := workerServiceTask(t, principal)
	worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, WorkerID: descriptor.WorkerID, UserID: principal.UserID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode, WorktreeID: descriptor.WorktreeID, State: state, Phase: model.WorkerPreparing, ClaimedAt: current.CreatedAt}
	current.Properties = testWithWorker(t, current.Properties, worker)
	if state == model.WorkerActive {
		current.Status, current.Ready, current.StartedAt = model.TaskInProgress, false, pointer(current.CreatedAt)
	}
	return current
}

func workerProtocolCapture(fixture *workerWriteMock, current, returned model.Task) {
	fixture.ExpectCapture([]protocol.Fact{{Type: protocol.StatusChanged, ProjectID: current.ProjectID, TaskID: current.ID, TaskVersion: returned.Version, OccurredAt: returned.UpdatedAt, PreviousStatus: string(current.Status), Status: string(returned.Status)}})
}

func TestLegacyWorkerProtocolPreservesSupportedLifecycle(t *testing.T) {
	principal := workerServicePrincipal()
	t.Run("manual metadata", func(t *testing.T) {
		current := workerServiceTask(t, principal)
		current.AllowAgents = false
		fixture := workerMockWrite(t, current, principal)
		fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
		values := taskcore.CurrentWrite(current)
		values.Title = "Updated manual task"
		returned := current
		returned.Title, returned.Version, returned.UpdatedAt = values.Title, current.Version+1, current.UpdatedAt.Add(time.Second)
		dependencies := 0
		fixture.Task.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			dependencies++
			if ctx != fixture.Context || len(ids) != 0 || dependencies != 1 {
				t.Fatal("legacy metadata dependency query")
			}
			return []model.Task{}, nil
		}
		fixture.ExpectUpdate(values, returned)
		after, err := fixture.Tasks.Update(fixture.Context, principal, current.ProjectID, current.ID, taskcore.UpdateTask{Version: current.Version, Title: &values.Title})
		if err != nil || !reflect.DeepEqual(after, returned) || dependencies != 1 {
			t.Fatalf("legacy manual update: %#v %v", after, err)
		}
	})
	t.Run("manual status", func(t *testing.T) {
		current := workerServiceTask(t, principal)
		current.AllowAgents = false
		fixture := workerMockWrite(t, current, principal)
		fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
		values := taskcore.CurrentWrite(current)
		values.Status = model.TaskInProgress
		returned := current
		returned.Status, returned.Ready, returned.Version, returned.UpdatedAt = values.Status, false, current.Version+1, current.UpdatedAt.Add(time.Second)
		returned.StartedAt = &returned.UpdatedAt
		fixture.ExpectUpdate(values, returned)
		workerProtocolCapture(fixture, current, returned)
		after, err := fixture.Tasks.SetStatus(fixture.Context, principal, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskInProgress})
		if err != nil || !reflect.DeepEqual(after, returned) || testWorker(t, after.Properties) != nil {
			t.Fatalf("legacy manual lifecycle: %#v %v", after, err)
		}
	})
	for _, agent := range []model.WorkerAgent{model.AgentCodex, model.AgentCopilot} {
		t.Run(string(agent), func(t *testing.T) {
			descriptor := workerDescriptor()
			descriptor.Agent = agent
			current := workerServiceTask(t, principal)
			fixture := workerMockWrite(t, current, principal)
			fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
			claimedAt := current.UpdatedAt.Add(time.Second)
			normalized := descriptor
			normalized.AgentControlMode = model.AgentControlModeHerdr
			returned := workerProtocolTask(t, principal, normalized, model.WorkerActive)
			returned.Version, returned.UpdatedAt, returned.StartedAt = current.Version+1, claimedAt, &claimedAt
			worker := *testWorker(t, returned.Properties)
			worker.ClaimedAt = claimedAt
			returned.Properties = testWithWorker(t, returned.Properties, &worker)
			values := taskcore.CurrentWrite(current)
			values.Status, values.Properties = returned.Status, returned.Properties
			fixture.Task.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
				if ctx != fixture.Context {
					t.Fatal("legacy claim clock context")
				}
				return claimedAt, nil
			}
			fixture.ExpectUpdate(values, returned)
			workerProtocolCapture(fixture, current, returned)
			claimed, err := fixture.Tasks.ClaimWorker(fixture.Context, principal, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
			if err != nil || !reflect.DeepEqual(claimed, returned) || testWorker(t, claimed.Properties).AgentControlMode != model.AgentControlModeHerdr {
				t.Fatalf("legacy default Herdr: %#v %v", claimed, err)
			}
			t.Run("metadata", func(t *testing.T) {
				fixture := workerMockWrite(t, claimed, principal)
				fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
				values := taskcore.CurrentWrite(claimed)
				values.Title = "Updated worker task"
				returned := claimed
				returned.Title, returned.Version, returned.UpdatedAt = values.Title, claimed.Version+1, claimed.UpdatedAt.Add(time.Second)
				calls := 0
				fixture.Task.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
					calls++
					if ctx != fixture.Context || len(ids) != 0 || calls != 1 {
						t.Fatal("legacy Worker metadata dependency query")
					}
					return []model.Task{}, nil
				}
				fixture.ExpectUpdate(values, returned)
				after, err := fixture.Tasks.Update(fixture.Context, principal, claimed.ProjectID, claimed.ID, taskcore.UpdateTask{Version: claimed.Version, Title: &values.Title})
				if err != nil || !reflect.DeepEqual(after, returned) || testWorker(t, after.Properties).ClaimID != descriptor.ClaimID || calls != 1 {
					t.Fatalf("legacy metadata: %#v %v", after, err)
				}
			})
			t.Run("completion", func(t *testing.T) {
				fixture := workerMockWrite(t, claimed, principal)
				fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
				worker := *testWorker(t, claimed.Properties)
				worker.State = model.WorkerCompleted
				values := taskcore.CurrentWrite(claimed)
				values.Status, values.Properties = model.TaskDone, testWithWorker(t, claimed.Properties, &worker)
				returned := claimed
				returned.Status, returned.Properties, returned.Version, returned.UpdatedAt = values.Status, values.Properties, claimed.Version+1, claimed.UpdatedAt.Add(time.Second)
				returned.CompletedAt = &returned.UpdatedAt
				fixture.ExpectUpdate(values, returned)
				workerProtocolCapture(fixture, claimed, returned)
				after, err := fixture.Tasks.SetStatus(fixture.Context, principal, claimed.ProjectID, claimed.ID, taskcore.SetTaskStatus{Version: claimed.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
				if err != nil || !reflect.DeepEqual(after, returned) || testWorker(t, after.Properties).State != model.WorkerCompleted {
					t.Fatalf("legacy completion: %#v %v", after, err)
				}
			})
		})
	}
}

func TestLegacyWorkerProtocolRefusesUnsupportedExecutionsWithoutWrites(t *testing.T) {
	principal := workerServicePrincipal()
	for _, entry := range []struct {
		mode  model.WorkerAgentControlMode
		agent model.WorkerAgent
	}{
		{model.AgentControlModeWeb, model.AgentCodex}, {model.AgentControlModeWeb, model.AgentCopilot}, {model.AgentControlModeWeb, model.AgentClaude}, {model.AgentControlModeHerdr, model.AgentClaude},
	} {
		t.Run(string(entry.mode)+"/"+string(entry.agent), func(t *testing.T) {
			descriptor := workerDescriptor()
			descriptor.Agent, descriptor.AgentControlMode = entry.agent, entry.mode
			current := workerServiceTask(t, principal)
			ctx := taskcore.WithLegacyWorkerProtocol(t.Context())
			tasks := taskservice.NewTasks(&taskStoreMock{taskMockBase: newTaskMockBase(t, "legacy preflight")})
			_, err := tasks.ClaimWorker(ctx, principal, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
			requireFault(t, err, "invalid_transition")
			claimed := workerProtocolTask(t, principal, descriptor, model.WorkerActive)
			for _, version := range []int64{claimed.Version - 1, claimed.Version} {
				want := "invalid_transition"
				if version != claimed.Version {
					want = "version_conflict"
				}
				for _, operation := range []string{"metadata", "completion", "release"} {
					t.Run(operation+"/"+string(rune('0'+version)), func(t *testing.T) {
						fixture := workerMockWrite(t, claimed, principal)
						fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
						var err error
						switch operation {
						case "metadata":
							_, err = fixture.Tasks.Update(fixture.Context, principal, claimed.ProjectID, claimed.ID, taskcore.UpdateTask{Version: version, Title: pointer("Must not change")})
						case "completion":
							_, err = fixture.Tasks.SetStatus(fixture.Context, principal, claimed.ProjectID, claimed.ID, taskcore.SetTaskStatus{Version: version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
						case "release":
							_, err = fixture.Tasks.ReleaseWorker(fixture.Context, principal, claimed.ProjectID, claimed.ID, taskcore.ReleaseWorker{Version: version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
						}
						requireFault(t, err, want)
					})
				}
			}
			_, err = tasks.ReleaseWorker(ctx, principal, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: current.Version - 1, ClaimID: "invalid", StoppedConfirmed: true})
			requireFault(t, err, "invalid_input")
			released := workerProtocolTask(t, principal, descriptor, model.WorkerReleased)
			t.Run("delete", func(t *testing.T) {
				fixture := workerMockWrite(t, released, principal)
				fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
				err := fixture.Tasks.Delete(fixture.Context, principal, released.ProjectID, released.ID, taskcore.DeleteTask{Version: released.Version})
				requireFault(t, err, "invalid_transition")
			})
			for _, next := range []taskcore.WorkerDescriptor{descriptor, workerDescriptor()} {
				if next.ClaimID == descriptor.ClaimID {
					_, err = tasks.ResumeWorker(ctx, principal, released.ProjectID, released.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
					requireFault(t, err, "invalid_transition")
					continue
				}
				t.Run("resume", func(t *testing.T) {
					fixture := workerMockWrite(t, released, principal)
					fixture.Context = taskcore.WithLegacyWorkerProtocol(t.Context())
					_, err := fixture.Tasks.ResumeWorker(fixture.Context, principal, released.ProjectID, released.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
					requireFault(t, err, "invalid_transition")
				})
			}
		})
	}
}

func TestLegacyWorkerCompatibilityPreservesHistoricalMode(t *testing.T) {
	if !taskcore.LegacyWorkerCompatible(nil) {
		t.Fatal("manual tasks must remain compatible")
	}
	for _, agent := range []model.WorkerAgent{model.AgentCodex, model.AgentCopilot, model.AgentClaude, "unknown"} {
		for _, mode := range []model.WorkerAgentControlMode{"", model.AgentControlModeHerdr, model.AgentControlModeWeb, "unknown"} {
			want := (mode == "" || mode == model.AgentControlModeHerdr) && (agent == model.AgentCodex || agent == model.AgentCopilot)
			if got := taskcore.LegacyWorkerCompatible(&model.WorkerClaim{Agent: agent, AgentControlMode: mode}); got != want {
				t.Errorf("compatibility for %q/%q = %t, want %t", mode, agent, got, want)
			}
		}
	}
}
