package worker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestToolPathsConfigurationRetainsThreeStates(t *testing.T) {
	document := configurationInputDocument()
	document["toolPaths"] = map[string]any{"codex": map[string]any{"kind": "path", "path": `/Applications/工具 $()/codex`}, "copilot": map[string]any{"kind": "auto"}, "herdr": nil}
	value, err := ParseWorkerConfiguration(configurationInputJSON(t, document))
	if err != nil {
		t.Fatalf("three-state tool configuration rejected: %v", err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if string(got["toolPaths"]) != `{"codex":{"kind":"path","path":"/Applications/工具 $()/codex"},"copilot":{"kind":"auto"},"herdr":null}` {
		t.Fatalf("tool choices lost: %s", raw)
	}
}

func TestToolPathsTelemetryRetainsObservation(t *testing.T) {
	input := validWorkerReportForValidation()
	if err := json.Unmarshal([]byte(`{"toolPaths":{"schemaVersion":1,"observedAt":"2026-10-29T00:00:00Z","entries":[]}}`), &input.Telemetry); err != nil {
		t.Fatal(err)
	}
	got, err := ValidateReport(input)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(got.Telemetry)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"toolPaths"`) {
		t.Fatalf("tool observation lost: %s", raw)
	}
}

func TestToolPathsBootstrapCombinesModeIntoOneWrite(t *testing.T) {
	document := map[string]any{"bootstrap": configurationInputDocument(), "observation": nil, "controlModeBootstrap": "web", "toolPathsBootstrap": map[string]any{"codex": map[string]any{"kind": "path", "path": "/opt/codex"}, "copilot": map[string]any{"kind": "auto"}, "herdr": map[string]any{"kind": "auto"}}}
	exchange, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, document))
	if err != nil {
		t.Fatalf("tool bootstrap rejected: %v", err)
	}
	dao := &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}}
	receipt, err := ExchangeConfiguration(context.Background(), dao, model.Principal{UserID: "user"}, "worker", *exchange)
	if err != nil || receipt.Desired.Revision != "1" || dao.desiredWrites != 1 {
		t.Fatalf("bootstrap must persist one complete revision: %+v %v writes=%d", receipt, err, dao.desiredWrites)
	}
}

func TestToolPathsIndependentAdoptionAndLegacyCAS(t *testing.T) {
	ctx, principal := t.Context(), model.Principal{UserID: "user"}
	path := func(s string) *model.ToolPathChoice { return &model.ToolPathChoice{Kind: "path", Path: s} }
	auto := &model.ToolPathChoice{Kind: "auto"}
	bootstrap := model.WorkerToolPaths{Codex: path("/local/codex"), Copilot: path(`C:\Tools\copilot.exe`), Herdr: auto}
	dao := configuredDAO("7")
	dao.current.Desired.Value.ToolPaths.Codex = path("/cloud/codex")
	web := model.AgentControlModeWeb
	receipt, err := ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ToolPathsBootstrap: &bootstrap, ControlModeBootstrap: &web})
	if err != nil || receipt.Desired.Revision != "8" || dao.desiredWrites != 1 || *receipt.Desired.Value.ToolPaths.Codex != *path("/cloud/codex") || *receipt.Desired.Value.ToolPaths.Copilot != *bootstrap.Copilot || receipt.Desired.Value.AgentControlMode == nil {
		t.Fatalf("independent adoption: %+v %v writes=%d", receipt, err, dao.desiredWrites)
	}
	dao.current.Desired = receipt.Desired
	value := configurationFixture()
	value.PreserveToolPaths = true
	value.PreserveAgentControlMode = true
	_, err = PutConfiguration(ctx, dao, principal, "worker", 7, value)
	requireFault(t, err, "version_conflict")
	result, err := PutConfiguration(ctx, dao, principal, "worker", 8, value)
	if err != nil || result.Desired.Revision != "8" || dao.desiredWrites != 1 || result.Desired.Value.PreserveToolPaths {
		t.Fatalf("legacy noop lost choices: %+v %v", result, err)
	}
	value = result.Desired.Value
	value.ToolPaths.Codex = auto
	result, err = PutConfiguration(ctx, dao, principal, "worker", 8, value)
	if err != nil || result.Desired.Revision != "9" {
		t.Fatalf("auto reset: %+v %v", result, err)
	}
	dao.current.Desired = result.Desired
	receipt, err = ExchangeConfiguration(ctx, dao, principal, "worker", model.WorkerConfigurationExchange{ToolPathsBootstrap: &bootstrap})
	if err != nil || receipt.Desired.Revision != "9" || receipt.Desired.Value.ToolPaths.Codex.Kind != "auto" || dao.desiredWrites != 2 {
		t.Fatalf("bootstrap resurrected local path: %+v %v", receipt, err)
	}
	value.ToolPaths.Copilot = nil
	_, err = PutConfiguration(ctx, dao, principal, "worker", 9, value)
	requireFault(t, err, "invalid_input")
}

func TestToolPathsStrictChoiceSyntax(t *testing.T) {
	valid := []string{`/opt/工具 $()/codex`, `C:\Program Files\codex.cmd`, `\\server\share\codex.exe`, `\\?\C:\tools\codex.exe`, "/" + strings.Repeat("x", 4095)}
	for _, path := range valid {
		if _, err := parseToolPathChoice(configurationInputJSON(t, map[string]any{"kind": "path", "path": path})); err != nil {
			t.Fatalf("valid path rejected %q: %v", path, err)
		}
	}
	for _, choice := range []any{nil, map[string]any{}, map[string]any{"kind": "other"}, map[string]any{"kind": "auto", "path": ""}, map[string]any{"kind": "path"}, map[string]any{"kind": "path", "path": "/valid", "argv": []string{}}, map[string]any{"kind": "path", "path": "relative"}, map[string]any{"kind": "path", "path": " C:\\tool"}, map[string]any{"kind": "path", "path": "/bad\npath"}, map[string]any{"kind": "path", "path": "/" + strings.Repeat("x", 4096)}} {
		if _, err := parseToolPathChoice(configurationInputJSON(t, choice)); err == nil {
			t.Fatalf("invalid choice accepted: %+v", choice)
		}
	}
	for _, raw := range []string{`{"codex":null,"copilot":null}`, `{"codex":null,"copilot":null,"herdr":null,"other":null}`, `{"codex":{"kind":"path","path":"/\ud800"},"copilot":null,"herdr":null}`} {
		document := configurationInputDocument()
		document["toolPaths"] = json.RawMessage(raw)
		if _, err := ParseWorkerConfiguration(configurationInputJSON(t, document)); err == nil {
			t.Fatalf("invalid choices accepted: %s", raw)
		}
	}
}
