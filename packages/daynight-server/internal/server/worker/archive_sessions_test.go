package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

func TestArchiveSessionsHTTPProjection(t *testing.T) {
	for _, aware := range []bool{false, true} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		enabled := false
		value := configurationHTTPModel(t, configurationHTTPValue())
		value.ArchiveSessions = &enabled
		value.EnableSudoCleanup = true
		observation := &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "2", Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "archiveSessions"}, TargetRevision: "2", AppliedValue: json.RawMessage(`false`), State: "applied"}, {Key: model.WorkerConfigurationItemKey{Kind: "enableSudoCleanup"}, TargetRevision: "2", AppliedValue: json.RawMessage(`true`), State: "applied"}, {Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, TargetRevision: "2", AppliedValue: json.RawMessage(`3`), State: "applied"}}}, ReportedAt: capacityObservedAt}
		f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
			return model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: capacityObservedAt, Value: value}, ObservationRevision: "1", Observation: observation}, nil
		}
		headers := http.Header{}
		if aware {
			headers.Set(workerArchiveSessionsHeader, "1")
		}
		response := controlModeRequest(t, f, "GET", "/configuration", "", headers)
		body := response.Body.String()
		if response.Code != 200 || (response.Header().Get(workerArchiveSessionsHeader) == "1") != aware || strings.Contains(body, `"archiveSessions":false`) != aware || strings.Contains(body, `"kind":"archiveSessions"`) != aware || !strings.Contains(body, `"enableSudoCleanup":true`) || !strings.Contains(body, `"kind":"enableSudoCleanup"`) || strings.Contains(body, "archiveSessionsObservation") {
			t.Fatalf("projection aware=%v: %d %s %v", aware, response.Code, body, response.Header())
		}
		if len(observation.Items) != 3 {
			t.Fatal("projection changed the source observation")
		}
		f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
			return model.WorkerConfigurationResource{}, &model.Fault{Code: "not_found", Message: "missing", Cause: model.ErrNotFound}
		}
		response = controlModeRequest(t, f, "GET", "/configuration", "", headers)
		if response.Code != 404 || (response.Header().Get(workerArchiveSessionsHeader) == "1") != aware {
			t.Fatalf("404 discovery: %d %v", response.Code, response.Header())
		}
	}
}

func TestArchiveSessionsHTTPWriteAndReport(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	value := configurationHTTPValue()
	calls := 0
	f.operations.put = func(_ context.Context, _ model.Principal, _ string, revision string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		calls++
		if revision != "7" || (calls == 1 && !input.PreserveArchiveSessions) || (calls == 2 && (input.PreserveArchiveSessions || input.ArchiveSessions == nil || *input.ArchiveSessions)) {
			t.Fatalf("input: %+v", input)
		}
		return model.WorkerConfigurationResource{ObservationRevision: "0"}, nil
	}
	body := func() string { return jsonBody(t, map[string]any{"revision": "7", "value": value}) }
	if response := controlModeRequest(t, f, "PUT", "/configuration", body(), nil); response.Code != 200 {
		t.Fatalf("legacy: %d %s", response.Code, response.Body)
	}
	value["archiveSessions"] = false
	if response := controlModeRequest(t, f, "PUT", "/configuration", body(), http.Header{workerArchiveSessionsHeader: {"1"}}); response.Code != 200 || calls != 2 {
		t.Fatalf("new: %d %s", response.Code, response.Body)
	}
	if response := controlModeRequest(t, f, "PUT", "/configuration", body(), nil); response.Code != 400 || calls != 2 {
		t.Fatalf("legacy accepted extension: %d %s", response.Code, response.Body)
	}
	for _, invalid := range []any{nil, "false", 0} {
		value["archiveSessions"] = invalid
		if response := controlModeRequest(t, f, "PUT", "/configuration", body(), http.Header{workerArchiveSessionsHeader: {"1"}}); response.Code != 400 || calls != 2 {
			t.Fatalf("invalid value: %v %d %s", invalid, response.Code, response.Body)
		}
	}
	for _, versions := range [][]string{{""}, {"2"}, {"1", "1"}, {"1, 1"}} {
		if response := controlModeRequest(t, f, "GET", "/configuration", "", http.Header{workerArchiveSessionsHeader: versions}); response.Code != 400 {
			t.Fatalf("invalid header: %v %d", versions, response.Code)
		}
	}
	if response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, configurationHTTPReportBody(nil, nil)), http.Header{workerArchiveSessionsHeader: {"1"}}); response.Code != 400 {
		t.Fatalf("capability without configuration protocol: %d", response.Code)
	}
	for _, version := range []string{"1", "2"} {
		headers := http.Header{workerConfigurationHeader: {version}, workerArchiveSessionsHeader: {"1"}}
		if version == "2" {
			headers.Set(workerPromptsHeader, "[]")
		}
		enabled := false
		result := workerservice.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{Desired: &model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: capacityObservedAt, Value: model.WorkerConfiguration{ArchiveSessions: &enabled}}, ObservationRevision: "0"}}
		f.operations.report = func(context.Context, model.Principal, string, model.WorkerReport) (workerservice.WorkerReportResult, error) {
			return result, nil
		}
		f.operations.sync = func(context.Context, model.Principal, string, model.WorkerReport, []model.PromptSelector) (workerservice.ConfigurationSyncResult, error) {
			return workerservice.ConfigurationSyncResult{Native: result, Prompts: []model.PromptResult{}}, nil
		}
		response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, configurationHTTPReportBody(nil, nil)), headers)
		if response.Code != 200 || response.Header().Get(workerArchiveSessionsHeader) != "1" || !strings.Contains(response.Body.String(), `"archiveSessions":false`) {
			t.Fatalf("v%s: %d %s", version, response.Code, response.Body)
		}
	}
}

func TestArchiveSessionsHTTPObservationRequiresCapability(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	observation := configurationHTTPObservation(configurationHTTPItem("archiveSessions", false))
	body := jsonBody(t, configurationHTTPReportBody(nil, observation))
	calls := 0
	f.operations.report = func(_ context.Context, _ model.Principal, _ string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		calls++
		if input.Configuration == nil || len(input.Configuration.Observation.Items) != 1 || string(input.Configuration.Observation.Items[0].AppliedValue) != "false" {
			t.Fatalf("observation lost: %+v", input.Configuration)
		}
		return workerservice.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{ObservationRevision: "1", ObservationAccepted: true}}, nil
	}
	response := controlModeRequest(t, f, "POST", "/report", body, http.Header{workerConfigurationHeader: {"1"}})
	if response.Code != 400 || calls != 0 {
		t.Fatalf("unnegotiated observation: %d %s calls=%d", response.Code, response.Body, calls)
	}
	response = controlModeRequest(t, f, "POST", "/report", body, http.Header{workerConfigurationHeader: {"1"}, workerArchiveSessionsHeader: {"1"}})
	if response.Code != 200 || calls != 1 || !strings.Contains(response.Body.String(), `"observationAccepted":true`) {
		t.Fatalf("negotiated observation: %d %s calls=%d", response.Code, response.Body, calls)
	}
}
