package server

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

func platformHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("Task HTTP DAO value: got %#v, want %#v", actual, expected)
		panic("Task HTTP DAO contract violated")
	}
}

func platformHTTPValues(task model.Task) store.TaskWrite {
	task = copyTaskHTTPTask(task)
	return store.TaskWrite{AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform, AllowAgents: task.AllowAgents,
		Title: task.Title, Description: task.Description, Properties: task.Properties, Status: task.Status,
		DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn}
}

func platformHTTPAPI(task model.Task) api.Task {
	task = copyTaskHTTPTask(task)
	var platform *string
	if task.RequiredPlatform != nil {
		value := string(*task.RequiredPlatform)
		platform = &value
	}
	return api.Task{ID: task.ID, ProjectID: task.ProjectID, Title: task.Title, Description: task.Description,
		Status: string(task.Status), Properties: api.TaskProperties(task.Properties), Version: task.Version,
		CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt, StartedAt: task.StartedAt, CompletedAt: task.CompletedAt, CancelledAt: task.CancelledAt,
		DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn, BlockedBy: task.BlockedBy,
		RequiredPlatform: platform, AssignedTo: task.AssignedTo, AllowAgents: task.AllowAgents, Ready: task.Ready}
}

func platformHTTPResult(before model.Task, after model.Task) model.Task {
	after = copyTaskHTTPTask(after)
	after.Version = before.Version + 1
	after.UpdatedAt = before.UpdatedAt.Add(time.Microsecond)
	after.Ready = after.Status == model.TaskTodo
	return after
}

// The result is declared by the case; recording a write never changes a read plan.
func platformHTTPWrite(f *taskHTTPFixture, before *model.Task, values store.TaskWrite, result model.Task, status bool) *model.Task {
	f.t.Helper()
	if before != nil {
		current := copyTaskHTTPTask(*before)
		before = &current
	}
	values, result = copyTaskHTTPWrite(values), copyTaskHTTPTask(result)
	want := map[string]int{"write": 1, "access": 1}
	changed := before == nil || !reflect.DeepEqual(*before, result)
	if before != nil {
		want["task"] = 1
	}
	if !status {
		want["prerequisites"] = 1
	}
	if status && before != nil && before.Status == model.TaskDone && result.Status != model.TaskDone {
		want["dependents"] = 1
	}
	if changed {
		want["save"] = 1
		if before != nil {
			want["drain"], want["receipts"] = 1, 1
		}
		if before == nil || before.Status != result.Status {
			want["capture"] = 1
		}
	}
	plan := newHTTPCallPlan(f.t, want)
	base := newTaskHTTPMockBase(f.t, "platform HTTP write")
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task")}
	projects := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base.withLabel("session")}
	projects.ProjectAccessFn = func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		f.require(ctx, f.project.ID)
		plan.Called("access")
		platformHTTPCheck(f.t, principal, f.principal)
		return taskHTTPMockAccess(f.project, principal), nil
	}
	if before != nil {
		writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
			f.require(ctx, f.project.ID)
			plan.Called("task")
			platformHTTPCheck(f.t, id, before.ID)
			return copyTaskHTTPTask(*before), nil
		}
	}
	if !status {
		writer.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			f.require(ctx, f.project.ID)
			plan.Called("prerequisites")
			platformHTTPCheck(f.t, ids, values.DependsOn)
			return []model.Task{}, nil
		}
	}
	if want["dependents"] != 0 {
		writer.ActiveDependentIDsFn = func(ctx context.Context, id string) ([]string, error) {
			f.require(ctx, f.project.ID)
			plan.Called("dependents")
			platformHTTPCheck(f.t, id, before.ID)
			return []string{}, nil
		}
	}
	output := &result
	if changed {
		save := func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
			f.require(ctx, f.project.ID)
			plan.Called("save")
			platformHTTPCheck(f.t, actual, values)
			if before == nil {
				parsed, err := uuid.Parse(id)
				if err != nil || parsed.Version() != 4 || parsed.String() != id {
					unexpectedHTTPCall(f.t, "Task creation UUID")
				}
				output.ID = id
			} else {
				platformHTTPCheck(f.t, id, before.ID)
			}
			return copyTaskHTTPTask(*output), nil
		}
		if before == nil {
			writer.CreateTaskFn = save
		} else {
			writer.UpdateTaskFn = save
			sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, actual store.TaskSessionDrain) error {
				f.require(ctx, f.project.ID)
				plan.Called("drain")
				platformHTTPCheck(f.t, id, before.ID)
				platformHTTPCheck(f.t, actual, store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60,
					TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
					SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}})
				return nil
			}
			sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, actual store.TaskSessionReceiptTransition) error {
				f.require(ctx, f.project.ID)
				plan.Called("receipts")
				platformHTTPCheck(f.t, id, before.ID)
				platformHTTPCheck(f.t, actual, store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}})
				return nil
			}
		}
	}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
	if want["capture"] != 0 {
		capture.FreezeAudienceFn = func(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
			f.require(ctx, project)
			plan.Called("capture")
			expected := protocol.StatusChanged
			if before == nil {
				expected = protocol.Created
			}
			platformHTTPCheck(f.t, types, []string{expected})
			return []store.WebhookAudience{}, nil
		}
	}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return projects }, TaskDAOFn: func() store.TaskWriteDAO { return writer },
		SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	f.store.WriteProjectCall = func(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.Called("write")
		platformHTTPCheck(f.t, id, f.project.ID)
		if run == nil || f.active {
			unexpectedHTTPCall(f.t, "Project write callback")
		}
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		err := run(scope)
		outcome := store.TransactionCommitted
		if err != nil {
			outcome = store.TransactionNotCommitted
		}
		return store.Completion{Outcome: outcome}, err
	}
	return output
}

func platformHTTPRefusal(f *taskHTTPFixture, before model.Task) {
	f.t.Helper()
	before = copyTaskHTTPTask(before)
	plan := newHTTPCallPlan(f.t, map[string]int{"write": 1, "access": 1, "task": 1})
	base := newTaskHTTPMockBase(f.t, "platform HTTP refusal")
	projects := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project"), ProjectAccessFn: func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		f.require(ctx, f.project.ID)
		plan.Called("access")
		platformHTTPCheck(f.t, principal, f.principal)
		return taskHTTPMockAccess(f.project, principal), nil
	}}
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task"), TaskFn: func(ctx context.Context, id string) (model.Task, error) {
		f.require(ctx, f.project.ID)
		plan.Called("task")
		platformHTTPCheck(f.t, id, before.ID)
		return copyTaskHTTPTask(before), nil
	}}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"), ProjectDAOFn: func() store.ProjectWriteDAO { return projects }, TaskDAOFn: func() store.TaskWriteDAO { return writer }}
	f.store.WriteProjectCall = func(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.Called("write")
		platformHTTPCheck(f.t, id, f.project.ID)
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		err := run(scope)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func platformHTTPStatus(f *taskHTTPFixture, before model.Task, to model.TaskStatus) model.Task {
	f.t.Helper()
	before = copyTaskHTTPTask(before)
	after := copyTaskHTTPTask(before)
	if before.Status != to {
		after.Status = to
		after = platformHTTPResult(before, after)
		switch to {
		case model.TaskTodo:
			after.StartedAt, after.CompletedAt = nil, nil
		case model.TaskInProgress:
			after.StartedAt, after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt), nil
		case model.TaskDone:
			after.CompletedAt = copyTaskHTTPPointer(&after.UpdatedAt)
		}
	}
	values := platformHTTPValues(before)
	values.Status = to
	platformHTTPWrite(f, &before, values, after, true)
	got := setHTTPTask(f.t, f.handler, platformHTTPAPI(before), string(to))
	platformHTTPCheck(f.t, got, platformHTTPAPI(after))
	return after
}

func platformHTTPProjection(row model.Task) model.GraphTask {
	row = copyTaskHTTPTask(row)
	return model.GraphTask{ID: row.ID, TitlePreview: row.Title, Status: row.Status, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy,
		AllowAgents: row.AllowAgents, RequiredPlatform: row.RequiredPlatform, AssignedTo: row.AssignedTo, Ready: row.Ready,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt}
}
