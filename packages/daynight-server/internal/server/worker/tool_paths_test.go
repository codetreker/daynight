package worker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const toolPathsHeader = "Daynight-Worker-Tool-Paths"

func TestWorkerToolPathsHTTPPreservesForeignPlatformTargetFailure(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	body := configurationHTTPReportBody(nil, nil)
	body["configuration"].(map[string]any)["toolPathsBootstrap"] = nil
	body["platform"] = "linux"
	revision, count := "7", int64(0)
	body["toolPaths"] = &model.ToolPathTelemetry{
		SchemaVersion: 1, ObservedAt: capacityObservedAt,
		Entries: []model.ToolPathObservation{{
			Tool: "codex", Context: "web", ConfigurationSource: "cloud", TargetRevision: &revision,
			Target: model.ToolPathChoice{Kind: "path", Path: `C:\tools\codex.exe`}, State: "error",
			Error:                &model.ToolPathError{Code: "invalid_path", OccurredAt: capacityObservedAt},
			ActiveSelectionCount: &count, ActiveSelectionsComplete: true, ActiveSelections: []model.ToolPathActiveSelection{},
		}},
	}
	want := capacityDecode[model.WorkerTelemetry](t, body)
	calls := 0
	f.operations.report = func(ctx context.Context, p model.Principal, id string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		calls++
		if calls != 1 || ctx != f.requestContext || p != f.handler.principal || id != f.worker || !reflect.DeepEqual(input.Telemetry, want) {
			t.Fatalf("target failure or ordinary report changed: %+v", input)
		}
		return workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}, nil
	}
	response := workerProtocolRequest(t, f, "POST", "/report", jsonBody(t, body), http.Header{workerConfigurationHeader: {"1"}, toolPathsHeader: {"2"}})
	if response.Code != http.StatusOK || calls != 1 {
		t.Fatalf("target failure refused: %d %s calls=%d", response.Code, response.Body, calls)
	}
}

func TestWorkerToolProtocolRequiresVersionBeforeBusiness(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "PUT", "POST"} {
		for _, values := range [][]string{nil, {"1"}, {"2", "2"}, {"invalid"}} {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			suffix := "/configuration"
			if method == "POST" {
				suffix = "/report"
			}
			response := workerProtocolRequest(t, f, method, suffix, `{}`, http.Header{toolPathsHeader: values})
			if response.Code != http.StatusBadRequest {
				t.Fatalf("%s %v reached business: %d", method, values, response.Code)
			}
		}
	}
}

func TestWorkerToolPathsHTTPConflictPreservesSubmittedRevision(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	value := configurationHTTPValue()
	value["toolPaths"] = map[string]any{"codex": map[string]any{"kind": "path", "path": "/cloud/codex"}, "copilot": nil}
	calls := 0
	f.operations.put = func(ctx context.Context, p model.Principal, id, revision string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		calls++
		if calls != 1 || ctx != f.requestContext || p != f.handler.principal || id != f.worker || revision != "7" || input.ToolPaths.Codex == nil || input.ToolPaths.Codex.Path != "/cloud/codex" {
			t.Fatal("conflicting request was changed or replayed")
		}
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "version_conflict", Message: "Worker configuration revision does not match."}
	}
	response := workerProtocolRequest(t, f, "PUT", "/configuration", jsonBody(t, map[string]any{"revision": "7", "value": value}), http.Header{toolPathsHeader: {"2"}})
	if response.Code != http.StatusConflict || calls != 1 || !strings.Contains(response.Body.String(), `"version_conflict"`) {
		t.Fatalf("conflict mapping: %d %s calls=%d", response.Code, response.Body, calls)
	}
}

func TestWorkerToolProtocolEchoOnFailures(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	calls := 0
	f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
		calls++
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "not_found", Message: "missing"}
	}
	headers := http.Header{toolPathsHeader: {"2"}}
	for _, tc := range []struct {
		method, suffix, body string
		status               int
	}{
		{"GET", "/configuration", "", 404}, {"POST", "/report", "{}", 400}, {"GET", "?invalid=1", "", 400},
	} {
		got := workerProtocolRequest(t, f, tc.method, tc.suffix, tc.body, headers)
		if got.Code != tc.status || got.Header().Get(toolPathsHeader) != "2" {
			t.Fatalf("%s %s: %d %v", tc.method, tc.suffix, got.Code, got.Header())
		}
	}
	if calls != 1 {
		t.Fatalf("configuration calls = %d", calls)
	}
}

func TestWorkerListDoesNotRequireToolProtocol(t *testing.T) {
	for _, version := range []string{"", "1", "invalid"} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		calls := 0
		f.operations.list = func(context.Context, model.Principal, model.PageRequest) (workerservice.WorkerPage, error) {
			calls++
			return workerservice.WorkerPage{ObservedAt: capacityObservedAt}, nil
		}
		request := httptest.NewRequest(http.MethodGet, "/api/v1/me/workers", nil)
		authorizeResourceRequest(f.handler, request)
		if version != "" {
			request.Header.Set(toolPathsHeader, version)
		}
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || calls != 1 {
			t.Fatalf("version %q: status=%d calls=%d", version, response.Code, calls)
		}
	}
}
