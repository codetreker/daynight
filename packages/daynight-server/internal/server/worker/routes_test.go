package worker

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

func TestWorkerRoutesLifecycleAndInvalidRequests(t *testing.T) {
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, configpkg.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	cookie := h.Login(t, "worker")
	mux := http.NewServeMux()
	RegisterRoutes(mux, workerservice.NewWorkers(h.Database), h.Auth, slog.Default())
	request := func(method, path, body string, version ...string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(cookie)
		r.Header.Set("Origin", h.Origin)
		for _, v := range version {
			r.Header.Add(workerConfigurationHeader, v)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
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
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	check(request("GET", path, ""), 404, "not_found")
	check(request("GET", path+"/configuration", ""), 404, "not_found")
	check(request("GET", "/api/v1/me/workers?limit=0", ""), 400, "invalid_input")
	check(request("GET", "/api/v1/me/workers/bad", ""), 400, "invalid_input")
	check(request("GET", path+"?x=1", ""), 400, "invalid_input")
	check(request("GET", path+"/configuration?x=1", ""), 400, "invalid_input")
	check(request("POST", path+"/report?x=1", "{}"), 400, "invalid_input")
	check(request("POST", path+"/report", "{}"), 400, "invalid_input")
	check(request("POST", path+"/report", jsonBody(t, workerSnapshotReportBody()), "2"), 400, "invalid_input")
	check(request("POST", path+"/report", jsonBody(t, workerSnapshotReportBody()), "1", "1"), 400, "invalid_input")
	check(request("POST", path+"/report", `{"unknown":true}`), 400, "invalid_input")
	legacy := workerSnapshotReportBody()
	legacy["taskInventory"] = nil
	w := request("POST", path+"/report", jsonBody(t, legacy))
	check(w, 200, "")
	var receipt map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil || len(receipt) != 2 || w.Header().Get(workerConfigurationHeader) != "" {
		t.Fatalf("legacy receipt: %s %v", w.Body, err)
	}
	w = request("GET", path, "")
	detail := testsupport.DecodeResponse[api.WorkerDetailResponse](t, w, 200)
	if detail.Worker.ActiveTaskCount != nil || detail.Worker.TaskObservationState != "unavailable" {
		t.Fatalf("unknown inventory: %+v", detail.Worker)
	}
	observed := workerSnapshotReportBody()
	observed["assistantHost"] = assistantHostBody()
	check(request("POST", path+"/report", jsonBody(t, observed)), 200, "")
	w = request("GET", path, "")
	detail = testsupport.DecodeResponse[api.WorkerDetailResponse](t, w, 200)
	if detail.Worker.ActiveTaskCount == nil || *detail.Worker.ActiveTaskCount != 0 || detail.Worker.Telemetry.AssistantHost == nil {
		t.Fatalf("observed worker: %+v", detail.Worker)
	}
	page := testsupport.DecodeResponse[api.WorkerPage](t, request("GET", "/api/v1/me/workers", ""), 200)
	if len(page.Items) != 1 || page.Items[0].WorkerID != id {
		t.Fatalf("worker page: %+v", page)
	}
	check(request("PUT", path+"/configuration", `{}`), 400, "invalid_input")
	check(request("PUT", path+"/configuration", `{"revision":1,"value":{}}`), 400, "invalid_input")
	check(request("PUT", path+"/configuration", `{"revision":"1","value":null}`), 400, "invalid_input")
	config := map[string]any{"maxConcurrent": 3, "pollIntervalMs": 60000, "recoveryLimit": 0, "native": map[string]any{"agent": "codex", "model": nil, "args": []any{}}, "projects": []any{}}
	check(request("PUT", path+"/configuration", jsonBody(t, map[string]any{"revision": "1", "value": config})), 409, "configuration_not_initialized")
	observed["configuration"] = map[string]any{"bootstrap": config, "observation": nil}
	check(request("POST", path+"/report", jsonBody(t, observed), "1"), 200, "")
	w = request("GET", path+"/configuration", "")
	resource := testsupport.DecodeResponse[model.WorkerConfigurationResource](t, w, 200)
	if resource.Desired == nil || resource.Desired.Revision != "1" || w.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatalf("configuration: %+v", resource)
	}
	config["maxConcurrent"] = 4
	w = request("PUT", path+"/configuration", jsonBody(t, map[string]any{"revision": "1", "value": config}))
	resource = testsupport.DecodeResponse[model.WorkerConfigurationResource](t, w, 200)
	if resource.Desired == nil || resource.Desired.Revision != "2" {
		t.Fatalf("updated configuration: %+v", resource)
	}
	check(request("PUT", path+"/configuration", jsonBody(t, map[string]any{"revision": "1", "value": config})), 409, "version_conflict")
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
