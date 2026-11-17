package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

func TestArchiveLegacyClientContract(t *testing.T) {
	// These complete responses are also checked with the pre-extension CLI parser.
	check := func(name string, body []byte) {
		t.Helper()
		want, err := os.ReadFile("testdata/archive-legacy-" + name + ".json")
		if err != nil || !bytes.Equal(body, want) {
			t.Fatalf("legacy %s response: got %s want %s err=%v", name, body, want, err)
		}
	}
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	value := configurationHTTPModel(t, configurationHTTPValue())
	enabled := false
	value.ArchiveSessions = &enabled
	desired := &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: capacityObservedAt, Value: value}
	observation := &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "2", Items: []model.WorkerConfigurationItem{
		{Key: model.WorkerConfigurationItemKey{Kind: "archiveSessions"}, TargetRevision: "2", AppliedValue: json.RawMessage(`false`), State: "applied"},
		{Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, TargetRevision: "2", AppliedValue: json.RawMessage(`3`), State: "applied"},
	}}, ReportedAt: capacityObservedAt}
	f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
		return model.WorkerConfigurationResource{Desired: desired, ObservationRevision: "1", Observation: observation}, nil
	}
	got := controlModeRequest(t, f, "GET", "/configuration", "", nil)
	if got.Code != 200 {
		t.Fatalf("GET: %d %s", got.Code, got.Body)
	}
	check("resource", got.Body.Bytes())
	result := workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: &model.WorkerConfigurationReceipt{Desired: desired, ObservationRevision: "1", ObservationAccepted: true}}
	f.operations.report = func(context.Context, model.Principal, string, model.WorkerReport) (workerservice.WorkerReportResult, error) {
		return result, nil
	}
	f.operations.sync = func(context.Context, model.Principal, string, model.WorkerReport, []model.PromptSelector) (workerservice.ConfigurationSyncResult, error) {
		return workerservice.ConfigurationSyncResult{Native: result, Prompts: []model.PromptResult{}}, nil
	}
	for _, version := range []string{"1", "2"} {
		headers := http.Header{workerConfigurationHeader: {version}}
		if version == "2" {
			headers.Set(workerPromptsHeader, "[]")
		}
		got = controlModeRequest(t, f, "POST", "/report", jsonBody(t, configurationHTTPReportBody(nil, nil)), headers)
		if got.Code != 200 {
			t.Fatalf("POST %s: %d %s", version, got.Code, got.Body)
		}
		check("report"+version, got.Body.Bytes())
	}
}
