package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func workerHTTPSummary(task model.Task) model.TaskViewRecord {
	return model.TaskViewRecord{ID: task.ID, TitlePreview: task.Title, Status: task.Status, Version: task.Version,
		Properties: task.Properties, DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn,
		RequiredPlatform: task.RequiredPlatform, AssignedTo: task.AssignedTo, AllowAgents: task.AllowAgents,
		CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt, StartedAt: task.StartedAt, CompletedAt: task.CompletedAt}
}

func TestWorkerHTTPChangesAppearInTaskSync(t *testing.T) {
	f := newTaskHTTPFixture(t)
	current := workerHTTPTask(t)
	path := taskCollection(current.ProjectID) + "/" + current.ID
	f.expectSync([]model.TaskViewRecord{workerHTTPSummary(current)}, []model.TaskAssigneeFact{}, nil)
	baseline := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), ""), http.StatusOK)
	epoch, observed := baseline.Epoch, baseline.ObservedAt
	if epoch != taskHTTPEpoch || !observed.Equal(f.observed) {
		t.Fatal("baseline summary changed its declared observation")
	}
	assertSummary := func(full api.Task, expected model.Task) {
		t.Helper()
		expected = copyTaskHTTPTask(expected)
		f.expectSnapshot(map[string]int{"task": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
			reader.TaskFn = func(ctx context.Context, projectID, id string) (model.Task, error) {
				f.require(ctx, projectID)
				plan.Called("task")
				if id != expected.ID {
					t.Fatal("property read changed Task identity")
				}
				return copyTaskHTTPTask(expected), nil
			}
		})
		properties := propertyResource(t, f.handler, http.MethodGet, path+"/properties", nil)
		if properties.Version != full.Version || !reflect.DeepEqual(properties.Properties, map[string]json.RawMessage(expected.Properties)) {
			t.Fatal("worker property resource advanced or changed canonical values")
		}
		query := "?epoch=" + epoch + "&since=" + url.QueryEscape(observed.Format(time.RFC3339Nano))
		lower := observed.Add(-10 * time.Second)
		f.observed = f.observed.Add(time.Second)
		f.expectSync([]model.TaskViewRecord{workerHTTPSummary(expected)}, []model.TaskAssigneeFact{}, &lower)
		response := projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID)+query, "")
		window := decodeResponse[api.TaskSync](t, response, http.StatusOK)
		if window.Mode != "delta" || window.Epoch != epoch || !window.ObservedAt.Equal(f.observed) {
			t.Fatal("worker mutation changed summary epoch or observation window")
		}
		found := false
		for _, summary := range window.Tasks {
			if summary.ID != full.ID {
				continue
			}
			found = true
			if summary.AllowAgents != full.AllowAgents || summary.Status != full.Status || summary.Version != strconv.FormatInt(full.Version, 10) || !summary.UpdatedAt.Equal(full.UpdatedAt) || !reflect.DeepEqual(summary.StartedAt, full.StartedAt) || !reflect.DeepEqual(summary.CompletedAt, full.CompletedAt) || summary.Properties == nil || !reflect.DeepEqual(summary.Properties, properties.Properties) {
				t.Fatalf("worker summary disagrees with full task: summary=%+v task=%+v", summary, full)
			}
		}
		if !found {
			t.Fatal("summary overlap omitted recently changed Worker task")
		}
		observed = window.ObservedAt
	}
	body := workerClaimBody(current.Version)
	claimedAt := current.UpdatedAt.Add(time.Second)
	worker := model.WorkerClaim{ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string), UserID: f.principal.UserID,
		Machine:  model.WorkerMachine{ID: body["machine"].(map[string]any)["id"].(string), Name: "Worker machine"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr,
		WorktreeID: body["worktreeId"].(string), State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
	claimed := current
	claimed.Status, claimed.Version, claimed.Ready = model.TaskInProgress, current.Version+1, false
	claimed.StartedAt, claimed.UpdatedAt = &claimedAt, claimedAt
	claimed.Properties = workerHTTPProperties(t, current.Properties, &worker)
	values := workerHTTPWriteValues(claimed)
	plan := expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, claimed, &claimedAt)
	full := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim", jsonBody(t, body)), http.StatusOK)
	plan.check()
	assertSummary(full, claimed)
	current = claimed
	native := "private-native-session"
	worker.Phase, worker.Herdr, worker.NativeSessionID = model.WorkerExecuting, &model.WorkerHerdr{Session: "w", WorkspaceID: "workspace", PaneID: "private-pane"}, &native
	executing := current
	executing.Version, executing.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Second)
	executing.Properties = workerHTTPProperties(t, current.Properties, &worker)
	update := map[string]any{"version": current.Version, "claimId": worker.ClaimID, "phase": "executing", "herdr": map[string]any{"session": "w", "workspaceId": "workspace", "paneId": "private-pane"}, "nativeSessionId": native}
	values = workerHTTPWriteValues(executing)
	plan = expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, executing, nil)
	full = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPatch, path+"/worker-claim", jsonBody(t, update)), http.StatusOK)
	plan.check()
	assertSummary(full, executing)
	current = executing
	update["version"] = current.Version
	plan = expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, nil, model.Task{}, nil)
	noop := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPatch, path+"/worker-claim", jsonBody(t, update)), http.StatusOK)
	plan.check()
	if !reflect.DeepEqual(noop, full) {
		t.Fatal("same-value Worker update changed version, timing or summary fields")
	}
	assertSummary(noop, current)
	worker.State = model.WorkerReleased
	released := current
	released.Status, released.Version, released.Ready = model.TaskTodo, current.Version+1, true
	released.StartedAt, released.CompletedAt, released.UpdatedAt = nil, nil, current.UpdatedAt.Add(time.Second)
	released.Properties = workerHTTPProperties(t, current.Properties, &worker)
	values = workerHTTPWriteValues(released)
	plan = expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, released, nil)
	full = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim/release", jsonBody(t, map[string]any{"version": current.Version, "claimId": worker.ClaimID, "stoppedConfirmed": true})), http.StatusOK)
	plan.check()
	assertSummary(full, released)
	if full.Status != "todo" || full.StartedAt != nil || full.CompletedAt != nil {
		t.Fatal("release lost status timing contract")
	}
	f.expectRead(released)
	if read := readHTTPTask(t, f.handler, full); !reflect.DeepEqual(read, full) || apiWorker(t, read.Properties).NativeSessionID == nil || *apiWorker(t, read.Properties).NativeSessionID != native {
		t.Fatal("summary projection changed full execution resource")
	}
	current = released
	withdrawn := current
	withdrawn.AllowAgents, withdrawn.Version, withdrawn.UpdatedAt = false, current.Version+1, current.UpdatedAt.Add(time.Second)
	withdrawn.Properties = workerHTTPProperties(t, current.Properties, nil)
	values = workerHTTPWriteValues(withdrawn)
	plan = expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, withdrawn, nil)
	full = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim/withdraw", jsonBody(t, map[string]any{"version": current.Version, "claimId": worker.ClaimID})), http.StatusOK)
	plan.check()
	assertSummary(full, withdrawn)
	if apiWorker(t, full.Properties) != nil || full.AllowAgents || full.Status != "todo" || full.StartedAt != nil || full.CompletedAt != nil {
		t.Fatal("withdrawal retained released record or automatic permission")
	}
}
