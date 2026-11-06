package api_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestBotConfigurationJSONCompatibility(t *testing.T) {
	model, effort := "model-a", "high"
	tests := []struct {
		name          string
		configuration api.BotConfiguration
		want          string
	}{
		{
			name: "legacy snapshot omits selection and effort",
			configuration: api.BotConfiguration{
				WorkerID: "worker-a", Cwd: "/workspace", Provider: "codex", Args: []string{},
			},
			want: `{"workerId":"worker-a","cwd":"/workspace","provider":"codex","model":null,"args":[]}`,
		},
		{
			name: "native snapshot preserves explicit nulls and sources",
			configuration: api.BotConfiguration{
				WorkerID: "worker-a", Cwd: "/workspace", Provider: "codex", Args: []string{},
				Selection: &api.BotSelection{
					SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "native",
				},
			},
			want: `{"workerId":"worker-a","cwd":"/workspace","provider":"codex","model":null,"args":[],"reasoningEffort":null,"selection":{"schemaVersion":1,"modelSource":"native","reasoningEffortSource":"native"}}`,
		},
		{
			name: "selected snapshot preserves values sources and generations",
			configuration: api.BotConfiguration{
				WorkerID: "worker-a", Cwd: "/workspace", Provider: "codex", Model: &model,
				Args: []string{"--sandbox"}, ReasoningEffort: &effort,
				Selection: &api.BotSelection{
					SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "preference",
					ConfigurationGeneration: "configuration-1", CatalogGeneration: "catalog-1",
				},
			},
			want: `{"workerId":"worker-a","cwd":"/workspace","provider":"codex","model":"model-a","args":["--sandbox"],"reasoningEffort":"high","selection":{"schemaVersion":1,"modelSource":"explicit","reasoningEffortSource":"preference","configurationGeneration":"configuration-1","catalogGeneration":"catalog-1"}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded, err := json.Marshal(tt.configuration)
			if err != nil {
				t.Fatal(err)
			}
			var got, want map[string]any
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(tt.want), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("configuration JSON = %s, want %s", encoded, tt.want)
			}
		})
	}
}
