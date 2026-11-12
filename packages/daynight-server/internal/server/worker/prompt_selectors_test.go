package worker

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type promptReportMock struct {
	workerService
	calls     int
	principal model.Principal
	workerID  string
	input     model.WorkerReport
	selectors []model.PromptSelector
	result    service.ConfigurationSyncResult
}

func (m *promptReportMock) ReportSync(_ context.Context, principal model.Principal, workerID string, input model.WorkerReport, selectors []model.PromptSelector) (service.ConfigurationSyncResult, error) {
	m.calls++
	m.principal, m.workerID, m.input, m.selectors = principal, workerID, input, selectors
	return m.result, nil
}

func TestPromptSelectorProtocol(t *testing.T) {
	project := "11111111-1111-4111-8111-111111111111"
	valid := `[{"key":{"scope":"user"},"knownRevision":null},{"key":{"scope":"worker"},"knownRevision":"0"},{"key":{"scope":"project","projectId":"` + project + `"},"knownRevision":"9223372036854775807"}]`
	cases := []struct {
		name                string
		versions, selectors []string
		ok                  bool
		count               int
	}{
		{"legacy", nil, nil, true, 0},
		{"v1", []string{"1"}, nil, true, 0},
		{"v2 empty", []string{"2"}, []string{"[]"}, true, 0},
		{"v2 three", []string{"2"}, []string{valid}, true, 3},
		{"v2 1024 bytes", []string{"2"}, []string{"[]" + strings.Repeat(" ", 1022)}, true, 0},
		{"missing version", nil, []string{"[]"}, false, 0},
		{"v1 with selector", []string{"1"}, []string{"[]"}, false, 0},
		{"missing selector", []string{"2"}, nil, false, 0},
		{"empty selector", []string{"2"}, []string{""}, false, 0},
		{"duplicate header", []string{"2"}, []string{"[]", "[]"}, false, 0},
		{"duplicate protocol", []string{"2", "2"}, []string{"[]"}, false, 0},
		{"unsupported", []string{"3"}, []string{"[]"}, false, 0},
		{"too large", []string{"2"}, []string{"[]" + strings.Repeat(" ", 1023)}, false, 0},
		{"non ASCII", []string{"2"}, []string{"[]中"}, false, 0},
		{"newline", []string{"2"}, []string{"[]\n"}, false, 0},
		{"null", []string{"2"}, []string{"null"}, false, 0},
		{"trailing", []string{"2"}, []string{"[] []"}, false, 0},
		{"missing key", []string{"2"}, []string{`[{"knownRevision":null}]`}, false, 0},
		{"missing revision", []string{"2"}, []string{`[{"key":{"scope":"user"}}]`}, false, 0},
		{"duplicate field", []string{"2"}, []string{`[{"key":{"scope":"user","scope":"user"},"knownRevision":null}]`}, false, 0},
		{"unknown field", []string{"2"}, []string{`[{"key":{"scope":"user","projectId":"` + project + `"},"knownRevision":null}]`}, false, 0},
		{"duplicate key", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":null},{"key":{"scope":"user"},"knownRevision":"0"}]`}, false, 0},
		{"four", []string{"2"}, []string{`[{},{},{},{}]`}, false, 0},
		{"bad UUID", []string{"2"}, []string{`[{"key":{"scope":"project","projectId":"bad"},"knownRevision":null}]`}, false, 0},
		{"uppercase UUID", []string{"2"}, []string{`[{"key":{"scope":"project","projectId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"},"knownRevision":null}]`}, false, 0},
		{"leading zero", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":"01"}]`}, false, 0},
		{"overflow", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":"9223372036854775808"}]`}, false, 0},
		{"numeric revision", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":0}]`}, false, 0},
		{"lone surrogate", []string{"2"}, []string{`[{"key":{"scope":"\ud800"},"knownRevision":null}]`}, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			header := make(http.Header)
			if tc.versions != nil {
				header[workerConfigurationHeader] = tc.versions
			}
			if tc.selectors != nil {
				header[workerPromptsHeader] = tc.selectors
			}
			_, selectors, err := promptProtocol(header)
			if (err == nil) != tc.ok || err == nil && len(selectors) != tc.count {
				t.Fatalf("selectors=%+v error=%v", selectors, err)
			}
		})
	}
}

func TestInvalidPromptHeadersRejectBeforeReport(t *testing.T) {
	mock := &promptReportMock{}
	h := &workersHandler{workers: mock, logger: slog.Default()}
	for _, header := range []string{"", `[{"key":{"scope":"user"},"knownRevision":"01"}]`, `[] []`} {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/me/workers/11111111-1111-4111-8111-111111111111/report", strings.NewReader("{}"))
		r.SetPathValue("workerId", "11111111-1111-4111-8111-111111111111")
		r.Header.Set(workerConfigurationHeader, "2")
		r.Header.Set(workerPromptsHeader, header)
		w := httptest.NewRecorder()
		h.report(w, r, model.Principal{UserID: "22222222-2222-4222-8222-222222222222"})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("header %q: %d %s", header, w.Code, w.Body)
		}
	}
	if mock.calls != 0 {
		t.Fatalf("invalid headers invoked report %d times", mock.calls)
	}
}

func TestInvalidConfigurationProtocolRejectsBeforeReport(t *testing.T) {
	for _, versions := range [][]string{{"3"}, {"1", "1"}, {"1, 2"}, {""}} {
		t.Run(strings.Join(versions, "/"), func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, "11111111-1111-4111-8111-111111111111")
			response := controlModeRequest(t, f, http.MethodPost, "/report", "{}", http.Header{workerConfigurationHeader: versions})
			if response.Code != http.StatusBadRequest {
				t.Fatalf("protocol %q: status=%d body=%s", versions, response.Code, response.Body)
			}
		})
	}
}

func TestPromptReportProtocol2PreservesFullBodyAndReceipt(t *testing.T) {
	const user = "22222222-2222-4222-8222-222222222222"
	const workerID = "11111111-1111-4111-8111-111111111111"
	principal := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: workerID}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	resource := &model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "0"}
	mock := &promptReportMock{result: service.ConfigurationSyncResult{
		Native:  service.WorkerReportResult{ObservedAt: now, LastReportedAt: now, Configuration: &model.WorkerConfigurationReceipt{ObservationRevision: "0"}},
		Prompts: []model.PromptResult{{Key: model.PromptKey{Scope: model.PromptScopeUser}, Status: "value", Value: resource}},
	}}
	h := &workersHandler{workers: mock, logger: slog.Default()}
	body := workerSnapshotReportBody()
	body["configuration"] = map[string]any{"bootstrap": nil, "observation": nil}
	encoded := jsonBody(t, body)
	r := httptest.NewRequest(http.MethodPost, "/report", strings.NewReader(encoded))
	r.SetPathValue("workerId", strings.ToUpper(workerID))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(workerConfigurationHeader, "2")
	r.Header.Set(workerPromptsHeader, `[{"key":{"scope":"user"},"knownRevision":null}]`)
	w := httptest.NewRecorder()
	h.report(w, r, principal)
	var receipt configurationSyncReceipt
	err := json.Unmarshal(w.Body.Bytes(), &receipt)
	if w.Code != http.StatusOK || w.Header().Get(workerConfigurationHeader) != "2" || err != nil || receipt.Configuration.WorkerConfigurationReceipt == nil || receipt.Configuration.ObservationRevision != "0" || len(receipt.Configuration.Prompts) != 1 || receipt.Configuration.Prompts[0].Value == nil || receipt.Configuration.Prompts[0].Value.ScopeID != user || receipt.Configuration.Prompts[0].Value.Revision != "0" {
		t.Fatalf("protocol 2 response: %d %s (%v)", w.Code, w.Body, err)
	}
	if mock.calls != 1 || mock.principal != principal || mock.workerID != workerID || mock.input.Configuration == nil || mock.input.TaskInventory == nil || len(mock.selectors) != 1 || mock.selectors[0].Key.Scope != model.PromptScopeUser || mock.selectors[0].KnownRevision != nil {
		t.Fatalf("report arguments: %+v", mock)
	}
}

func TestPromptReportControlModeCapabilityKeepsProtocol2(t *testing.T) {
	for _, aware := range []bool{false, true} {
		web := model.AgentControlModeWeb
		mock := &promptReportMock{result: service.ConfigurationSyncResult{Native: service.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{Desired: &model.WorkerDesiredConfiguration{Revision: "2", Value: model.WorkerConfiguration{AgentControlMode: &web}}, ObservationRevision: "0"}}, Prompts: []model.PromptResult{{Key: model.PromptKey{Scope: model.PromptScopeUser}, Status: "unchanged"}}}}
		h := &workersHandler{workers: mock, logger: slog.Default()}
		body := workerSnapshotReportBody()
		exchange := map[string]any{"bootstrap": nil, "observation": nil}
		if aware {
			exchange["controlModeBootstrap"] = "web"
		}
		body["configuration"] = exchange
		request := httptest.NewRequest(http.MethodPost, "/report", strings.NewReader(jsonBody(t, body)))
		request.SetPathValue("workerId", "11111111-1111-4111-8111-111111111111")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(workerConfigurationHeader, "2")
		request.Header.Set(workerPromptsHeader, `[{"key":{"scope":"user"},"knownRevision":"0"}]`)
		if aware {
			request.Header.Set(workerControlModeHeader, "1")
		}
		response := httptest.NewRecorder()
		h.report(response, request, model.Principal{Kind: model.PATCredential, UserID: "22222222-2222-4222-8222-222222222222"})
		if response.Code != 200 || response.Header().Get(workerConfigurationHeader) != "2" || (response.Header().Get(workerControlModeHeader) == "1") != aware || strings.Contains(response.Body.String(), `"agentControlMode"`) != aware || !strings.Contains(response.Body.String(), `"prompts":[`) || mock.calls != 1 || len(mock.selectors) != 1 {
			t.Fatalf("protocol 2 mode=%v: %d %v %s", aware, response.Code, response.Header(), response.Body)
		}
	}
}
