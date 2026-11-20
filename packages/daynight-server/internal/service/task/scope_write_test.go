package task_test

import (
	"context"
	"encoding/json"
	"errors"
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

type scopeCaptureDAO struct{ store.WebhookCaptureDAO }

func TestScopedTaskUpdateAdmissionPrecedesMutation(t *testing.T) {
	title, allow := "new title", true
	tests := []struct {
		name     string
		ids      []scopepolicy.ScopeID
		input    taskcore.UpdateTask
		full     bool
		admitted bool
	}{
		{"title receipt", []scopepolicy.ScopeID{"task:write"}, taskcore.UpdateTask{Title: &title}, false, true},
		{"allow receipt", []scopepolicy.ScopeID{"agent:authorize"}, taskcore.UpdateTask{AllowAgents: &allow}, false, true},
		{"combined lacks allow", []scopepolicy.ScopeID{"task:write"}, taskcore.UpdateTask{Title: &title, AllowAgents: &allow}, false, false},
		{"combined lacks title", []scopepolicy.ScopeID{"agent:authorize"}, taskcore.UpdateTask{Title: &title, AllowAgents: &allow}, false, false},
		{"combined", []scopepolicy.ScopeID{"agent:authorize", "task:write"}, taskcore.UpdateTask{Title: &title, AllowAgents: &allow}, false, true},
		{"full lacks read", []scopepolicy.ScopeID{"task:write"}, taskcore.UpdateTask{Title: &title}, true, false},
		{"full with read", []scopepolicy.ScopeID{"task:read", "task:write"}, taskcore.UpdateTask{Title: &title}, true, true},
		{"full with session read", []scopepolicy.ScopeID{"session:read", "task:read", "task:write"}, taskcore.UpdateTask{Title: &title}, true, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			project, target, principal := taskMockModels()
			principal.Kind = model.PATCredential
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, tc.ids, 1)
			if err != nil {
				t.Fatal(err)
			}
			auth := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
			ctx := taskservice.WithTaskWriteAuthorization(t.Context(), auth, tc.full)
			base := newTaskMockBase(t, "scope-test")
			projectDAO := &projectWriterMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, got model.Principal) (model.ProjectAccess, error) {
				if got != principal {
					t.Fatal("principal changed")
				}
				return taskMockAccess(project, got), nil
			}}
			target.Type = model.TaskTypeTask
			target.Properties = model.TaskProperties{"worker": json.RawMessage(`{"claimId":"private"}`), "sessionStartup": json.RawMessage(`{"state":"private"}`), "custom": json.RawMessage(`true`)}
			writes := 0
			taskDAO := &taskWriterMock{taskMockBase: base, TaskHeaderFn: func(_ context.Context, id string) (model.TaskHeader, error) {
				return model.TaskHeader{ID: id, ProjectID: project.ID, Type: model.TaskTypeTask}, nil
			}, TaskFn: func(_ context.Context, id string) (model.Task, error) {
				if id != target.ID {
					t.Fatal("task ID changed")
				}
				return target, nil
			}, TasksByIDFn: func(_ context.Context, ids []string) ([]model.Task, error) {
				if len(ids) != 0 {
					t.Fatal("unexpected prerequisites")
				}
				return []model.Task{}, nil
			}, UpdateTaskFn: func(_ context.Context, id string, values store.TaskWrite) (model.Task, error) {
				writes++
				if id != target.ID {
					t.Fatal("write changed identity")
				}
				result := target
				result.Title, result.AllowAgents, result.Version = values.Title, values.AllowAgents, target.Version+1
				return result, nil
			}}
			sessions := &projectSessionMock{taskMockBase: base,
				DrainTaskSessionsFn:             func(context.Context, string, store.TaskSessionDrain) error { return nil },
				TransitionTaskSessionReceiptsFn: func(context.Context, string, store.TaskSessionReceiptTransition) error { return nil },
			}
			scope := &taskProjectScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return projectDAO }, TaskDAOFn: func() store.TaskWriteDAO { return taskDAO }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }}
			database := &taskStoreMock{taskMockBase: base, WriteProjectFn: func(_ context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
				if id != project.ID {
					t.Fatal("project ID changed")
				}
				err := work(scope)
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}}
			tc.input.Version = target.Version
			result, err := taskservice.NewTasks(database).Update(ctx, principal, project.ID, target.ID, tc.input)
			if tc.admitted {
				if writes != 1 || err != nil || result.Version != target.Version+1 {
					t.Fatalf("admitted: writes=%d result=%+v err=%v", writes, result, err)
				}
				hasSession := false
				for _, id := range tc.ids {
					if id == "session:read" {
						hasSession = true
					}
				}
				if _, present := result.Properties["worker"]; present != hasSession {
					t.Fatalf("worker projection: %s", result.Properties["worker"])
				}
				if _, present := result.Properties["sessionStartup"]; present != hasSession {
					t.Fatal("startup projection changed")
				}
				if string(result.Properties["custom"]) != "true" || target.Properties["worker"] == nil {
					t.Fatal("ordinary or persisted properties changed")
				}
				if tc.input.Title != nil && result.Title != *tc.input.Title || tc.input.AllowAgents != nil && result.AllowAgents != *tc.input.AllowAgents {
					t.Fatalf("incorrect committed result: %+v", result)
				}
			} else {
				var fault *model.Fault
				if writes != 0 || !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
					t.Fatalf("refusal: writes=%d err=%v", writes, err)
				}
			}
		})
	}
}

func TestScopedTaskTagAssociationDoesNotRequireCatalogWrite(t *testing.T) {
	project, target, principal := taskMockModels()
	principal.Kind = model.PATCredential
	target.Type = model.TaskTypeTask
	target.Properties = model.TaskProperties{"worker": json.RawMessage(`{"claimId":"private"}`), "sessionStartup": json.RawMessage(`{"state":"private"}`), "custom": json.RawMessage(`true`)}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx := taskservice.WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, false)
	base := newTaskMockBase(t, "tag-scope")
	projectDAO := &projectWriterMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
		return taskMockAccess(project, p), nil
	}}
	const tagID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	reads, writes, touches := 0, 0, 0
	writer := &taskWriterMock{taskMockBase: base,
		TaskFn: func(_ context.Context, _ string) (model.Task, error) {
			reads++
			if reads == 1 {
				return target, nil
			}
			result := target
			result.Version++
			result.Tags = []model.TagReference{{ID: tagID, Name: "Tag"}}
			return result, nil
		},
		ObservedAtFn: func(context.Context) (time.Time, error) { return target.UpdatedAt, nil },
		TouchTaskFn:  func(context.Context, string, time.Time) error { touches++; return nil },
	}
	baseScope := &taskProjectScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return projectDAO }, TaskDAOFn: func() store.TaskWriteDAO { return writer }}
	scope := tagServiceScope{ProjectWriteScope: baseScope,
		catalog: tagCatalogStub{resolve: func(_ context.Context, ids []string) ([]model.Tag, error) {
			if len(ids) != 1 || ids[0] != tagID {
				t.Fatal("incorrect tags")
			}
			return []model.Tag{{ID: tagID, Name: "Tag"}}, nil
		}},
		associations: tagAssociationsStub{replace: func(_ context.Context, id string, ids []string) error {
			if id != target.ID || len(ids) != 1 || ids[0] != tagID {
				t.Fatal("incorrect association")
			}
			writes++
			return nil
		}},
	}
	database := &taskStoreMock{taskMockBase: base, WriteProjectFn: func(_ context.Context, _ string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		err := run(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	result, err := taskservice.NewTasks(database).ReplaceTags(ctx, principal, project.ID, target.ID, target.Version, &[]string{tagID})
	if err != nil || writes != 1 || touches != 1 || reads != 2 || result.Version != target.Version+1 || len(result.Tags) != 1 || result.Tags[0].ID != tagID {
		t.Fatalf("result=%+v writes=%d touches=%d reads=%d err=%v", result, writes, touches, reads, err)
	}
	if result.Properties["worker"] != nil || result.Properties["sessionStartup"] != nil || string(result.Properties["custom"]) != "true" || target.Properties["worker"] == nil {
		t.Fatal("tag-only response exposed session properties or changed stored values")
	}
}

func TestScopedStatusRefusalDoesNotRevealDependencies(t *testing.T) {
	project, target, principal := taskMockModels()
	principal.Kind = model.PATCredential
	target.Type = model.TaskTypeTask
	target.BlockedBy = []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
	base := newTaskMockBase(t, "status-scope")
	projectReader := &projectReaderMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, p model.Principal, _ string) (model.ProjectAccess, error) {
		return taskMockAccess(project, p), nil
	}}
	reader := &taskReaderMock{taskMockBase: base, TaskHeaderFn: func(_ context.Context, project, id string) (model.TaskHeader, error) {
		return model.TaskHeader{ProjectID: project, ID: id, Type: model.TaskTypeTask}, nil
	}}
	snapshot := &taskSnapshotScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectReader { return projectReader }, TaskDAOFn: func() store.TaskReader { return reader }}
	projectDAO := &projectWriterMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
		return taskMockAccess(project, p), nil
	}}
	reads, writes := 0, 0
	writer := &taskWriterMock{taskMockBase: base,
		TaskHeaderFn: func(_ context.Context, id string) (model.TaskHeader, error) {
			return model.TaskHeader{ID: id, ProjectID: project.ID, Type: model.TaskTypeTask}, nil
		},
		TaskFn:       func(context.Context, string) (model.Task, error) { reads++; return target, nil },
		UpdateTaskFn: func(context.Context, string, store.TaskWrite) (model.Task, error) { writes++; return model.Task{}, nil },
	}
	scope := &taskProjectScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return projectDAO }, TaskDAOFn: func() store.TaskWriteDAO { return writer }}
	database := &taskStoreMock{taskMockBase: base,
		ReadSnapshotFn: func(_ context.Context, run func(store.SnapshotScope) error) error { return run(snapshot) },
		WriteProjectFn: func(_ context.Context, _ string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
			err := run(scope)
			if err != nil {
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		},
	}
	for _, tc := range []struct {
		scope scopepolicy.ScopeID
		code  string
		reads int
	}{{"task:write", "insufficient_scope", 0}, {"task:status", "dependency_unsatisfied", 1}} {
		policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{tc.scope}, 1)
		if err != nil {
			t.Fatal(err)
		}
		ctx := taskservice.WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, false)
		reads = 0
		_, err = taskservice.NewTasks(database).SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskDone})
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != tc.code || len(fault.TaskIDs) != 0 || reads != tc.reads || writes != 0 {
			t.Fatalf("scope=%s fault=%+v reads=%d writes=%d error=%v", tc.scope, fault, reads, writes, err)
		}
	}
}

func TestScopedStatusAndClaimCompletionUseDifferentPermissions(t *testing.T) {
	for _, tc := range []struct {
		name  string
		claim bool
		id    scopepolicy.ScopeID
		allow bool
	}{
		{"ordinary", false, "task:status", true}, {"ordinary rejects worker", false, "worker:complete", false},
		{"claim", true, "worker:complete", true}, {"claim rejects status", true, "task:status", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			project, current, principal := taskMockModels()
			var claimID *string
			if tc.claim {
				var descriptor taskcore.WorkerDescriptor
				current, principal, descriptor = workerTestCurrent(t, model.WorkerActive)
				claimID = &descriptor.ClaimID
			}
			principal.Kind = model.PATCredential
			current.Type = model.TaskTypeTask
			base := newTaskMockBase(t, "status-permission")
			projectReader := &projectReaderMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, p model.Principal, _ string) (model.ProjectAccess, error) {
				return taskMockAccess(project, p), nil
			}}
			reader := &taskReaderMock{taskMockBase: base, TaskHeaderFn: func(_ context.Context, project, id string) (model.TaskHeader, error) {
				return model.TaskHeader{ProjectID: project, ID: id, Type: model.TaskTypeTask}, nil
			}}
			snapshot := &taskSnapshotScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectReader { return projectReader }, TaskDAOFn: func() store.TaskReader { return reader }}
			projectDAO := &projectWriterMock{taskMockBase: base, ProjectAccessFn: func(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
				return taskMockAccess(project, p), nil
			}}
			writes := 0
			writer := &taskWriterMock{taskMockBase: base,
				TaskHeaderFn: func(_ context.Context, id string) (model.TaskHeader, error) {
					return model.TaskHeader{ID: id, ProjectID: project.ID, Type: model.TaskTypeTask}, nil
				},
				TaskFn: func(context.Context, string) (model.Task, error) { return current, nil },
				UpdateTaskFn: func(_ context.Context, _ string, values store.TaskWrite) (model.Task, error) {
					writes++
					result := current
					result.Status, result.Properties, result.Version = values.Status, values.Properties, current.Version+1
					return result, nil
				},
			}
			sessions := &projectSessionMock{taskMockBase: base, DrainTaskSessionsFn: func(context.Context, string, store.TaskSessionDrain) error { return nil }, TransitionTaskSessionReceiptsFn: func(context.Context, string, store.TaskSessionReceiptTransition) error { return nil }}
			scope := &taskProjectScopeMock{taskMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return projectDAO }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return scopeCaptureDAO{} }}
			database := &taskStoreMock{taskMockBase: base, ReadSnapshotFn: func(_ context.Context, run func(store.SnapshotScope) error) error { return run(snapshot) }, WriteProjectFn: func(_ context.Context, _ string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
				err := run(scope)
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}}
			capture := taskDeletionCapture(func(context.Context, store.WebhookCaptureDAO, wm.Actor, []protocol.Fact) error { return nil })
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{tc.id}, 1)
			if err != nil {
				t.Fatal(err)
			}
			ctx := taskservice.WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, false)
			result, err := taskservice.NewTasks(database, capture).SetStatus(ctx, principal, project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskDone, ClaimID: claimID})
			if tc.allow {
				if err != nil || writes != 1 || result.Status != model.TaskDone {
					t.Fatalf("result=%+v writes=%d error=%v", result, writes, err)
				}
				if tc.claim && testWorker(t, result.Properties).State != model.WorkerCompleted {
					t.Fatal("claim was not completed")
				}
			} else {
				var fault *model.Fault
				if writes != 0 || !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
					t.Fatalf("writes=%d error=%v", writes, err)
				}
			}
		})
	}
}
