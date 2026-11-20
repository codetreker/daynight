package worker

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

func TestWorkerRoutesLifecycleAndInvalidRequests(t *testing.T) {
	f := newWorkerRouteFixture(t)
	request := func(method, path, body string, versions ...string) *httptest.ResponseRecorder {
		t.Helper()
		return f.request(method, path, body, nil, versions...)
	}
	check := func(w *httptest.ResponseRecorder, status int, code string) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status %d expected %d: %s", w.Code, status, w.Body)
		}
		if code != "" {
			var body api.ErrorResponse
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Error.Code != code {
				t.Fatalf("error response: %s (%v)", w.Body, err)
			}
		}
	}
	const id = "30000000-0000-4000-8000-000000000001"
	path := "/api/v1/me/workers/" + id
	missing := &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: model.ErrNotFound}
	check(f.request("GET", path, "", &workerRouteCall{name: "Get", args: []any{id}, err: missing}), 404, "not_found")
	check(f.request("GET", path+"/configuration", "", &workerRouteCall{name: "Configuration", args: []any{id}, err: missing}), 404, "not_found")
	check(request("GET", "/api/v1/me/workers?limit=0", ""), 400, "invalid_input")
	check(request("GET", "/api/v1/me/workers/bad", ""), 400, "invalid_input")
	check(request("GET", path+"?x=1", ""), 400, "invalid_input")
	check(request("GET", path+"/configuration?x=1", ""), 400, "invalid_input")
	check(request("POST", path+"/report?x=1", jsonBody(t, workerSnapshotReportBody())), 400, "invalid_input")
	check(request("POST", path+"/report", "{}"), 400, "invalid_input")
	aware := workerSnapshotReportBody()
	aware["configuration"] = map[string]any{"bootstrap": nil, "observation": nil}
	check(request("POST", path+"/report", jsonBody(t, aware), "2"), 400, "invalid_input")
	check(request("POST", path+"/report", jsonBody(t, aware), "1", "1"), 400, "invalid_input")
	unknown := workerSnapshotReportBody()
	unknown["unknown"] = true
	check(request("POST", path+"/report", jsonBody(t, unknown)), 400, "invalid_input")
	reportResult := workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt.Add(-time.Second)}
	report := func(body map[string]any, result workerservice.WorkerReportResult, versions ...string) *httptest.ResponseRecorder {
		t.Helper()
		expected := model.WorkerReport{
			Telemetry:     capacityDecode[model.WorkerTelemetry](t, body),
			TaskInventory: capacityDecode[*model.WorkerTaskInventory](t, body["taskInventory"]),
			Configuration: capacityDecode[*model.WorkerConfigurationExchange](t, body["configuration"]),
		}
		return f.request("POST", path+"/report", jsonBody(t, body), &workerRouteCall{
			name: "Report", args: []any{id, expected}, result: result,
		}, versions...)
	}
	detailResponse := func(inventory, assistantHost, runtime bool) *httptest.ResponseRecorder {
		t.Helper()
		source := workerSnapshotReportBody()
		if !inventory {
			source["taskInventory"] = nil
		}
		if assistantHost {
			source["assistantHost"] = assistantHostBody()
		}
		if runtime {
			source["runtimeConfiguration"] = runtimeConfigurationBody()
		}
		result := workerservice.WorkerDetailResult{
			ObservedAt: capacityObservedAt,
			Worker:     capacityExpectedSnapshot(t, f.actor.UserID, id, source),
		}
		return f.request("GET", path, "", &workerRouteCall{name: "Get", args: []any{id}, result: result})
	}
	legacy := workerSnapshotReportBody()
	legacy["taskInventory"] = nil
	w := report(legacy, reportResult)
	check(w, 200, "")
	var receipt map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil || len(receipt) != 2 || w.Header().Get(workerConfigurationHeader) != "" {
		t.Fatalf("legacy receipt: %s %v", w.Body, err)
	}
	times := testsupport.DecodeResponse[api.WorkerReportResponse](t, w, 200)
	if times.ObservedAt != reportResult.ObservedAt || times.LastReportedAt != reportResult.LastReportedAt {
		t.Fatalf("legacy report timestamps: %+v", times)
	}
	w = detailResponse(false, false, false)
	detail := testsupport.DecodeResponse[api.WorkerDetailResponse](t, w, 200)
	if detail.Worker.ActiveTaskCount != nil || detail.Worker.TaskObservationState != "unavailable" {
		t.Fatalf("unknown inventory: %+v", detail.Worker)
	}
	observed := workerSnapshotReportBody()
	observed["assistantHost"] = assistantHostBody()
	observed["runtimeConfiguration"] = runtimeConfigurationBody()
	check(report(observed, reportResult), 200, "")
	w = detailResponse(true, true, true)
	detail = testsupport.DecodeResponse[api.WorkerDetailResponse](t, w, 200)
	if detail.Worker.ActiveTaskCount == nil || *detail.Worker.ActiveTaskCount != 0 ||
		detail.Worker.TaskObservationState != "observed" || detail.Worker.Telemetry.AssistantHost == nil {
		t.Fatalf("observed worker: %+v", detail.Worker)
	}
	if detail.Worker.Telemetry.RuntimeConfiguration == nil || detail.Worker.Telemetry.RuntimeConfiguration.Native.Model.Source != "local" {
		t.Fatalf("runtime configuration projection lost its source: %+v", detail.Worker.Telemetry)
	}
	delete(observed, "runtimeConfiguration")
	check(report(observed, reportResult), 200, "")
	detail = testsupport.DecodeResponse[api.WorkerDetailResponse](t, detailResponse(true, true, false), 200)
	if detail.Worker.Telemetry.RuntimeConfiguration != nil {
		t.Fatal("omitted runtime configuration retained stale sources")
	}
	zero := 0
	pageFact := workerservice.WorkerPage{ObservedAt: capacityObservedAt, Items: []api.WorkerSummary{{
		WorkerID: id, Platform: "linux", LastReportedAt: capacityObservedAt, TaskObservationState: "observed",
		TaskObservedAt: &capacityObservedAt, ActiveTaskCount: &zero,
	}}}
	page := testsupport.DecodeResponse[api.WorkerPage](t, f.request("GET", "/api/v1/me/workers", "",
		&workerRouteCall{name: "List", args: []any{model.PageRequest{Limit: 50}}, result: pageFact}), 200)
	if len(page.Items) != 1 || page.Items[0].WorkerID != id || page.ObservedAt != pageFact.ObservedAt || page.NextCursor != nil {
		t.Fatalf("worker page: %+v", page)
	}
	check(request("PUT", path+"/configuration", `{}`), 400, "invalid_input")
	check(request("PUT", path+"/configuration", `{"revision":"1","value":null}`), 400, "invalid_input")
	config := map[string]any{"maxConcurrent": 3, "pollIntervalMs": 60000, "recoveryLimit": 0, "preferPlatformSpecificTasks": false, "native": map[string]any{"agent": "codex", "model": nil, "args": []any{}}, "projects": []any{}, "toolPaths": map[string]any{"codex": map[string]any{"kind": "auto"}, "copilot": map[string]any{"kind": "auto"}}}
	check(request("PUT", path+"/configuration", jsonBody(t, map[string]any{"revision": 1, "value": config})), 400, "invalid_input")
	put := func(result model.WorkerConfigurationResource, refusal error) *httptest.ResponseRecorder {
		t.Helper()
		value := capacityDecode[model.WorkerConfiguration](t, config)
		value.PreserveArchiveSessions = true
		value.PreserveSudoCleanup = true
		value.PreserveWindowsProcessCleanup = true
		value.PreserveTaskTagFilter = true
		return f.request("PUT", path+"/configuration", jsonBody(t, map[string]any{"revision": "1", "value": config}),
			&workerRouteCall{name: "PutConfiguration", args: []any{id, "1", value}, result: result, err: refusal})
	}
	check(put(model.WorkerConfigurationResource{}, &model.Fault{
		Code: "configuration_not_initialized", Message: "Worker configuration is not initialized.",
	}), 409, "configuration_not_initialized")

	desired := func(revision string, maxConcurrent int64) *model.WorkerDesiredConfiguration {
		return &model.WorkerDesiredConfiguration{
			Revision: revision, UpdatedAt: capacityObservedAt, ValueValid: true,
			Value: model.WorkerConfiguration{
				MaxConcurrent: maxConcurrent, PollIntervalMs: 60000,
				Native:   model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}},
				Projects: []model.WorkerProjectConfiguration{},
				ToolPaths: model.WorkerToolPaths{
					Codex: &model.ToolPathChoice{Kind: "auto"}, Copilot: &model.ToolPathChoice{Kind: "auto"},
				},
			},
		}
	}
	observed["configuration"] = map[string]any{"bootstrap": config, "observation": nil, "toolPathsBootstrap": nil}
	initialized := reportResult
	initialized.Configuration = &model.WorkerConfigurationReceipt{Desired: desired("1", 3), ObservationRevision: "0"}
	w = report(observed, initialized, "1")
	check(w, 200, "")
	if w.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatalf("bootstrap response omitted its negotiated protocol: %v", w.Header())
	}
	initialFact := model.WorkerConfigurationResource{Desired: desired("1", 3), ObservationRevision: "0"}
	w = f.request("GET", path+"/configuration", "", &workerRouteCall{name: "Configuration", args: []any{id}, result: initialFact})
	resource := testsupport.DecodeResponse[model.WorkerConfigurationResource](t, w, 200)
	if resource.Desired == nil || resource.Desired.Revision != "1" || resource.Desired.Value.MaxConcurrent != 3 ||
		w.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatalf("configuration: %+v", resource)
	}
	config["maxConcurrent"] = 4
	updatedFact := model.WorkerConfigurationResource{Desired: desired("2", 4), ObservationRevision: "0"}
	w = put(updatedFact, nil)
	resource = testsupport.DecodeResponse[model.WorkerConfigurationResource](t, w, 200)
	if resource.Desired == nil || resource.Desired.Revision != "2" || resource.Desired.Value.MaxConcurrent != 4 ||
		w.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatalf("updated configuration: %+v", resource)
	}
	check(put(model.WorkerConfigurationResource{}, &model.Fault{Code: "version_conflict", Message: "Configuration revision has changed."}), 409, "version_conflict")
	observed["configuration"] = nil
	check(request("POST", path+"/report", jsonBody(t, observed), "1"), 400, "invalid_input")
	check(request("POST", "/api/v1/me/workers", ""), 405, "method_not_allowed")
	check(request("GET", path+"/report", ""), 405, "method_not_allowed")
	check(request("POST", path+"/configuration", ""), 405, "method_not_allowed")
	check(request("POST", path, ""), 405, "method_not_allowed")
}

func TestWorkerDetailProjectsTaskAndVersionValues(t *testing.T) {
	codex, copilot := "codex-version", "copilot-version"
	snapshot := model.WorkerSnapshot{
		Telemetry: model.WorkerTelemetry{Versions: model.WorkerVersions{
			Codex:   model.WorkerProbe[string]{Value: &codex},
			Copilot: model.WorkerProbe[string]{Value: &copilot},
		}},
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, Items: []model.WorkerObservedTask{{ProjectID: "project", TaskID: "task", ClaimID: "claim", Title: "title", ProjectName: "name"}}},
	}
	result := workerDetailResponse(snapshot)
	if len(result.Tasks) != 1 || result.Tasks[0].ProjectID != "project" || result.Tasks[0].TaskID != "task" || result.Tasks[0].ClaimID != "claim" || result.Tasks[0].Title != "title" || result.Tasks[0].ProjectName != "name" || *result.Telemetry.Versions.Codex.Value != codex || *result.Telemetry.Versions.Copilot.Value != copilot {
		t.Fatalf("detail projection lost observed values: %+v", result)
	}
}
