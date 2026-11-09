package model_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestBotConfigurationPersistencePreservesLegacyAndNativeSelection(t *testing.T) {
	selected, effort := "model-a", "high"
	for _, selection := range []*model.BotSelection{nil,
		{SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "native"},
		{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "preference"},
	} {
		configuration := model.BotConfiguration{WorkerID: "worker-a", Cwd: "/workspace", Provider: "codex", Args: []string{}}
		configuration.Selection = selection
		if selection != nil && selection.ModelSource == "explicit" {
			configuration.Model, configuration.ReasoningEffort = &selected, &effort
		}
		encoded, err := json.Marshal(configuration)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatal(err)
		}
		_, hasSelection := fields["selection"]
		_, hasEffort := fields["reasoningEffort"]
		if hasSelection != (selection != nil) || hasEffort != (selection != nil) {
			t.Fatalf("persisted snapshot changed field presence: %s", encoded)
		}
		if selection != nil && selection.ModelSource == "native" && string(fields["reasoningEffort"]) != "null" {
			t.Fatalf("native delegation lost its explicit null: %s", encoded)
		}
		var restored model.BotConfiguration
		if err := json.Unmarshal(encoded, &restored); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(restored, configuration) {
			t.Fatalf("persisted configuration changed on restore: %#v", restored)
		}
	}
}
