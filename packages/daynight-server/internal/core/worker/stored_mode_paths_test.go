package worker

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestStoredModeAndPathsPreservationAndCorrection(t *testing.T) {
	auto := &model.ToolPathChoice{Kind: "auto"}
	for _, tc := range []struct {
		name      string
		fields    map[string]json.RawMessage
		value     model.WorkerConfiguration
		wantError bool
	}{
		{"preserve absent fields", map[string]json.RawMessage{}, model.WorkerConfiguration{PreserveAgentControlMode: true, PreserveToolPaths: true}, false},
		{"reject invalid preserved mode", map[string]json.RawMessage{"agentControlMode": json.RawMessage(`"invalid"`)}, model.WorkerConfiguration{PreserveAgentControlMode: true}, true},
		{"reject invalid preserved paths", map[string]json.RawMessage{"toolPaths": json.RawMessage(`{"codex":false,"copilot":null}`)}, model.WorkerConfiguration{PreserveToolPaths: true}, true},
		{"reject incomplete correction", map[string]json.RawMessage{"toolPaths": json.RawMessage(`false`)}, model.WorkerConfiguration{ToolPaths: model.WorkerToolPaths{Codex: auto}}, true},
		{"allow complete correction", map[string]json.RawMessage{"toolPaths": json.RawMessage(`false`)}, model.WorkerConfiguration{ToolPaths: model.WorkerToolPaths{Codex: auto, Copilot: auto}}, false},
		{"reject clearing adopted choice", map[string]json.RawMessage{"toolPaths": json.RawMessage(`{"codex":{"kind":"auto"},"copilot":null}`)}, model.WorkerConfiguration{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := storedModeAndPaths(tc.fields, &tc.value)
			if (err != nil) != tc.wantError {
				t.Fatalf("stored target handling: %v", err)
			}
			if tc.name == "preserve absent fields" && (tc.value.PreserveAgentControlMode || tc.value.PreserveToolPaths || tc.value.AgentControlMode != nil || tc.value.ToolPaths != (model.WorkerToolPaths{})) {
				t.Fatalf("preservation invented values: %+v", tc.value)
			}
		})
	}
}
