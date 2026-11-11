package server

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func lifecycleTaskValues(task model.Task) store.TaskWrite {
	return copyTaskHTTPWrite(store.TaskWrite{Type: task.Type, ParentID: task.ParentID, AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform, AllowAgents: task.AllowAgents, Title: task.Title, Description: task.Description, Properties: task.Properties, Status: task.Status, DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn})
}

func (f *taskCredentialFixture) expectLifecycleMutation(before, after model.Task, prerequisite model.Task, patch bool, accessError error) {
	before, after, prerequisite = copyTaskHTTPTask(before), copyTaskHTTPTask(after), copyTaskHTTPTask(prerequisite)
	expectedValues := lifecycleTaskValues(after)
	base := newTaskHTTPMockBase(f.t, "Lifecycle HTTP write")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base}
	project.ProjectAccessFn = func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		f.plan.Called("access")
		if actor != f.actor || ctx.Err() != nil {
			f.fail("lifecycle write changed actor/context")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = model.ProjectMemberRole
		return access, accessError
	}
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base}
	writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		f.plan.Called("task")
		f.requireAddress(ctx, f.project.ID, id)
		return copyTaskHTTPTask(before), nil
	}
	writer.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
		f.plan.Called("dependencies")
		if !patch || !reflect.DeepEqual(ids, []string{prerequisite.ID}) || ctx.Err() != nil {
			f.fail("lifecycle PATCH changed prerequisite selection")
		}
		return []model.Task{copyTaskHTTPTask(prerequisite)}, nil
	}
	writer.ReachableFn = func(ctx context.Context, dependency, target string, replacement store.DependencyReplacement) (bool, error) {
		f.plan.Called("reachable")
		if !patch || dependency != prerequisite.ID || target != before.ID || !reflect.DeepEqual(replacement, store.DependencyReplacement{TaskID: before.ID, DependsOn: []string{prerequisite.ID}}) || ctx.Err() != nil {
			f.fail("lifecycle dependency check changed scope")
		}
		return false, nil
	}
	writer.UpdateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
		f.plan.Called("update")
		f.requireAddress(ctx, f.project.ID, id)
		if !reflect.DeepEqual(values, expectedValues) {
			f.fail("lifecycle candidate=%#v, want=%#v", values, expectedValues)
		}
		return copyTaskHTTPTask(after), nil
	}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base}
	sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, drain store.TaskSessionDrain) error {
		f.plan.Called("drain")
		f.requireAddress(ctx, f.project.ID, id)
		expected := store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}, SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
		if !reflect.DeepEqual(drain, expected) {
			f.fail("lifecycle drain=%#v want=%#v", drain, expected)
		}
		return nil
	}
	sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, transition store.TaskSessionReceiptTransition) error {
		f.plan.Called("receipts")
		f.requireAddress(ctx, f.project.ID, id)
		if !reflect.DeepEqual(transition, store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}) {
			f.fail("lifecycle transition changed receipt policy")
		}
		return nil
	}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base}
	capture.FreezeAudienceFn = func(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
		f.plan.Called("capture")
		if project != f.project.ID || !reflect.DeepEqual(types, []string{protocol.StatusChanged}) || ctx.Err() != nil {
			f.fail("lifecycle status capture changed scope/type")
		}
		return []store.WebhookAudience{}, nil
	}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	f.database.WriteProjectCall = func(ctx context.Context, project string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		f.plan.Called("projectWrite")
		if project != f.project.ID {
			f.fail("lifecycle transaction changed Project")
		}
		err := run(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	f.database.ReadSnapshotCall = nil
	f.database.WriteThreadCall = nil
}

func lifecycleMutationCalls(patch bool) map[string]int {
	calls := taskCredentialCalls("projectWrite", "access", "task", "update", "drain", "receipts")
	if patch {
		calls["dependencies"], calls["reachable"] = 1, 1
	} else {
		calls["capture"] = 1
	}
	return calls
}

func assertLifecycleTask(t *testing.T, actual api.Task, expected model.Task) {
	t.Helper()
	expected = copyTaskHTTPTask(expected)
	resource := api.Task{ID: expected.ID, Type: expected.Type, ParentID: expected.ParentID, ProjectID: expected.ProjectID, Title: expected.Title, Description: expected.Description, Properties: api.TaskProperties(expected.Properties), Status: string(expected.Status), Version: expected.Version, CreatedAt: expected.CreatedAt, UpdatedAt: expected.UpdatedAt, StartedAt: expected.StartedAt, CompletedAt: expected.CompletedAt, CancelledAt: expected.CancelledAt, DependsOn: expected.DependsOn, ExternalDependsOn: expected.ExternalDependsOn, BlockedBy: expected.BlockedBy, AssignedTo: expected.AssignedTo, AllowAgents: expected.AllowAgents, Ready: expected.Ready}
	if !reflect.DeepEqual(actual, resource) {
		t.Fatalf("lifecycle result=%#v want=%#v", actual, resource)
	}
}
