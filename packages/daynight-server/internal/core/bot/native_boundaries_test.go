package bot

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
)

func TestFrozenSelectionAcceptsValidProvenanceAndRejectsCorruptSnapshots(t *testing.T) {
	for _, source := range []string{"explicit", "preference", "local", "cloud", "native", "unknown"} {
		t.Run(source, func(t *testing.T) {
			configuration := selectionBase()
			configuration.ReasoningEffort = ptr("high")
			configuration.Selection = &model.BotSelection{
				SchemaVersion: 1, ModelSource: source, ReasoningEffortSource: source,
				ConfigurationGeneration: strings.Repeat("ab", 32), CatalogGeneration: botID,
			}
			if source == "native" || source == "unknown" {
				configuration.Model, configuration.ReasoningEffort = nil, nil
			}
			if err := ValidateFrozenSelection(configuration); err != nil {
				t.Fatalf("valid frozen snapshot rejected: %v", err)
			}
		})
	}
	for _, tc := range []struct {
		name   string
		change func(*model.BotConfiguration)
	}{
		{"digest not hexadecimal", func(c *model.BotConfiguration) { c.Selection.ConfigurationGeneration = strings.Repeat("z", 64) }},
		{"digest wrong size", func(c *model.BotConfiguration) { c.Selection.ConfigurationGeneration = "ab" }},
		{"digest not canonical", func(c *model.BotConfiguration) { c.Selection.ConfigurationGeneration = strings.Repeat("AB", 32) }},
		{"catalog not UUID", func(c *model.BotConfiguration) { c.Selection.CatalogGeneration = "not-a-uuid" }},
		{"catalog not canonical", func(c *model.BotConfiguration) {
			c.Selection.CatalogGeneration = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
		}},
		{"model control character", func(c *model.BotConfiguration) { c.Model = ptr("model\n") }},
		{"effort missing explicit value", func(c *model.BotConfiguration) {
			c.Selection.ReasoningEffortSource = "explicit"
			c.ReasoningEffort = nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			configuration := selectionBase()
			configuration.ReasoningEffort = ptr("high")
			tc.change(&configuration)
			assertFault(t, ValidateFrozenSelection(configuration), "invalid_input")
		})
	}
}

func TestNativeDefaultsPreservePrecedenceAndModelBoundEffort(t *testing.T) {
	for _, tc := range []struct {
		name         string
		runtime      *model.WorkerRuntimeNative
		preference   model.BotNativePreference
		overrides    model.BotOverrides
		wantModel    string
		wantEffort   string
		modelSource  string
		effortSource string
	}{
		{name: "cloud arguments", wantModel: "cloud-model", wantEffort: "cloud-effort", modelSource: "cloud", effortSource: "cloud"},
		{name: "another provider cannot replace defaults", runtime: &model.WorkerRuntimeNative{Agent: "claude", Model: model.WorkerConfigurationValue{Value: ptr("other"), Source: "local"}}, wantModel: "cloud-model", wantEffort: "cloud-effort", modelSource: "cloud", effortSource: "cloud"},
		{name: "local runtime replaces cloud", runtime: &model.WorkerRuntimeNative{Agent: "codex", Model: model.WorkerConfigurationValue{Value: ptr("local-model"), Source: "local"}, ReasoningEffort: model.WorkerConfigurationValue{Value: ptr("local-effort"), Source: "local"}}, wantModel: "local-model", wantEffort: "local-effort", modelSource: "local", effortSource: "local"},
		{name: "native runtime clears cloud values", runtime: &model.WorkerRuntimeNative{Agent: "codex", Model: model.WorkerConfigurationValue{Source: "native"}, ReasoningEffort: model.WorkerConfigurationValue{Source: "native"}}, modelSource: "native", effortSource: "native"},
		{name: "remembered model and its effort", preference: model.BotNativePreference{Model: ptr("remembered"), Efforts: map[string]string{"remembered": "low"}}, wantModel: "remembered", wantEffort: "low", modelSource: "preference", effortSource: "preference"},
		{name: "explicit model selects its own remembered effort", preference: model.BotNativePreference{Model: ptr("remembered"), Efforts: map[string]string{"remembered": "low", "chosen": "high"}}, overrides: model.BotOverrides{Model: ptr("chosen")}, wantModel: "chosen", wantEffort: "high", modelSource: "explicit", effortSource: "preference"},
		{name: "another model effort never leaks", preference: model.BotNativePreference{Efforts: map[string]string{"other": "low"}}, overrides: model.BotOverrides{Model: ptr("chosen")}, wantModel: "chosen", wantEffort: "cloud-effort", modelSource: "explicit", effortSource: "cloud"},
		{name: "explicit effort wins", preference: model.BotNativePreference{Model: ptr("remembered"), Efforts: map[string]string{"remembered": "low"}}, overrides: model.BotOverrides{ReasoningEffort: ptr("high")}, wantModel: "remembered", wantEffort: "high", modelSource: "preference", effortSource: "explicit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now()
			worker := availableWorker(workerID, now)
			worker.Telemetry.AssistantHost.CreationConfigurationVersion = 1
			worker.Telemetry.AssistantHost.Providers[0].Model = ptr("cloud-model")
			args := []string{"--effort", "cloud-effort", "--flag"}
			worker.Telemetry.AssistantHost.Providers[0].Args = args
			worker.Telemetry.RuntimeConfiguration = &model.WorkerRuntimeConfiguration{SchemaVersion: 1, Native: tc.runtime}
			input := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}, WorkerPreferences: map[string]model.BotWorkerPreference{workerID: {Native: map[string]model.BotNativePreference{"codex": tc.preference}}}}
			result, err := ResolveBotDefaults(input, tc.overrides)
			if err != nil || result.Configuration == nil {
				t.Fatalf("defaults unavailable: %+v %v", result, err)
			}
			configuration := result.Configuration
			checkValue := func(name string, value *string, want string) {
				t.Helper()
				if want == "" {
					if value != nil {
						t.Fatalf("%s should delegate to native, got %q", name, *value)
					}
				} else if value == nil || *value != want {
					t.Fatalf("%s = %v, want %q", name, value, want)
				}
			}
			checkValue("model", configuration.Model, tc.wantModel)
			checkValue("effort", configuration.ReasoningEffort, tc.wantEffort)
			if configuration.Selection.ModelSource != tc.modelSource || configuration.Selection.ReasoningEffortSource != tc.effortSource || !reflect.DeepEqual(configuration.Args, args) {
				t.Fatalf("lost source or provider arguments: %+v %+v", configuration, configuration.Selection)
			}
		})
	}
}

func TestWorkerNativeDefaultsRemovesHistoryWithoutMutatingCaller(t *testing.T) {
	now := time.Now()
	worker := availableWorker(workerID, now)
	worker.Telemetry.AssistantHost.CreationConfigurationVersion = 1
	worker.Telemetry.AssistantHost.Providers[0].Args = []string{"--effort", "high"}
	input := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}, PreferredWorkerID: ptr(botID), WorkerPreferences: map[string]model.BotWorkerPreference{
		workerID: {Cwd: ptr("/remembered"), Provider: ptr("codex"), Native: map[string]model.BotNativePreference{"codex": {Model: ptr("history"), Efforts: map[string]string{"history": "low"}}}},
		botID:    {Native: map[string]model.BotNativePreference{"codex": {Model: ptr("unrelated")}}},
	}}
	baseline, err := WorkerNativeDefaults(input, model.BotOverrides{}, workerID)
	if err != nil || baseline.WorkerID != workerID || baseline.Cwd != "/remembered" || baseline.Provider != "codex" || baseline.Model == nil || *baseline.Model != "model" || baseline.ReasoningEffort == nil || *baseline.ReasoningEffort != "high" || baseline.Selection.ModelSource != "cloud" || baseline.Selection.ReasoningEffortSource != "cloud" {
		t.Fatalf("baseline did not preserve current Worker defaults: %+v %v", baseline, err)
	}
	if *input.WorkerPreferences[workerID].Native["codex"].Model != "history" || input.WorkerPreferences[workerID].Native["codex"].Efforts["history"] != "low" || *input.WorkerPreferences[botID].Native["codex"].Model != "unrelated" {
		t.Fatal("baseline lookup mutated caller-owned history")
	}
	explicit, err := WorkerNativeDefaults(input, model.BotOverrides{Cwd: ptr("/explicit"), Model: ptr("chosen"), ReasoningEffort: ptr("medium")}, workerID)
	if err != nil || explicit.Cwd != "/explicit" || *explicit.Model != "chosen" || *explicit.ReasoningEffort != "medium" || explicit.Selection.ModelSource != "explicit" || explicit.Selection.ReasoningEffortSource != "explicit" {
		t.Fatalf("baseline discarded current overrides: %+v %v", explicit, err)
	}
	_, err = WorkerNativeDefaults(input, model.BotOverrides{}, "missing")
	assertFault(t, err, "forbidden")
	_, err = WorkerNativeDefaults(input, model.BotOverrides{Model: ptr("")}, workerID)
	assertFault(t, err, "invalid_input")
	worker.Telemetry.AssistantHost.CreationConfigurationVersion = 0
	input.Workers[0] = worker
	legacy, err := WorkerNativeDefaults(input, model.BotOverrides{}, workerID)
	if err != nil || legacy.Selection != nil || legacy.ReasoningEffort != nil {
		t.Fatalf("legacy Worker shape changed: %+v %v", legacy, err)
	}
	_, err = WorkerNativeDefaults(input, model.BotOverrides{ReasoningEffort: ptr("high")}, workerID)
	assertFault(t, err, "resource_conflict")
}

func TestNativeDelegationFallbackPreservesExplicitConfigurationAndErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*model.BotConfiguration, *model.BotOverrides, *ro.ModelResult) *string
		want   bool
	}{
		{"native delegation", func(*model.BotConfiguration, *model.BotOverrides, *ro.ModelResult) *string { return nil }, true},
		{"unknown native default", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.SelectionError = &ro.Error{Code: "unknown_default"}
			return nil
		}, true},
		{"selected model", func(*model.BotConfiguration, *model.BotOverrides, *ro.ModelResult) *string { return ptr("chosen") }, false},
		{"explicit model", func(_ *model.BotConfiguration, o *model.BotOverrides, _ *ro.ModelResult) *string {
			o.Model = ptr("chosen")
			return nil
		}, false},
		{"explicit effort", func(_ *model.BotConfiguration, o *model.BotOverrides, _ *ro.ModelResult) *string {
			o.ReasoningEffort = ptr("high")
			return nil
		}, false},
		{"Worker model", func(b *model.BotConfiguration, _ *model.BotOverrides, _ *ro.ModelResult) *string {
			b.Model = ptr("local")
			b.Selection.ModelSource = "local"
			return nil
		}, false},
		{"Worker effort", func(b *model.BotConfiguration, _ *model.BotOverrides, _ *ro.ModelResult) *string {
			b.ReasoningEffort = ptr("high")
			return nil
		}, false},
		{"legacy Worker", func(b *model.BotConfiguration, _ *model.BotOverrides, _ *ro.ModelResult) *string {
			b.Selection = nil
			return nil
		}, false},
		{"unknown provenance", func(b *model.BotConfiguration, _ *model.BotOverrides, _ *ro.ModelResult) *string {
			b.Selection.ModelSource = "unknown"
			return nil
		}, false},
		{"catalog model", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.Defaults.Model.Value = ptr("model")
			return nil
		}, false},
		{"catalog effort", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.Defaults.ReasoningEffort.Value = ptr("high")
			return nil
		}, false},
		{"local effort provenance", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.Defaults.ReasoningEffort.Source = "local"
			return nil
		}, false},
		{"cloud effort provenance", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.Defaults.ReasoningEffort.Source = "cloud"
			return nil
		}, false},
		{"explicit effort provenance", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.Defaults.ReasoningEffort.Source = "explicit"
			return nil
		}, false},
		{"incompatible configuration", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.SelectionError = &ro.Error{Code: "unsupported_selection"}
			return nil
		}, false},
		{"cleanup unknown", func(_ *model.BotConfiguration, _ *model.BotOverrides, c *ro.ModelResult) *string {
			c.SelectionError = &ro.Error{Code: "cleanup_unknown"}
			return nil
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			baseline := model.BotConfiguration{Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "native"}}
			overrides := model.BotOverrides{}
			catalog := ro.ModelResult{Defaults: ro.ModelDefaults{Model: ro.ModelDefault{Source: "native"}, ReasoningEffort: ro.ModelDefault{Source: "native"}}}
			selected := tc.change(&baseline, &overrides, &catalog)
			if got := NativeDelegationFallback(baseline, overrides, catalog, selected); got != tc.want {
				t.Fatalf("fallback = %v, want %v", got, tc.want)
			}
		})
	}
}
