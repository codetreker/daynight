//go:build stress

package worker

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	promptcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/prompt"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

func TestProtocol2MaximumEscapedReceipt(t *testing.T) {
	// Each input fits the existing JSON request budget, but HTML escaping expands
	// its content sixfold in the response.
	value := strings.Repeat("<", (1<<20)-1024)
	if err := promptcore.ValidateText(value); err != nil {
		t.Fatal(err)
	}
	encodeInput := func(input any) []byte {
		var body bytes.Buffer
		encoder := json.NewEncoder(&body)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(input); err != nil {
			t.Fatal(err)
		}
		if body.Len() > httpx.MaxJSONBody {
			t.Fatalf("request exceeds limit: %d", body.Len())
		}
		return body.Bytes()
	}
	encodeInput(map[string]any{"expectedUserId": "11111111-1111-4111-8111-111111111111", "revision": "0", "text": value})
	config := model.WorkerConfiguration{MaxConcurrent: 1, PollIntervalMs: 1, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{value}}, Projects: []model.WorkerProjectConfiguration{}}
	encodeInput(map[string]any{"revision": "1", "value": config})
	configBody := encodeInput(config)
	if _, err := workercore.ParseWorkerConfiguration(configBody); err != nil {
		t.Fatal(err)
	}
	escapedConfig, err := json.Marshal(config)
	if err != nil || len(escapedConfig) < 4<<20 {
		t.Fatalf("native response size %d, error %v", len(escapedConfig), err)
	}
	t.Logf("escaped native value: %d bytes", len(escapedConfig))
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	results := make([]model.PromptResult, 0, 3)
	for _, scope := range []model.PromptScope{model.PromptScopeUser, model.PromptScopeProject, model.PromptScopeWorker} {
		key := model.PromptKey{Scope: scope}
		if scope == model.PromptScopeProject {
			key.ProjectID = "22222222-2222-4222-8222-222222222222"
		}
		results = append(results, model.PromptResult{Key: key, Status: "value", Value: &model.PromptResource{Scope: scope, ScopeID: "22222222-2222-4222-8222-222222222222", Revision: "1", Text: value, UpdatedAt: &now}})
	}
	native := service.WorkerReportResult{ObservedAt: now, LastReportedAt: now, Configuration: &model.WorkerConfigurationReceipt{Desired: &model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: now, Value: config}, ObservationRevision: "0"}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/", nil)
	httpx.WriteJSON(recorder, request, slog.Default(), 200, syncReceipt(native, results))
	if recorder.Code != 200 || recorder.Body.Len() > 48<<20 {
		t.Fatalf("status %d size %d", recorder.Code, recorder.Body.Len())
	}
	t.Logf("complete receipt: %d bytes", recorder.Body.Len())
	var decoded configurationSyncReceipt
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Configuration.Desired == nil || decoded.Configuration.Desired.Value.Native.Args[0] != value || len(decoded.Configuration.Prompts) != 3 {
		t.Fatal("native receipt or prompt batch was truncated")
	}
	for _, item := range decoded.Configuration.Prompts {
		if item.Value == nil || item.Value.Text != value {
			t.Fatal("prompt text was truncated")
		}
	}
}
