package bot

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
)

func selectionCatalog() ro.ModelResult {
	return ro.ModelResult{SchemaVersion: 1, Provider: "codex", ConfigurationGeneration: strings.Repeat("a", 64), CatalogGeneration: botID,
		Models:   []ro.ModelOption{{ID: "model", Aliases: []string{"alias"}, ReasoningEfforts: []string{"low", "high"}}, {ID: "plain", ReasoningEfforts: nil}},
		Defaults: ro.ModelDefaults{Model: ro.ModelDefault{Value: ptr("model"), Source: "local"}, ReasoningEffort: ro.ModelDefault{Value: ptr("high"), Source: "local"}}}
}
func selectionBase() model.BotConfiguration {
	return model.BotConfiguration{WorkerID: workerID, Cwd: "/work", Provider: "codex", Model: ptr("model"), Args: []string{"--effort", "high"}, Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "local"}}
}
func TestNativeCatalogPrecedenceModelBindingAndCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name       string
		selected   *string
		override   *string
		preference map[string]string
		want       string
		source     string
	}{
		{"worker", nil, nil, nil, "high", "local"},
		{"preference", ptr("model"), nil, map[string]string{"model": "low"}, "low", "preference"},
		{"explicit", ptr("model"), ptr("high"), map[string]string{"model": "low"}, "high", "explicit"},
		{"stale preference", ptr("model"), nil, map[string]string{"model": "retired"}, "high", "local"},
		{"different model", ptr("alias"), nil, map[string]string{"plain": "low"}, "high", "local"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ResolveNativeSelection(selectionBase(), model.BotOverrides{ReasoningEffort: tc.override}, model.BotNativePreference{Efforts: tc.preference}, selectionCatalog(), tc.selected)
			if err != nil || result.ReasoningEffort == nil || *result.ReasoningEffort != tc.want || result.Selection.ReasoningEffortSource != tc.source {
				t.Fatalf("%+v %v", result, err)
			}
			if result.Selection.ConfigurationGeneration != strings.Repeat("a", 64) || result.Selection.CatalogGeneration != botID {
				t.Fatal("lost discovery identity")
			}
		})
	}
	catalog := selectionCatalog()
	catalog.SelectionError = &ro.Error{Code: "unsupported_selection", Message: "Worker high is incompatible"}
	catalog.Defaults.ReasoningEffort.Value = ptr("retired")
	_, err := ResolveNativeSelection(selectionBase(), model.BotOverrides{}, model.BotNativePreference{Efforts: map[string]string{"model": "low"}}, catalog, ptr("model"))
	assertFault(t, err, "unsupported_selection")
	repaired, err := ResolveNativeSelection(selectionBase(), model.BotOverrides{ReasoningEffort: ptr("low")}, model.BotNativePreference{}, catalog, ptr("model"))
	if err != nil || *repaired.ReasoningEffort != "low" {
		t.Fatalf("explicit repair rejected: %+v %v", repaired, err)
	}
	_, err = ResolveNativeSelection(selectionBase(), model.BotOverrides{ReasoningEffort: ptr("retired")}, model.BotNativePreference{}, catalog, ptr("model"))
	assertFault(t, err, "unsupported_selection")
	catalog = selectionCatalog()
	catalog.Defaults.Model.Value = nil
	_, err = ResolveNativeSelection(selectionBase(), model.BotOverrides{}, model.BotNativePreference{}, catalog, nil)
	assertFault(t, err, "unknown_default")
	_, err = ResolveNativeSelection(selectionBase(), model.BotOverrides{}, model.BotNativePreference{}, catalog, ptr("missing"))
	assertFault(t, err, "unsupported_selection")
	catalog.Defaults.ReasoningEffort = ro.ModelDefault{Source: "native"}
	result, err := ResolveNativeSelection(selectionBase(), model.BotOverrides{}, model.BotNativePreference{}, catalog, ptr("plain"))
	if err != nil || result.ReasoningEffort != nil {
		t.Fatalf("model without effort: %+v %v", result, err)
	}
}

func TestPreparedSelectionRechecksDefaultsAndKeepsOriginalID(t *testing.T) {
	now := time.Now()
	worker := availableWorker(workerID, now)
	worker.Telemetry.AssistantHost.CreationConfigurationVersion = 1
	defaults := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}}
	original := input()
	original.Overrides = model.BotOverrides{WorkerID: ptr(workerID), Model: ptr("model")}
	in, fp, err := NormalizeBotRequest(original)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveBotDefaults(defaults, in.Overrides)
	if err != nil {
		t.Fatal(err)
	}
	in.Resolution = &CreationResolution{Expected: *resolved.Configuration, Configuration: *resolved.Configuration}
	in.Resolution.Configuration.ReasoningEffort = ptr("low")
	in.Resolution.Configuration.Selection = &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "native"}
	dao := &botDAO{defaults: defaults, fail: map[string]error{}}
	created, err := Create(context.Background(), dao, model.Principal{UserID: "owner"}, in, fp, true)
	if err != nil {
		t.Fatal(err)
	}
	if *created.ResolvedConfiguration.ReasoningEffort != "low" {
		t.Fatal("did not freeze observed choice")
	}
	dao.defaults.Workers = nil
	replay, err := Create(context.Background(), dao, model.Principal{UserID: "owner"}, in, fp, true)
	if err != nil || replay.ID != created.ID {
		t.Fatalf("replay required live defaults: %v", err)
	}
	dao.current = nil
	dao.defaults = defaults
	dao.defaults.Workers[0].Telemetry.AssistantHost.DefaultCwd = "/changed"
	_, err = Create(context.Background(), dao, model.Principal{UserID: "owner"}, in, fp, true)
	assertFault(t, err, "resource_conflict")
	if dao.current != nil {
		t.Fatal("changed default inserted a bot")
	}
}

func TestSelectionValidationAndLegacyStoredRecords(t *testing.T) {
	var legacy model.BotConfiguration
	if err := json.Unmarshal([]byte(`{"workerId":"`+workerID+`","cwd":"/work","provider":"codex","model":null,"args":[]}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.Selection != nil || validateSelection(legacy) != nil {
		t.Fatal("legacy record no longer readable")
	}
	for _, change := range []func(*model.BotConfiguration){
		func(c *model.BotConfiguration) { c.Selection.SchemaVersion = 2 },
		func(c *model.BotConfiguration) { c.Selection.ModelSource = "bad" },
		func(c *model.BotConfiguration) { c.Selection.ModelSource = "unknown" },
		func(c *model.BotConfiguration) { c.Selection.ModelSource = "explicit"; c.Model = nil },
		func(c *model.BotConfiguration) { c.ReasoningEffort = ptr("\n") },
		func(c *model.BotConfiguration) { c.Selection = nil; c.ReasoningEffort = ptr("high") },
	} {
		c := selectionBase()
		c.ReasoningEffort = ptr("high")
		change(&c)
		assertFault(t, validateSelection(c), "invalid_input")
	}
}
