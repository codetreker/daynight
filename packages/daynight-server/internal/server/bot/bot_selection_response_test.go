package bot

import (
	"encoding/json"
	"strings"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestBotDefaultsResponsePreservesSelectionAndUnavailableWorkers(t *testing.T) {
	selected := "model-a"
	configuration := model.BotConfiguration{
		WorkerID: "worker-a", Cwd: "/workspace", Provider: "codex", Model: &selected, Args: []string{"--sandbox"},
		Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "preference", ReasoningEffortSource: "native",
			ConfigurationGeneration: strings.Repeat("a", 64), CatalogGeneration: "e209a72f-167a-4fbc-9d08-83532d08eaae"},
	}
	response := botDefaultsResponse(botcore.BotDefaults{
		Configuration: &configuration,
		Workers:       []botcore.BotWorkerDefaults{{WorkerID: "worker-a", Configuration: &configuration}, {WorkerID: "worker-b"}},
	})
	if response.Configuration.Selection == nil || *response.Configuration.Selection != *response.Workers[0].Configuration.Selection || response.Workers[1].Configuration != nil {
		t.Fatalf("defaults and Worker choices disagree: %#v", response)
	}
	encoded, err := json.Marshal(response.Configuration)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["reasoningEffort"]) != "null" || !strings.Contains(string(fields["selection"]), `"modelSource":"preference"`) || !strings.Contains(string(fields["selection"]), configuration.Selection.CatalogGeneration) {
		t.Fatalf("defaults response lost frozen selection metadata: %s", encoded)
	}
	configuration.Selection.ModelSource = "explicit"
	configuration.Args[0] = "changed"
	if response.Configuration.Selection.ModelSource != "preference" || response.Configuration.Args[0] != "--sandbox" {
		t.Fatal("response changed after the source snapshot was modified")
	}
}
