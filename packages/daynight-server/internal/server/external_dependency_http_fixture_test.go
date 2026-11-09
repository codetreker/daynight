package server

import (
	"context"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

type externalHTTPFixture struct{ *taskHTTPFixture }

func newExternalHTTPFixture(t *testing.T) *externalHTTPFixture {
	t.Helper()
	return &externalHTTPFixture{newTaskHTTPFixture(t)}
}
func externalHTTPRecord(projectID, id, title string) model.Task {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.Task{ID: id, ProjectID: projectID, Title: title, Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: at, UpdatedAt: at, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true}
}
func externalHTTPChanged(before model.Task) model.Task {
	after := copyTaskHTTPTask(before)
	after.Version, after.UpdatedAt = before.Version+1, before.UpdatedAt.Add(time.Microsecond)
	return after
}
func externalHTTPWrite(row model.Task) store.TaskWrite {
	row = copyTaskHTTPTask(row)
	return store.TaskWrite{AssignedTo: row.AssignedTo, RequiredPlatform: row.RequiredPlatform, AllowAgents: row.AllowAgents, Title: row.Title, Description: row.Description, Properties: row.Properties, Status: row.Status, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn}
}
func externalHTTPAPI(row model.Task) api.Task {
	row = copyTaskHTTPTask(row)
	return api.Task{ID: row.ID, ProjectID: row.ProjectID, Title: row.Title, Description: row.Description, Properties: row.Properties, Status: string(row.Status), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy, AssignedTo: row.AssignedTo, AllowAgents: row.AllowAgents, Ready: row.Ready}
}
func externalHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("external dependency DAO argument: got %#v, want %#v", actual, expected)
		panic("external dependency DAO argument mismatch")
	}
}
func (f *externalHTTPFixture) noStorage() {
	f.store.ReadSnapshotCall, f.store.WriteProjectCall = nil, nil
}
func (f *externalHTTPFixture) read(row model.Task) { f.noStorage(); f.expectRead(row) }

// The supplied result is an independent fixture row, not a read derived from a captured write.
func (f *externalHTTPFixture) mutation(current *model.Task, values *store.TaskWrite, result *model.Task, dependencies []model.Task, validateDependencies bool) {
	f.noStorage()
	if current != nil {
		declared := copyTaskHTTPTask(*current)
		current = &declared
	}
	if values != nil {
		declared := copyTaskHTTPWrite(*values)
		values = &declared
	}
	output := result
	if result != nil {
		declared := copyTaskHTTPTask(*result)
		result = &declared
	}
	dependencies = copyTaskHTTPRows(dependencies)
	want := map[string]int{"writeScope": 1, "access": 1}
	if current != nil {
		want["current"] = 1
	}
	if validateDependencies {
		want["prerequisites"] = 1
		for _, id := range values.DependsOn {
			want["reachable:"+id] = 1
		}
	}
	if result != nil {
		want["mutation"] = 1
		if current != nil {
			want["drain"], want["receipts"] = 1, 1
		}
		if current == nil || current.Status != result.Status {
			want["audience"] = 1
		}
	}
	plan := newHTTPCallPlan(f.t, want)
	base := newTaskHTTPMockBase(f.t, "external write")
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base}
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}

	project.ProjectAccessFn = func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		plan.Called("access")
		f.require(ctx, f.project.ID)
		externalHTTPCheck(f.t, actor, f.principal)
		return taskHTTPMockAccess(f.project, actor), nil
	}
	if current != nil {
		writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
			plan.Called("current")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, id, current.ID)
			return copyTaskHTTPTask(*current), nil
		}
	}
	if validateDependencies {
		writer.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			plan.Called("prerequisites")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, ids, values.DependsOn)
			return copyTaskHTTPRows(dependencies), nil
		}
		writer.ReachableFn = func(ctx context.Context, start, target string, replacement store.DependencyReplacement) (bool, error) {
			plan.Called("reachable:" + start)
			f.require(ctx, f.project.ID)
			if !slices.Contains(values.DependsOn, start) || replacement.TaskID != target || !slices.Equal(replacement.DependsOn, values.DependsOn) || current != nil && target != current.ID {
				unexpectedHTTPCall(f.t, "external dependency cycle arguments")
			}
			return false, nil
		}
	}
	if result != nil {
		apply := func(ctx context.Context, id string, got store.TaskWrite) (model.Task, error) {
			plan.Called("mutation")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, got, *values)
			if current == nil {
				if parsed, err := uuid.Parse(id); err != nil || parsed.Version() != 4 {
					unexpectedHTTPCall(f.t, "created Task UUIDv4")
				}
				result.ID = id
				output.ID = id
			} else {
				externalHTTPCheck(f.t, id, current.ID)
			}
			return copyTaskHTTPTask(*result), nil
		}
		if current == nil {
			writer.CreateTaskFn = apply
		} else {
			writer.UpdateTaskFn = apply
			sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, got store.TaskSessionDrain) error {
				plan.Called("drain")
				f.require(ctx, f.project.ID)
				externalHTTPCheck(f.t, id, current.ID)
				externalHTTPCheck(f.t, got, store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}, SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}})
				return nil
			}
			sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, got store.TaskSessionReceiptTransition) error {
				plan.Called("receipts")
				f.require(ctx, f.project.ID)
				externalHTTPCheck(f.t, id, current.ID)
				externalHTTPCheck(f.t, got, store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}})
				return nil
			}
		}
		capture.FreezeAudienceFn = func(ctx context.Context, projectID string, types []string) ([]store.WebhookAudience, error) {
			plan.Called("audience")
			f.require(ctx, f.project.ID)
			externalHTTPCheck(f.t, projectID, f.project.ID)
			kind := protocol.StatusChanged
			if current == nil {
				kind = protocol.Created
			}
			externalHTTPCheck(f.t, types, []string{kind})
			return []store.WebhookAudience{}, nil
		}
	}
	f.store.WriteProjectCall = func(ctx context.Context, id string, fn func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.Called("writeScope")
		externalHTTPCheck(f.t, id, f.project.ID)
		if fn == nil || f.active {
			unexpectedHTTPCall(f.t, "external write callback")
		}
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		err := fn(scope)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func (f *externalHTTPFixture) page(rows []model.Task, status *model.TaskStatus, ready *bool) {
	f.noStorage()
	f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}, Status: status, Ready: ready}}, []store.TaskPage{{Items: rows}})
}
func (f *externalHTTPFixture) graph(root string, rows []model.Task) {
	f.noStorage()
	result := make([]model.GraphTask, len(rows))
	for index, row := range rows {
		result[index] = model.GraphTask{ID: row.ID, TitlePreview: row.Title, Status: row.Status, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy, AllowAgents: row.AllowAgents, Ready: row.Ready, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt}
	}
	f.expectGraph(root, result)
}
func externalHTTPID(letter byte) string {
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", string(slices.Repeat([]byte{letter}, 8)), string(slices.Repeat([]byte{letter}, 4)), string(slices.Repeat([]byte{letter}, 3)), string(slices.Repeat([]byte{letter}, 3)), string(slices.Repeat([]byte{letter}, 12)))
}

func (f *externalHTTPFixture) update(before, after model.Task, patch map[string]any, dependencies []model.Task, changed bool) api.Task {
	values := externalHTTPWrite(after)
	var result *model.Task
	if changed {
		result = &after
	}
	f.mutation(&before, &values, result, dependencies, true)
	got := updateHTTPTask(f.t, f.handler, externalHTTPAPI(before), patch)
	externalHTTPCheck(f.t, got, externalHTTPAPI(after))
	return got
}

func (f *externalHTTPFixture) status(before, after model.Task) api.Task {
	values := externalHTTPWrite(after)
	var result *model.Task
	if before.Status != after.Status {
		result = &after
	}
	f.mutation(&before, &values, result, nil, false)
	got := setHTTPTask(f.t, f.handler, externalHTTPAPI(before), string(after.Status))
	externalHTTPCheck(f.t, got, externalHTTPAPI(after))
	return got
}

func (f *externalHTTPFixture) rejectedPatch(current model.Task, body string, semantic bool, code string) {
	if semantic {
		f.mutation(&current, nil, nil, nil, false)
	} else {
		f.noStorage()
	}
	status := http.StatusBadRequest
	if code == "version_conflict" || code == "dependency_unsatisfied" {
		status = http.StatusConflict
	}
	assertProjectError(f.t, projectRequest(f.handler, http.MethodPatch, taskPath(externalHTTPAPI(current)), body), status, code)
}
