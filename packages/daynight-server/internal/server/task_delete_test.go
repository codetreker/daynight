package server

import (
	"bytes"
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTaskHTTPSoftDeletionAndGoneResources(t *testing.T) {
	var logs bytes.Buffer
	f, handler, task := stepsHTTPFixture(t, &logs)
	path := taskPath(task)
	current := f.target
	current.Title = "Private deleted body"
	deletedAt := current.UpdatedAt.Add(time.Minute)
	prepareWrite := func(success bool, readError error) {
		base := newTaskHTTPMockBase(t, "Task deletion")
		want := map[string]int{"write": 1, "access": 1, "task": 1}
		if success {
			for _, name := range []string{"dependents", "delete", "drain", "receipts", "invalidate", "capture"} {
				want[name] = 1
			}
		}
		plan := newHTTPCallPlan(t, want)
		projects := &taskHTTPProjectWriterMock{taskHTTPMockBase: base}
		projects.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
			plan.Called("access")
			if p != f.principal || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete actor")
			}
			return taskHTTPMockAccess(f.project, p), nil
		}
		projects.InvalidateTaskCacheFn = func(ctx context.Context) error { plan.Called("invalidate"); return ctx.Err() }
		writer := &taskHTTPWriterMock{taskHTTPMockBase: base}
		writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
			plan.Called("task")
			if id != current.ID || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete Task identity")
			}
			return copyTaskHTTPTask(current), readError
		}
		writer.DependentIDsFn = func(ctx context.Context, id string) ([]string, error) {
			plan.Called("dependents")
			if id != current.ID || ctx.Err() != nil {
				unexpectedHTTPCall(t, "dependent Task identity")
			}
			return []string{}, nil
		}
		writer.DeleteTaskFn = func(ctx context.Context, id string, remove bool) (model.TaskTombstone, error) {
			plan.Called("delete")
			if id != current.ID || remove || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete arguments")
			}
			return model.TaskTombstone{ProjectID: current.ProjectID, ID: current.ID, Version: 2, DeletedAt: deletedAt}, nil
		}
		sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base}
		sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, v store.TaskSessionDrain) error {
			plan.Called("drain")
			if id != current.ID || v.ActiveClaim != nil || v.SourceLifecycle != "active" || v.GraceSeconds != 60 || v.TimelineField != "lastTimelineSeq" || v.LifecycleField != "lifecycle" || !reflect.DeepEqual(v.RemoveFields, []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}) || !reflect.DeepEqual(v.SnapshotValues, map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}) {
				unexpectedHTTPCall(t, "delete Session drain")
			}
			return ctx.Err()
		}
		sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, v store.TaskSessionReceiptTransition) error {
			plan.Called("receipts")
			if id != current.ID || v.LifecycleField != "lifecycle" || v.Lifecycle != "draining" || v.StateField != "state" || v.PreviousState != "accepted" || v.NextState != "rejected" || !reflect.DeepEqual(v.RemoveFields, []string{"error"}) {
				unexpectedHTTPCall(t, "delete receipt transition")
			}
			return ctx.Err()
		}
		capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base, FreezeAudienceFn: func(ctx context.Context, id string, types []string) ([]store.WebhookAudience, error) {
			plan.Called("capture")
			if id != current.ProjectID || !reflect.DeepEqual(types, []string{protocol.Deleted}) || ctx.Err() != nil {
				unexpectedHTTPCall(t, "delete source")
			}
			return []store.WebhookAudience{}, nil
		}}
		scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return projects }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
		f.store.WriteProjectCall = func(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
			plan.Called("write")
			if id != current.ProjectID || run == nil {
				unexpectedHTTPCall(t, "delete Project scope")
			}
			err := run(scope)
			if err != nil {
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		}
	}
	prepareWrite(false, nil)
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path, `{"version":2}`), 409, "version_conflict")
	prepareWrite(true, nil)
	response := projectRequest(handler, http.MethodDelete, path, jsonBody(t, api.TaskDeleteRequest{Version: task.Version}))
	if response.Code != 204 || response.Body.Len() != 0 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("delete result: %d %s %v", response.Code, response.Body, response.Header())
	}
	for _, call := range []struct{ method, suffix, body string }{{http.MethodGet, "", ""}, {http.MethodDelete, "", `{"version":2}`}, {http.MethodPatch, "", `{"version":2,"title":"Changed"}`}, {http.MethodPut, "/status", `{"version":2,"status":"done"}`}, {http.MethodGet, "/attachments", ""}, {http.MethodGet, "/attachments/files/evidence.txt", ""}, {http.MethodGet, "/preview/evidence.txt", ""}} {
		if call.method == http.MethodGet {
			counts := map[string]int{"task": 1}
			if call.suffix != "" {
				counts = map[string]int{"presence": 1}
			}
			f.expectSnapshot(counts, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
				reader.TaskFn = func(ctx context.Context, project, id string) (model.Task, error) {
					f.require(ctx, project)
					plan.Called("task")
					if id != task.ID {
						unexpectedHTTPCall(t, "deleted Task read")
					}
					return model.Task{}, model.ErrTaskDeleted
				}
				reader.TaskPresenceFn = func(ctx context.Context, project, id string) (store.TaskPresence, error) {
					f.require(ctx, project)
					plan.Called("presence")
					if id != task.ID {
						unexpectedHTTPCall(t, "deleted attachment parent")
					}
					return store.TaskPresence{Found: true, DeletedAt: &deletedAt}, nil
				}
			})
		} else {
			prepareWrite(false, model.ErrTaskDeleted)
		}
		assertProjectError(t, projectRequest(handler, call.method, path+call.suffix, call.body), 410, "task_deleted")
	}
	f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}}}, []store.TaskPage{{Items: []model.Task{}}})
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(task.ProjectID), ""), 200)
	if len(page.Items) != 0 {
		t.Fatal("deleted Task is still listed")
	}
	if !strings.Contains(logs.String(), `"phase":"delete"`) || !strings.Contains(logs.String(), `"cause":"task_deleted"`) || strings.Contains(logs.String(), current.Title) {
		t.Fatalf("missing or unsafe deletion diagnostics: %s", &logs)
	}
}
