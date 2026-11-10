package server

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func startupTaskModel(value api.Task) model.Task {
	var platform *model.TaskPlatform
	if value.RequiredPlatform != nil {
		v := model.TaskPlatform(*value.RequiredPlatform)
		platform = &v
	}
	return model.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description,
		Properties: taskproperty.Clone(value.Properties), Status: model.TaskStatus(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt,
		CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn,
		BlockedBy: value.BlockedBy, RequiredPlatform: platform, AssignedTo: value.AssignedTo, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

func startupReportValue(t *testing.T, body map[string]any) sp.StartupReport {
	t.Helper()
	var value sp.StartupReport
	if err := json.Unmarshal([]byte(jsonBody(t, body)), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func startupReportedTask(t *testing.T, current model.Task, report sp.StartupReport) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	result.Properties["sessionStartup"] = rawProperty(t, report)
	result.Version, result.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Second)
	return result
}

func startupReplaceWorker(t *testing.T, current model.Task, change func(*api.WorkerClaim)) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	worker := apiWorker(t, result.Properties)
	change(worker)
	result.Properties["worker"] = rawProperty(t, worker)
	return result
}

// Every request supplies its own immutable business result; a returned mutation
// never supplies the later HTTP readback.
type startupHTTPOperations struct {
	t       *testing.T
	observe func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error)
	update  func(context.Context, model.Principal, string, string, taskcore.UpdateWorker) (model.Task, error)
	claim   func(context.Context, model.Principal, string, string, taskcore.ClaimWorker) (model.Task, error)
	release func(context.Context, model.Principal, string, string, taskcore.ReleaseWorker) (model.Task, error)
}

func startupTaskOperations(t *testing.T, f *sessionHTTPFixture) taskhttp.TaskService {
	f.startup = &startupHTTPOperations{t: t}
	return f.startup
}
func (s *startupHTTPOperations) Get(context.Context, model.Principal, string, string) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.Get")
	panic("unreachable")
}
func (s *startupHTTPOperations) Observe(ctx context.Context, p model.Principal, project, id string) (taskservice.TaskObservation, error) {
	if s.observe == nil {
		unexpectedHTTPCall(s.t, "startup Task.Observe")
	}
	return s.observe(ctx, p, project, id)
}
func (s *startupHTTPOperations) UpdateWorker(ctx context.Context, p model.Principal, project, id string, in taskcore.UpdateWorker) (model.Task, error) {
	if s.update == nil {
		unexpectedHTTPCall(s.t, "startup Task.UpdateWorker")
	}
	return s.update(ctx, p, project, id, in)
}
func (s *startupHTTPOperations) ClaimWorker(ctx context.Context, p model.Principal, project, id string, in taskcore.ClaimWorker) (model.Task, error) {
	if s.claim == nil {
		unexpectedHTTPCall(s.t, "startup Task.ClaimWorker")
	}
	return s.claim(ctx, p, project, id, in)
}
func (s *startupHTTPOperations) ReleaseWorker(ctx context.Context, p model.Principal, project, id string, in taskcore.ReleaseWorker) (model.Task, error) {
	if s.release == nil {
		unexpectedHTTPCall(s.t, "startup Task.ReleaseWorker")
	}
	return s.release(ctx, p, project, id, in)
}

func startupClone[T any](t *testing.T, value T) T {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err = json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func startupUpdateInput(f *sessionHTTPFixture, report *sp.StartupReport) taskcore.UpdateWorker {
	return taskcore.UpdateWorker{Version: f.task.Version, ClaimID: f.snapshot.ClaimID, StartupReport: report}
}
func startupConflict() error {
	return &model.Fault{Code: "claim_conflict", Message: "The Worker claim changed."}
}
func startupCheckCall(t *testing.T, f *sessionHTTPFixture, ctx context.Context, p model.Principal, project, id string, want model.Principal) {
	t.Helper()
	if ctx == nil || ctx.Err() != nil || httpx.RequestID(ctx) != "project-test" || p != want || project != f.task.ProjectID || id != f.task.ID {
		t.Errorf("startup operation changed request context, principal or resource: %v, %#v, %q, %q", ctx, p, project, id)
		panic("invalid startup operation")
	}
	requireOperationHTTPContext(t, ctx)
}
func startupOnce(t *testing.T) func() {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != 1 {
			t.Errorf("startup operation calls=%d, want 1", calls)
		}
	})
	return func() {
		calls++
		if calls != 1 {
			unexpectedHTTPCall(t, "extra startup operation")
		}
	}
}
func startupExpectUpdate(t *testing.T, f *sessionHTTPFixture, in taskcore.UpdateWorker, result model.Task, resultErr error, principal model.Principal, beforeReturn func()) {
	t.Helper()
	// Copy each nullable level: omitted, explicit null, and a value are distinct.
	expected := in
	if in.Phase != nil {
		v := *in.Phase
		expected.Phase = &v
	}
	if in.Herdr != nil {
		var v *model.WorkerHerdr
		if *in.Herdr != nil {
			h := **in.Herdr
			v = &h
		}
		expected.Herdr = &v
	}
	if in.NativeSessionID != nil {
		var v *string
		if *in.NativeSessionID != nil {
			q := **in.NativeSessionID
			v = &q
		}
		expected.NativeSessionID = &v
	}
	if in.StartupReport != nil {
		v := startupClone(t, *in.StartupReport)
		expected.StartupReport = &v
	}
	result = startupClone(t, result)
	called := startupOnce(t)
	f.startup.update = func(ctx context.Context, p model.Principal, project, id string, actual taskcore.UpdateWorker) (model.Task, error) {
		called()
		startupCheckCall(t, f, ctx, p, project, id, principal)
		if !reflect.DeepEqual(actual, expected) {
			t.Errorf("startup parsed UpdateWorker=%#v, want %#v", actual, expected)
			panic("startup input changed")
		}
		if beforeReturn != nil {
			beforeReturn()
		}
		return startupClone(t, result), resultErr
	}
}
func startupExpectRelease(t *testing.T, f *sessionHTTPFixture, in taskcore.ReleaseWorker, result model.Task) {
	t.Helper()
	expected := in
	result = startupClone(t, result)
	called := startupOnce(t)
	f.startup.release = func(ctx context.Context, p model.Principal, project, id string, actual taskcore.ReleaseWorker) (model.Task, error) {
		called()
		startupCheckCall(t, f, ctx, p, project, id, f.handler.principal)
		if actual != expected {
			t.Errorf("startup parsed ReleaseWorker=%#v, want %#v", actual, expected)
			panic("release input changed")
		}
		return startupClone(t, result), nil
	}
}
func startupExpectClaim(t *testing.T, f *sessionHTTPFixture, in taskcore.ClaimWorker, result model.Task) {
	t.Helper()
	expected := in
	result = startupClone(t, result)
	called := startupOnce(t)
	f.startup.claim = func(ctx context.Context, p model.Principal, project, id string, actual taskcore.ClaimWorker) (model.Task, error) {
		called()
		startupCheckCall(t, f, ctx, p, project, id, f.handler.principal)
		if actual != expected {
			t.Errorf("startup parsed ClaimWorker=%#v, want %#v", actual, expected)
			panic("claim input changed")
		}
		return startupClone(t, result), nil
	}
}
func startupExpectTaskRead(t *testing.T, f *sessionHTTPFixture, value model.Task) {
	t.Helper()
	supplied := taskservice.TaskObservation{Task: startupClone(t, value), Epoch: "startup-epoch"}
	called := startupOnce(t)
	f.startup.observe = func(ctx context.Context, p model.Principal, project, id string) (taskservice.TaskObservation, error) {
		called()
		startupCheckCall(t, f, ctx, p, project, id, f.handler.principal)
		requireExactOperationHTTPContext(t, ctx)
		return taskservice.TaskObservation{Task: startupClone(t, supplied.Task), Epoch: supplied.Epoch}, nil
	}
}
func startupExpectCurrent(t *testing.T, f *sessionHTTPFixture, snapshot sp.Snapshot, report *sp.StartupReport, extended bool) {
	t.Helper()
	snapshot = startupClone(t, snapshot)
	var supplied *sp.StartupReport
	if report != nil {
		v := startupClone(t, *report)
		supplied = &v
	}
	called := startupOnce(t)
	read := func(ctx context.Context, p model.Principal, project, id string) (map[string]any, error) {
		called()
		startupCheckCall(t, f, ctx, p, project, id, f.handler.principal)
		out := map[string]any{"status": "registered", "session": startupClone(t, snapshot)}
		if extended {
			if supplied == nil {
				out["startupReport"] = nil
			} else {
				out["startupReport"] = startupClone(t, *supplied)
			}
		}
		return out, nil
	}
	if extended {
		f.ops.CurrentWithStartup = read
	} else {
		f.ops.Current = read
	}
}

func startupTaskDocument(t *testing.T, value model.Task) api.Task {
	t.Helper()
	var platform *string
	if value.RequiredPlatform != nil {
		v := string(*value.RequiredPlatform)
		platform = &v
	}
	return api.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description, Properties: taskproperty.Clone(value.Properties), Status: string(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt, CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn, BlockedBy: value.BlockedBy, AssignedTo: value.AssignedTo, RequiredPlatform: platform, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

func (s *startupHTTPOperations) Create(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.Create")
	panic("unreachable")
}
func (s *startupHTTPOperations) Update(context.Context, model.Principal, string, string, taskcore.UpdateTask) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.Update")
	panic("unreachable")
}
func (s *startupHTTPOperations) Delete(context.Context, model.Principal, string, string, taskcore.DeleteTask) error {
	unexpectedHTTPCall(s.t, "startup Task.Delete")
	panic("unreachable")
}
func (s *startupHTTPOperations) SetStatus(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.SetStatus")
	panic("unreachable")
}
func (s *startupHTTPOperations) List(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
	unexpectedHTTPCall(s.t, "startup Task.List")
	panic("unreachable")
}
func (s *startupHTTPOperations) Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error) {
	unexpectedHTTPCall(s.t, "startup Task.Graph")
	panic("unreachable")
}
func (s *startupHTTPOperations) Assignees(context.Context, model.Principal, string, taskservice.TaskAssigneesRequest) (model.TaskAssignees, error) {
	unexpectedHTTPCall(s.t, "startup Task.Assignees")
	panic("unreachable")
}
func (s *startupHTTPOperations) SetProperty(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.SetProperty")
	panic("unreachable")
}
func (s *startupHTTPOperations) RemoveProperty(context.Context, model.Principal, string, string, string, int64) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.RemoveProperty")
	panic("unreachable")
}
func (s *startupHTTPOperations) WithdrawWorker(context.Context, model.Principal, string, string, taskcore.WithdrawWorker) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.WithdrawWorker")
	panic("unreachable")
}
func (s *startupHTTPOperations) ResumeWorker(context.Context, model.Principal, string, string, taskcore.ResumeWorker) (model.Task, error) {
	unexpectedHTTPCall(s.t, "startup Task.ResumeWorker")
	panic("unreachable")
}

var _ taskhttp.TaskService = (*startupHTTPOperations)(nil)
