package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestScopedWorkerOperations(t *testing.T) {
	for _, op := range []struct {
		name  string
		scope scopepolicy.ScopeID
	}{
		{"claim", "worker:claim"}, {"update", "worker:report"}, {"release", "worker:release"}, {"withdraw", "worker:release"},
	} {
		for _, tc := range []struct {
			name    string
			scopes  []scopepolicy.ScopeID
			full    bool
			allowed bool
		}{
			{"own permission", []scopepolicy.ScopeID{op.scope}, false, true},
			{"agent authorization alone", []scopepolicy.ScopeID{"agent:authorize"}, false, false},
			{"full response requires read", []scopepolicy.ScopeID{op.scope}, true, false},
			{"full response with read", []scopepolicy.ScopeID{"task:read", op.scope}, true, true},
		} {
			t.Run(op.name+"/"+tc.name, func(t *testing.T) {
				state := model.WorkerActive
				if op.name == "claim" {
					state = ""
				}
				current, principal, descriptor := workerTestCurrent(t, state)
				principal.Kind = model.PATCredential
				current.Type = model.TaskTypeTask
				current.Description = "unchanged description"
				current.Properties["custom"] = propertyJSON("unchanged")
				policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, tc.scopes, 1)
				if err != nil {
					t.Fatal(err)
				}
				type contextKey struct{}
				parent := context.WithValue(t.Context(), contextKey{}, "worker-scope")
				ctx := taskservice.WithTaskWriteAuthorization(parent, model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, tc.full)
				base := newTaskMockBase(t, "worker-scope")
				reads, writes, admissionReads, admissionChecks := 0, 0, 0, 0
				project := &projectWriterMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
					if p != principal {
						t.Fatal("principal changed")
					}
					return model.ProjectAccess{ProjectID: current.ProjectID, UserID: p.UserID, Role: model.ProjectMemberRole}, nil
				}}
				tasks := &taskWriterMock{taskMockBase: base,
					TaskHeaderFn: func(_ context.Context, id string) (model.TaskHeader, error) {
						if id != current.ID {
							t.Fatal("target changed")
						}
						return model.TaskHeader{ID: id, ProjectID: current.ProjectID, Type: model.TaskTypeTask}, nil
					},
					TaskFn: func(_ context.Context, id string) (model.Task, error) {
						if id != current.ID {
							t.Fatal("target changed")
						}
						reads++
						return current, nil
					},
					ObservedAtFn: func(context.Context) (time.Time, error) { return current.UpdatedAt.Add(time.Second), nil },
					UpdateTaskFn: func(_ context.Context, id string, values store.TaskWrite) (model.Task, error) {
						if id != current.ID {
							t.Fatal("target changed")
						}
						writes++
						result := current
						result.Status, result.Properties, result.AllowAgents, result.Version = values.Status, values.Properties, values.AllowAgents, current.Version+1
						result.UpdatedAt = current.UpdatedAt.Add(time.Second)
						return result, nil
					},
				}
				session := &projectSessionMock{taskMockBase: base, DrainTaskSessionsFn: func(context.Context, string, store.TaskSessionDrain) error { return nil }, TransitionTaskSessionReceiptsFn: func(context.Context, string, store.TaskSessionReceiptTransition) error { return nil }}
				admission := &workerClaimAdmissionMock{
					read: func(actual context.Context, user, worker string) (*model.WorkerDesiredConfiguration, error) {
						admissionReads++
						if actual.Value(contextKey{}) != "worker-scope" || user != principal.UserID || worker != descriptor.WorkerID {
							t.Fatal("claim configuration identity or context changed")
						}
						return nil, nil
					},
					check: func(actual context.Context, user, worker string) error {
						admissionChecks++
						if actual.Value(contextKey{}) != "worker-scope" || user != principal.UserID || worker != descriptor.WorkerID {
							t.Fatal("claim execution identity or context changed")
						}
						return nil
					},
				}
				scope := &taskProjectScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return tasks }, SessionDAOFn: func() store.ProjectSessionDAO { return session }, CaptureDAOFn: func() store.WebhookCaptureDAO { return scopeCaptureDAO{} }, WorkerClaimAdmissionDAOFn: func() store.WorkerClaimAdmissionDAO { return admission }}
				db := &taskStoreMock{taskMockBase: base, WriteProjectFn: func(_ context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
					if id != current.ProjectID {
						t.Fatal("project changed")
					}
					e := run(scope)
					if e != nil {
						return store.Completion{Outcome: store.TransactionNotCommitted}, e
					}
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				}}
				capture := taskDeletionCapture(func(context.Context, store.WebhookCaptureDAO, wm.Actor, []protocol.Fact) error { return nil })
				service := taskservice.NewTasks(db, capture)
				var result model.Task
				switch op.name {
				case "claim":
					result, err = service.ClaimWorker(ctx, principal, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
				case "update":
					result, err = service.UpdateWorker(ctx, principal, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: descriptor.ClaimID, Phase: pointer(model.WorkerExecuting)})
				case "release":
					result, err = service.ReleaseWorker(ctx, principal, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: current.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
				case "withdraw":
					result, err = service.WithdrawWorker(ctx, principal, current.ProjectID, current.ID, taskcore.WithdrawWorker{Version: current.Version, ClaimID: descriptor.ClaimID})
				}
				wantAdmission := 0
				if op.name == "claim" && tc.allowed {
					wantAdmission = 1
				}
				if admissionReads != wantAdmission || admissionChecks != wantAdmission {
					t.Fatalf("claim admission reads=%d checks=%d, want %d each", admissionReads, admissionChecks, wantAdmission)
				}
				if !tc.allowed {
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != "insufficient_scope" || reads != 0 || writes != 0 || !reflect.DeepEqual(result, model.Task{}) {
						t.Fatalf("refusal err=%v reads=%d writes=%d result=%+v", err, reads, writes, result)
					}
					return
				}
				if err != nil || reads != 1 || writes != 1 {
					t.Fatalf("admission err=%v reads=%d writes=%d", err, reads, writes)
				}
				if result.Description != current.Description || string(result.Properties["custom"]) != string(current.Properties["custom"]) || !reflect.DeepEqual(result.AssignedTo, current.AssignedTo) {
					t.Fatalf("unrelated data changed: %+v", result)
				}
				worker := testWorker(t, result.Properties)
				switch op.name {
				case "claim":
					if result.Status != model.TaskInProgress || worker == nil || worker.ClaimID != descriptor.ClaimID || worker.UserID != principal.UserID {
						t.Fatalf("claim result %+v", result)
					}
				case "update":
					if worker == nil || worker.ClaimID != descriptor.ClaimID || worker.Phase != model.WorkerExecuting {
						t.Fatalf("update result %+v", result)
					}
				case "release", "withdraw":
					if worker != nil || result.Status != model.TaskTodo || result.AllowAgents != (op.name == "release") {
						t.Fatalf("release result %+v", result)
					}
				}
			})
		}
	}
}

func TestScopedWorkerAuthorityDoesNotReplaceClaimOwnership(t *testing.T) {
	for _, tc := range []struct {
		name       string
		operation  scopepolicy.Operation
		wrongOwner bool
		wrongClaim bool
		want       string
	}{
		{"claim requires assignee", scopepolicy.WorkerClaim, true, false, "invalid_transition"},
		{"update requires owner", scopepolicy.WorkerReport, true, false, "forbidden"},
		{"update requires claim", scopepolicy.WorkerReport, false, true, "claim_conflict"},
		{"release requires operator", scopepolicy.WorkerRelease, true, false, "forbidden"},
		{"release requires claim", scopepolicy.WorkerRelease, false, true, "claim_conflict"},
		{"withdraw requires operator", scopepolicy.WorkerRelease, true, false, "forbidden"},
		{"withdraw requires claim", scopepolicy.WorkerRelease, false, true, "claim_conflict"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := model.WorkerActive
			if tc.operation == scopepolicy.WorkerClaim {
				state = ""
			}
			current, owner, descriptor := workerTestCurrent(t, state)
			caller := owner
			caller.Kind = model.PATCredential
			if tc.wrongOwner {
				caller.UserID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			}
			if tc.wrongClaim {
				descriptor.ClaimID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
			}
			scopes, err := scopepolicy.Requirements(tc.operation)
			if err != nil {
				t.Fatal(err)
			}
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
			if err != nil {
				t.Fatal(err)
			}
			ctx := taskservice.WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: caller, Profile: model.ScopedPATProfile, Policy: &policy}, false)
			base := newTaskMockBase(t, "worker-owner")
			writes := 0
			project := &projectWriterMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
				return model.ProjectAccess{ProjectID: current.ProjectID, UserID: p.UserID, Role: model.ProjectMemberRole}, nil
			}}
			tasks := &taskWriterMock{taskMockBase: base, TaskHeaderFn: func(_ context.Context, id string) (model.TaskHeader, error) {
				return model.TaskHeader{ID: id, ProjectID: current.ProjectID, Type: model.TaskTypeTask}, nil
			}, TaskFn: func(context.Context, string) (model.Task, error) { return current, nil }, UpdateTaskFn: func(context.Context, string, store.TaskWrite) (model.Task, error) {
				writes++
				t.Fatal("unauthorized mutation")
				return model.Task{}, nil
			}}
			scope := &taskProjectScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return tasks }}
			db := &taskStoreMock{taskMockBase: base, WriteProjectFn: func(_ context.Context, _ string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
				e := run(scope)
				if e != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, e
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}}
			service := taskservice.NewTasks(db)
			switch tc.name {
			case "claim requires assignee":
				_, err = service.ClaimWorker(ctx, caller, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
			case "update requires owner", "update requires claim":
				_, err = service.UpdateWorker(ctx, caller, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: descriptor.ClaimID, Phase: pointer(model.WorkerExecuting)})
			case "release requires operator", "release requires claim":
				_, err = service.ReleaseWorker(ctx, caller, current.ProjectID, current.ID, taskcore.ReleaseWorker{Version: current.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
			case "withdraw requires operator", "withdraw requires claim":
				_, err = service.WithdrawWorker(ctx, caller, current.ProjectID, current.ID, taskcore.WithdrawWorker{Version: current.Version, ClaimID: descriptor.ClaimID})
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != tc.want || writes != 0 {
				t.Fatalf("want %s, err=%v writes=%d", tc.want, err, writes)
			}
		})
	}
}
