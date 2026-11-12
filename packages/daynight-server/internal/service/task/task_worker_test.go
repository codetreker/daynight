package task_test

import (
	"context"
	"errors"
	"maps"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func workerDescriptor() taskcore.WorkerDescriptor {
	return taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Build machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
}

func workerTestCurrent(t *testing.T, state model.WorkerState) (model.Task, model.Principal, taskcore.WorkerDescriptor) {
	t.Helper()
	_, current, principal := taskMockModels()
	current.AllowAgents = true
	descriptor := workerDescriptor()
	if state != "" {
		worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, UserID: principal.UserID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: descriptor.WorktreeID, State: state, Phase: model.WorkerPreparing, ClaimedAt: current.UpdatedAt}
		current.Properties = testWithWorker(t, current.Properties, worker)
		if state == model.WorkerActive {
			current.Status, current.Ready, current.StartedAt = model.TaskInProgress, false, pointer(current.UpdatedAt)
		}
		if state == model.WorkerCompleted {
			current.Status, current.Ready, current.StartedAt, current.CompletedAt = model.TaskDone, false, pointer(current.UpdatedAt), pointer(current.UpdatedAt)
		}
	}
	return current, principal, descriptor
}

func workerTestValues(current model.Task) store.TaskWrite {
	return store.TaskWrite{AssignedTo: current.AssignedTo, RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents, Title: current.Title, Description: current.Description, Properties: maps.Clone(current.Properties), Status: current.Status, DependsOn: append([]string{}, current.DependsOn...), ExternalDependsOn: append([]string{}, current.ExternalDependsOn...)}
}

func workerTestResult(current model.Task) model.Task {
	current.Version++
	current.UpdatedAt = current.UpdatedAt.Add(time.Second)
	return current
}

func TestWorkerClaimPreservesTaskDataAndReadsScopedVersion(t *testing.T) {
	current, owner, descriptor := workerTestCurrent(t, "")
	dependency := uuid.NewString()
	current.DependsOn, current.ExternalDependsOn = []string{dependency}, []string{dependency}
	current.RequiredPlatform = pointer(model.PlatformLinux)
	current.Description = "Unrelated description"
	current.Properties = model.TaskProperties{"pullRequests": propertyJSON([]model.PullRequestProperty{{URL: "opaque\x00\n", Title: "Evidence"}})}
	observed := current.UpdatedAt.Add(time.Second)
	worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, UserID: owner.UserID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: descriptor.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: observed}
	want := workerTestResult(current)
	want.Status, want.Ready, want.StartedAt = model.TaskInProgress, false, &observed
	want.Properties = testWithWorker(t, current.Properties, worker)
	values := workerTestValues(want)
	f := workerMockWrite(t, current, owner)
	f.Task.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		if ctx != f.Context {
			t.Fatal("claim clock changed context")
		}
		return observed, nil
	}
	workerExpectUpdate(t, f, values, want)
	got, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("claim result: %#v %v", got, err)
	}
}

func TestWorkerClaimEligibilityUsesScopedTaskAndPermission(t *testing.T) {
	for _, entry := range []struct {
		name, code string
		alter      func(*model.Task)
	}{
		{"automation disabled", "invalid_transition", func(v *model.Task) { v.AllowAgents = false }},
		{"platform mismatch", "invalid_transition", func(v *model.Task) { v.RequiredPlatform = pointer(model.PlatformWindows) }},
		{"unfinished dependency", "dependency_unsatisfied", func(v *model.Task) { v.BlockedBy = []string{uuid.NewString()} }},
		{"active execution", "invalid_transition", func(v *model.Task) { v.Status = model.TaskInProgress }},
		{"stale version", "version_conflict", func(v *model.Task) { v.Version++ }},
	} {
		t.Run(entry.name, func(t *testing.T) {
			current, owner, descriptor := workerTestCurrent(t, "")
			version := current.Version
			entry.alter(&current)
			f := workerMockWrite(t, current, owner)
			_, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: version, WorkerDescriptor: descriptor})
			requireFault(t, err, entry.code)
		})
	}
}

func TestWorkerSessionUpdatesAndClaimBoundCompletion(t *testing.T) {
	current, owner, descriptor := workerTestCurrent(t, model.WorkerActive)
	original := *testWorker(t, current.Properties)
	native := "native-session"
	herdr := &model.WorkerHerdr{Session: "w", WorkspaceID: "workspace-1", PaneID: "pane-1"}
	next := original
	next.Phase, next.Herdr, next.NativeSessionID = model.WorkerExecuting, herdr, &native
	updated := workerTestResult(current)
	updated.Properties = testWithWorker(t, current.Properties, &next)
	f := workerMockWrite(t, current, owner)
	workerExpectUpdate(t, f, workerTestValues(updated), updated)
	got, err := f.Tasks.UpdateWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: descriptor.ClaimID, Phase: &next.Phase, Herdr: &herdr, NativeSessionID: pointer(&native)})
	if err != nil || !reflect.DeepEqual(got, updated) {
		t.Fatalf("session update: %#v %v", got, err)
	}
	t.Run("same value", func(t *testing.T) {
		f := workerMockWrite(t, updated, owner)
		got, err := f.Tasks.UpdateWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: updated.Version, ClaimID: descriptor.ClaimID, Phase: &next.Phase, Herdr: &herdr, NativeSessionID: pointer(&native)})
		if err != nil || !reflect.DeepEqual(got, updated) {
			t.Fatalf("no-op update: %#v %v", got, err)
		}
	})
	for _, entry := range []struct {
		name, code string
		principal  model.Principal
		version    int64
		claim      string
	}{
		{"stale version", "version_conflict", owner, current.Version, descriptor.ClaimID},
		{"foreign claim", "claim_conflict", owner, updated.Version, uuid.NewString()},
		{"foreign owner", "forbidden", model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.SessionCredential}, updated.Version, descriptor.ClaimID},
	} {
		t.Run(entry.name, func(t *testing.T) {
			f := workerMockWrite(t, updated, entry.principal)
			_, err := f.Tasks.UpdateWorker(f.Context, entry.principal, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: entry.version, ClaimID: entry.claim, Phase: pointer(model.WorkerExecuting)})
			requireFault(t, err, entry.code)
		})
	}
	t.Run("clear execution resources", func(t *testing.T) {
		cleared := workerTestResult(updated)
		next.Herdr, next.NativeSessionID = nil, nil
		cleared.Properties = testWithWorker(t, updated.Properties, &next)
		f := workerMockWrite(t, updated, owner)
		workerExpectUpdate(t, f, workerTestValues(cleared), cleared)
		var noHerdr *model.WorkerHerdr
		var noNative *string
		got, err := f.Tasks.UpdateWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: updated.Version, ClaimID: descriptor.ClaimID, Herdr: &noHerdr, NativeSessionID: &noNative})
		if err != nil || !reflect.DeepEqual(got, cleared) {
			t.Fatalf("resource clear: %#v %v", got, err)
		}
	})
	for _, entry := range []struct {
		name, code string
		status     model.TaskStatus
		claim      *string
		caller     model.Principal
	}{
		{"unbound completion", "claim_conflict", model.TaskDone, nil, owner},
		{"ordinary reset", "invalid_transition", model.TaskTodo, nil, owner},
		{"foreign completion", "forbidden", model.TaskDone, &descriptor.ClaimID, model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.SessionCredential}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			f := workerMockWrite(t, updated, entry.caller)
			_, err := f.Tasks.SetStatus(f.Context, entry.caller, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: entry.status, ClaimID: entry.claim})
			requireFault(t, err, entry.code)
		})
	}
	t.Run("same status", func(t *testing.T) {
		f := workerMockWrite(t, updated, owner)
		got, err := f.Tasks.SetStatus(f.Context, owner, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: model.TaskInProgress})
		if err != nil || !reflect.DeepEqual(got, updated) {
			t.Fatalf("same status: %#v %v", got, err)
		}
	})
	t.Run("owner completion", func(t *testing.T) {
		completed := workerTestResult(updated)
		completed.Status = model.TaskDone
		completed.CompletedAt = pointer(completed.UpdatedAt)
		finished := *testWorker(t, updated.Properties)
		finished.State = model.WorkerCompleted
		completed.Properties = testWithWorker(t, updated.Properties, &finished)
		f := workerMockWrite(t, updated, owner)
		workerExpectUpdate(t, f, workerTestValues(completed), completed)
		got, err := f.Tasks.SetStatus(f.Context, owner, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: updated.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
		if err != nil || !reflect.DeepEqual(got, completed) {
			t.Fatalf("completion: %#v %v", got, err)
		}
	})
}

func TestWorkerReleaseRetainsExecution(t *testing.T) {
	current, owner, descriptor := workerTestCurrent(t, model.WorkerActive)
	active := *testWorker(t, current.Properties)
	active.Herdr = &model.WorkerHerdr{Session: "w", WorkspaceID: "source-workspace", PaneID: "source-pane"}
	active.NativeSessionID = pointer("source-native")
	current.Properties = testWithWorker(t, current.Properties, &active)
	released := workerTestResult(current)
	released.Status, released.Ready, released.StartedAt, released.CompletedAt = model.TaskTodo, true, nil, nil
	previous := active
	previous.State = model.WorkerReleased
	released.Properties = testWithWorker(t, current.Properties, &previous)
	administrator := owner
	administrator.UserID, administrator.CredentialID = uuid.NewString(), uuid.NewString()
	f := workerMockWrite(t, current, administrator)
	f.ExpectedAccessCalls = 2
	f.Project.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
		return model.ProjectAccess{ProjectID: current.ProjectID, UserID: administrator.UserID, Role: model.ProjectAdmin}, nil
	}
	workerExpectUpdate(t, f, workerTestValues(released), released)
	got, err := f.Tasks.ReleaseWorker(f.Context, administrator, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: current.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil || !reflect.DeepEqual(got, released) {
		t.Fatalf("release: %#v %v", got, err)
	}
	for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
		f := workerMockWrite(t, released, owner)
		_, err := f.Tasks.SetStatus(f.Context, owner, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: released.Version, Status: status})
		requireFault(t, err, "invalid_transition")
	}
}

func TestWorkerWithdrawalResetsClaimAndDisablesAutomation(t *testing.T) {
	for _, state := range []model.WorkerState{model.WorkerActive, model.WorkerReleased} {
		for _, operator := range []string{"owner", "administrator"} {
			t.Run(string(state)+"/"+operator, func(t *testing.T) {
				current, owner, descriptor := workerTestCurrent(t, state)
				dependency := uuid.NewString()
				current.DependsOn, current.ExternalDependsOn = []string{dependency}, []string{dependency}
				current.RequiredPlatform = pointer(model.PlatformLinux)
				current.Properties["pullRequests"] = propertyJSON([]model.PullRequestProperty{{URL: "opaque\x00", Title: "Evidence"}})
				caller := owner
				if operator == "administrator" {
					caller.UserID, caller.CredentialID = uuid.NewString(), uuid.NewString()
				}
				withdrawn := workerTestResult(current)
				withdrawn.Status, withdrawn.Ready, withdrawn.AllowAgents, withdrawn.StartedAt, withdrawn.CompletedAt = model.TaskTodo, true, false, nil, nil
				withdrawn.Properties = testWithWorker(t, current.Properties, nil)
				f := workerMockWrite(t, current, caller)
				if operator == "administrator" {
					f.ExpectedAccessCalls = 2
					f.Project.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
						return model.ProjectAccess{ProjectID: current.ProjectID, UserID: caller.UserID, Role: model.ProjectAdmin}, nil
					}
				}
				workerExpectUpdate(t, f, workerTestValues(withdrawn), withdrawn)
				got, err := f.Tasks.WithdrawWorker(f.Context, caller, current.ProjectID, current.ID, taskcore.WithdrawWorker{Version: current.Version, ClaimID: descriptor.ClaimID})
				if err != nil || !reflect.DeepEqual(got, withdrawn) {
					t.Fatalf("withdrawal: %#v %v", got, err)
				}
				for _, invoke := range []func(*workerWriteMock) error{
					func(f *workerWriteMock) error {
						_, err := f.Tasks.UpdateWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: withdrawn.Version, ClaimID: descriptor.ClaimID, Phase: pointer(model.WorkerExecuting)})
						return err
					},
					func(f *workerWriteMock) error {
						_, err := f.Tasks.SetStatus(f.Context, owner, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: withdrawn.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
						return err
					},
				} {
					f := workerMockWrite(t, withdrawn, owner)
					requireFault(t, invoke(f), "claim_conflict")
				}
				f = workerMockWrite(t, withdrawn, owner)
				_, err = f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: withdrawn.Version, WorkerDescriptor: workerDescriptor()})
				requireFault(t, err, "invalid_transition")
			})
		}
	}
}

func TestWorkerWithdrawalRequiresAnUnfinishedClaim(t *testing.T) {
	for _, state := range []model.WorkerState{"", model.WorkerCompleted} {
		current, owner, descriptor := workerTestCurrent(t, state)
		f := workerMockWrite(t, current, owner)
		_, err := f.Tasks.WithdrawWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.WithdrawWorker{Version: current.Version, ClaimID: descriptor.ClaimID})
		requireFault(t, err, "claim_conflict")
	}
}

func TestWorkerOperationsRejectInvalidInputsAndMissingResources(t *testing.T) {
	current, owner, base := workerTestCurrent(t, "")
	for name, change := range map[string]func(*taskcore.WorkerDescriptor){
		"claim": func(d *taskcore.WorkerDescriptor) { d.ClaimID = "bad" }, "worker": func(d *taskcore.WorkerDescriptor) { d.WorkerID = "bad" },
		"machine": func(d *taskcore.WorkerDescriptor) { d.Machine.ID = "bad" }, "worktree": func(d *taskcore.WorkerDescriptor) { d.WorktreeID = "bad" },
		"platform": func(d *taskcore.WorkerDescriptor) { d.Platform = "darwin" }, "agent": func(d *taskcore.WorkerDescriptor) { d.Agent = "other" },
		"machine name": func(d *taskcore.WorkerDescriptor) { d.Machine.Name = "\x00" },
	} {
		t.Run(name, func(t *testing.T) {
			descriptor := base
			change(&descriptor)
			tasks := taskservice.NewTasks(&taskStoreMock{taskMockBase: newTaskMockBase(t, "descriptor preflight")})
			_, err := tasks.ClaimWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
			requireFault(t, err, "invalid_input")
		})
	}
	for name, invoke := range map[string]func(*taskservice.Tasks) error{
		"principal": func(s *taskservice.Tasks) error {
			_, err := s.ClaimWorker(t.Context(), model.Principal{}, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: base})
			return err
		},
		"project": func(s *taskservice.Tasks) error {
			_, err := s.ClaimWorker(t.Context(), owner, "bad", current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: base})
			return err
		},
		"task": func(s *taskservice.Tasks) error {
			_, err := s.ClaimWorker(t.Context(), owner, current.ProjectID, "bad", taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: base})
			return err
		},
		"version": func(s *taskservice.Tasks) error {
			_, err := s.ClaimWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: 0, WorkerDescriptor: base})
			return err
		},
		"update claim": func(s *taskservice.Tasks) error {
			_, err := s.UpdateWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: "bad"})
			return err
		},
		"empty update": func(s *taskservice.Tasks) error {
			_, err := s.UpdateWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: base.ClaimID})
			return err
		},
		"phase": func(s *taskservice.Tasks) error {
			_, err := s.UpdateWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: base.ClaimID, Phase: pointer(model.WorkerPhase("invalid"))})
			return err
		},
		"Herdr": func(s *taskservice.Tasks) error {
			_, err := s.UpdateWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: base.ClaimID, Herdr: pointer(&model.WorkerHerdr{})})
			return err
		},
		"native": func(s *taskservice.Tasks) error {
			_, err := s.UpdateWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: base.ClaimID, NativeSessionID: pointer(pointer(" "))})
			return err
		},
		"release stop confirmation": func(s *taskservice.Tasks) error {
			_, err := s.ReleaseWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: current.Version, ClaimID: base.ClaimID})
			return err
		},
		"release claim": func(s *taskservice.Tasks) error {
			_, err := s.ReleaseWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: current.Version, ClaimID: "bad", StoppedConfirmed: true})
			return err
		},
		"withdraw claim": func(s *taskservice.Tasks) error {
			_, err := s.WithdrawWorker(t.Context(), owner, current.ProjectID, current.ID, taskcore.WithdrawWorker{Version: current.Version, ClaimID: "bad"})
			return err
		},
		"reserved property": func(s *taskservice.Tasks) error {
			_, err := s.Create(t.Context(), owner, current.ProjectID, taskcore.CreateTask{Title: "Forbidden", Properties: model.TaskProperties{"worker": propertyJSON(map[string]any{})}})
			return err
		},
		"claim on start": func(s *taskservice.Tasks) error {
			_, err := s.SetStatus(t.Context(), owner, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskInProgress, ClaimID: &base.ClaimID})
			return err
		},
		"invalid completion claim": func(s *taskservice.Tasks) error {
			_, err := s.SetStatus(t.Context(), owner, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskDone, ClaimID: pointer("bad")})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := taskservice.NewTasks(&taskStoreMock{taskMockBase: newTaskMockBase(t, "preflight")})
			if err := invoke(s); err == nil {
				t.Fatal("invalid input accepted")
			}
		})
	}
	t.Run("missing task", func(t *testing.T) {
		f := workerMockWrite(t, current, owner)
		f.Task.TaskFn = func(context.Context, string) (model.Task, error) { return model.Task{}, model.ErrNotFound }
		_, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: base})
		requireFault(t, err, "not_found")
	})
	t.Run("missing project", func(t *testing.T) {
		f := workerMockWrite(t, current, owner)
		f.ExpectedAccessCalls, f.ExpectedTaskReads = 0, 0
		f.Store.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
			return store.Completion{Outcome: store.TransactionNotCommitted}, model.ErrNotFound
		}
		_, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: base})
		requireFault(t, err, "not_found")
	})
	t.Run("missing membership", func(t *testing.T) {
		f := workerMockWrite(t, current, owner)
		f.ExpectedTaskReads = 0
		f.Project.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
			return model.ProjectAccess{}, model.ErrNotFound
		}
		_, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: base})
		requireFault(t, err, "not_found")
	})
}

func TestWorkerClaimPreservesScopedMembershipAndWriteFailures(t *testing.T) {
	t.Run("removed membership", func(t *testing.T) {
		current, owner, descriptor := workerTestCurrent(t, "")
		f := workerMockWrite(t, current, owner)
		f.ExpectedTaskReads = 0
		f.Project.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
			return model.ProjectAccess{}, model.ErrNotFound
		}
		_, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
		requireFault(t, err, "not_found")
	})
	for _, stage := range []string{"clock", "write"} {
		t.Run(stage, func(t *testing.T) {
			current, owner, descriptor := workerTestCurrent(t, "")
			f := workerMockWrite(t, current, owner)
			calls := 0
			f.Task.ObservedAtFn = func(context.Context) (time.Time, error) {
				if stage == "clock" {
					calls++
					return time.Time{}, context.Canceled
				}
				return current.UpdatedAt.Add(time.Second), nil
			}
			if stage == "write" {
				f.Task.UpdateTaskFn = func(context.Context, string, store.TaskWrite) (model.Task, error) {
					calls++
					return model.Task{}, context.Canceled
				}
			}
			got, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
			if calls != 1 || !errors.Is(err, context.Canceled) || !reflect.DeepEqual(got, model.Task{}) {
				t.Fatalf("claim failure: calls=%d task=%#v error=%v", calls, got, err)
			}
			assertOperational(t, err)
		})
	}
}

func TestWorkerAutomaticReclaimCreatesFreshResourcesAndKeepsEligibility(t *testing.T) {
	released, owner, previous := workerTestCurrent(t, model.WorkerReleased)
	worker := *testWorker(t, released.Properties)
	worker.Herdr = &model.WorkerHerdr{Session: "source", WorkspaceID: "workspace", PaneID: "pane"}
	worker.NativeSessionID = pointer("source-native")
	released.Properties = testWithWorker(t, released.Properties, &worker)
	next := workerDescriptor()
	next.Agent = model.AgentCopilot
	for _, entry := range []struct {
		name, code string
		descriptor taskcore.WorkerDescriptor
	}{
		{"same claim", "claim_conflict", previous},
		{"same worktree", "invalid_transition", func() taskcore.WorkerDescriptor { d := next; d.WorktreeID = previous.WorktreeID; return d }()},
	} {
		t.Run(entry.name, func(t *testing.T) {
			f := workerMockWrite(t, released, owner)
			_, err := f.Tasks.ClaimWorker(f.Context, owner, released.ProjectID, released.ID, taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: entry.descriptor})
			requireFault(t, err, entry.code)
		})
	}
	observed := released.UpdatedAt.Add(time.Second)
	fresh := &model.WorkerClaim{ClaimID: next.ClaimID, WorkerID: next.WorkerID, UserID: owner.UserID, Machine: next.Machine, Platform: next.Platform, Agent: next.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: next.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: observed}
	resumed := workerTestResult(released)
	resumed.Status, resumed.Ready, resumed.StartedAt = model.TaskInProgress, false, &observed
	resumed.Properties = testWithWorker(t, released.Properties, fresh)
	f := workerMockWrite(t, released, owner)
	f.Task.ObservedAtFn = func(context.Context) (time.Time, error) { return observed, nil }
	workerExpectUpdate(t, f, workerTestValues(resumed), resumed)
	got, err := f.Tasks.ClaimWorker(f.Context, owner, released.ProjectID, released.ID, taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: next})
	if err != nil || !reflect.DeepEqual(got, resumed) {
		t.Fatalf("automatic reclaim: %#v %v", got, err)
	}
	for _, operation := range []string{"release", "withdraw", "complete"} {
		f := workerMockWrite(t, resumed, owner)
		_, err := workerManagementInvoke(f, resumed, owner, operation, previous)
		requireFault(t, err, "claim_conflict")
	}
	for _, entry := range []struct {
		name   string
		change func(*model.Task)
	}{
		{"automation disabled", func(v *model.Task) { v.AllowAgents = false }},
		{"platform mismatch", func(v *model.Task) { v.RequiredPlatform = pointer(model.PlatformWindows) }},
	} {
		t.Run(entry.name, func(t *testing.T) {
			current := released
			entry.change(&current)
			f := workerMockWrite(t, current, owner)
			_, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: next})
			requireFault(t, err, "invalid_transition")
		})
	}
}

func workerManagementInvoke(f *workerWriteMock, current model.Task, caller model.Principal, operation string, descriptor taskcore.WorkerDescriptor) (model.Task, error) {
	switch operation {
	case "release":
		return f.Tasks.ReleaseWorker(f.Context, caller, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: current.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	case "withdraw":
		return f.Tasks.WithdrawWorker(f.Context, caller, current.ProjectID, current.ID, taskcore.WithdrawWorker{Version: current.Version, ClaimID: descriptor.ClaimID})
	case "complete":
		return f.Tasks.SetStatus(f.Context, caller, current.ProjectID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID})
	default:
		panic("unexpected worker test operation")
	}
}

func TestWorkerManagementReadsCurrentScopeBeforeDeciding(t *testing.T) {
	for _, operation := range []string{"release", "withdraw"} {
		t.Run(operation, func(t *testing.T) {
			current, owner, descriptor := workerTestCurrent(t, model.WorkerActive)
			scoped := current
			scoped.Version++
			f := workerMockWrite(t, scoped, owner)
			_, err := workerManagementInvoke(f, current, owner, operation, descriptor)
			requireFault(t, err, "version_conflict")
		})
	}
}

func TestWorkerManagementPreservesCanceledDAOErrors(t *testing.T) {
	for _, operation := range []string{"release", "withdraw"} {
		t.Run(operation, func(t *testing.T) {
			current, owner, descriptor := workerTestCurrent(t, model.WorkerActive)
			f := workerMockWrite(t, current, owner)
			calls := 0
			f.Task.UpdateTaskFn = func(context.Context, string, store.TaskWrite) (model.Task, error) {
				calls++
				return model.Task{}, context.Canceled
			}
			got, err := workerManagementInvoke(f, current, owner, operation, descriptor)
			if calls != 1 || !errors.Is(err, context.Canceled) || !reflect.DeepEqual(got, model.Task{}) {
				t.Fatalf("management failure: calls=%d task=%#v error=%v", calls, got, err)
			}
			assertOperational(t, err)
		})
	}
}

func TestWorkerManagementRechecksOperatorMembership(t *testing.T) {
	for _, operation := range []string{"release", "withdraw"} {
		for _, permission := range []string{"removed owner", "demoted administrator"} {
			t.Run(operation+"/"+permission, func(t *testing.T) {
				current, owner, descriptor := workerTestCurrent(t, model.WorkerActive)
				caller := owner
				if permission == "demoted administrator" {
					caller.UserID, caller.CredentialID = uuid.NewString(), uuid.NewString()
				}
				f := workerMockWrite(t, current, caller)
				if permission == "removed owner" {
					f.ExpectedTaskReads = 0
					f.Project.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
						return model.ProjectAccess{}, model.ErrNotFound
					}
				} else {
					f.ExpectedAccessCalls = 2
				}
				_, err := workerManagementInvoke(f, current, caller, operation, descriptor)
				want := "forbidden"
				if permission == "removed owner" {
					want = "not_found"
				}
				requireFault(t, err, want)
			})
		}
	}
}

func TestWorkerWithdrawalPreservesDatabaseFailureChain(t *testing.T) {
	current, owner, descriptor := workerTestCurrent(t, model.WorkerActive)
	cause := errors.New("private withdrawal edge diagnostic")
	failure := &store.Error{Phase: "query", DatabaseFailure: true, SQLState: "P0001", Cause: cause}
	f := workerMockWrite(t, current, owner)
	calls := 0
	f.Task.UpdateTaskFn = func(context.Context, string, store.TaskWrite) (model.Task, error) {
		calls++
		return model.Task{}, failure
	}
	got, err := workerManagementInvoke(f, current, owner, "withdraw", descriptor)
	var stored *store.Error
	if calls != 1 || !errors.As(err, &stored) || stored != failure || !errors.Is(err, cause) || strings.Contains(err.Error(), cause.Error()) || !reflect.DeepEqual(got, model.Task{}) {
		t.Fatalf("withdrawal failure lost typed cause: task=%#v error=%v", got, err)
	}
	assertOperational(t, err)
}

func TestWorkerWithdrawalAndCompletionUseScopedVersion(t *testing.T) {
	for _, operation := range []string{"withdraw", "complete"} {
		t.Run(operation, func(t *testing.T) {
			before, owner, descriptor := workerTestCurrent(t, model.WorkerActive)
			current := before
			current.Version++
			f := workerMockWrite(t, current, owner)
			_, err := workerManagementInvoke(f, before, owner, operation, descriptor)
			requireFault(t, err, "version_conflict")
		})
	}
}

func workerExpectUpdate(t *testing.T, f *workerWriteMock, values store.TaskWrite, returned model.Task) {
	t.Helper()
	f.ExpectUpdate(values, returned)
	if f.Current.Status != returned.Status {
		f.ExpectCapture([]protocol.Fact{{Type: protocol.StatusChanged, ProjectID: returned.ProjectID, TaskID: returned.ID, TaskVersion: returned.Version, OccurredAt: returned.UpdatedAt, PreviousStatus: string(f.Current.Status), Status: string(returned.Status)}})
	}
}
