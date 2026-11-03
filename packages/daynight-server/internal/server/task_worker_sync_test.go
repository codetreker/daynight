package server

import (
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestWorkerHTTPChangesAppearInTaskSync(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Interoperable execution"), map[string]any{"allowAgents": true})
	baseline := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
	epoch, observed := baseline.Epoch, baseline.ObservedAt
	assertSummary := func(full api.Task) {
		t.Helper()
		// Synchronization carries canonical properties even when the ordinary task
		// request uses the legacy Worker projection.
		properties := propertyResource(t, handler, http.MethodGet, taskPath(full)+"/properties", nil)
		if properties.Version != full.Version {
			t.Fatal("worker property resource advanced unexpectedly")
		}
		query := "?epoch=" + epoch + "&since=" + url.QueryEscape(observed.Format(time.RFC3339Nano))
		response := projectRequest(handler, http.MethodGet, syncPath(project.ID)+query, "")
		window := decodeResponse[api.TaskSync](t, response, http.StatusOK)
		if window.Mode != "delta" || window.Epoch != epoch || window.ObservedAt.Before(observed) {
			t.Fatal("worker mutation changed the summary epoch or invalidated its observation window")
		}
		found := false
		for _, summary := range window.Tasks {
			if summary.ID != full.ID {
				continue
			}
			found = true
			if summary.AllowAgents != full.AllowAgents || summary.Status != full.Status || summary.Version != strconv.FormatInt(full.Version, 10) || !summary.UpdatedAt.Equal(full.UpdatedAt) || !reflect.DeepEqual(summary.StartedAt, full.StartedAt) || !reflect.DeepEqual(summary.CompletedAt, full.CompletedAt) || summary.Properties == nil || !reflect.DeepEqual(summary.Properties, properties.Properties) {
				t.Fatalf("worker change summary disagrees with the full task: summary=%+v task=%+v", summary, full)
			}
		}
		if !found {
			t.Fatal("summary overlap window omitted the recently changed worker task")
		}
		observed = window.ObservedAt
	}
	body := workerClaimBody(task.Version)
	task = claimHTTPWorker(t, handler, task, body)
	assertSummary(task)
	update := map[string]any{"version": task.Version, "claimId": apiWorker(t, task.Properties).ClaimID, "phase": "executing", "herdr": map[string]any{"session": "w", "workspaceId": "workspace", "paneId": "private-pane"}, "nativeSessionId": "private-native-session"}
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task)+"/worker-claim", jsonBody(t, update)), http.StatusOK)
	assertSummary(task)
	update["version"] = task.Version
	noop := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task)+"/worker-claim", jsonBody(t, update)), http.StatusOK)
	if !reflect.DeepEqual(noop, task) {
		t.Fatal("same-value worker update changed task version, timing or summary-relevant fields")
	}
	assertSummary(noop)
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": apiWorker(t, task.Properties).ClaimID, "stoppedConfirmed": true})), http.StatusOK)
	assertSummary(task)
	if task.Status != "todo" || task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatal("release did not retain the task status timing contract")
	}
	if current := readHTTPTask(t, handler, task); !reflect.DeepEqual(current, task) || apiWorker(t, current.Properties).NativeSessionID == nil || *apiWorker(t, current.Properties).NativeSessionID != "private-native-session" {
		t.Fatal("summary projection unexpectedly changed the full execution resource")
	}
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/withdraw", jsonBody(t, map[string]any{"version": task.Version, "claimId": apiWorker(t, task.Properties).ClaimID})), http.StatusOK)
	assertSummary(task)
	if apiWorker(t, task.Properties) != nil || task.AllowAgents || task.Status != "todo" || task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatal("withdrawal did not clear the released record and automatic permission")
	}

}
