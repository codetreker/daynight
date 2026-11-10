package bot

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestNativeOverridesPreserveExplicitFingerprintAndRejectInvalidText(t *testing.T) {
	base := input()
	_, original, err := NormalizeBotRequest(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, overrides := range []model.BotOverrides{
		{Model: ptr("model-a")}, {ReasoningEffort: ptr("high")}, {Model: ptr("model-a"), ReasoningEffort: ptr("high")},
	} {
		base.Overrides = overrides
		_, fingerprint, err := NormalizeBotRequest(base)
		if err != nil || fingerprint == original {
			t.Fatalf("explicit identity: %s %v", fingerprint, err)
		}
		base.ResolvedConfiguration.Model = ptr("changed-default")
		_, second, err := NormalizeBotRequest(base)
		if err != nil || second != fingerprint {
			t.Fatalf("default leaked into identity: %v", err)
		}
	}
	for _, value := range []string{"", " ", "bad\nmodel", strings.Repeat("m", 257), string([]byte{255})} {
		base.Overrides = model.BotOverrides{Model: &value}
		_, _, err := NormalizeBotRequest(base)
		assertFault(t, err, "invalid_input")
	}
}

func TestNewWorkerDefaultsAndLegacyWireShape(t *testing.T) {
	now := time.Now()
	worker := availableWorker(workerID, now)
	defaults := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}}
	legacy, err := ResolveBotDefaults(defaults, model.BotOverrides{})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(legacy.Configuration)
	if strings.Contains(string(raw), "selection") || strings.Contains(string(raw), "reasoningEffort") {
		t.Fatalf("legacy shape changed: %s", raw)
	}
	unsupported, err := ResolveBotDefaults(defaults, model.BotOverrides{WorkerID: ptr(workerID), Model: ptr("new")})
	if err != nil || unsupported.Configuration != nil || unsupported.Reason == nil || *unsupported.Reason != "unsupported_native_selection" {
		t.Fatalf("legacy accepted override: %+v %v", unsupported, err)
	}
	worker.Telemetry.AssistantHost.CreationConfigurationVersion = 1
	defaults.Workers[0] = worker
	resolved, err := ResolveBotDefaults(defaults, model.BotOverrides{WorkerID: ptr(workerID), Model: ptr("new")})
	if err != nil || resolved.Configuration.Selection == nil || *resolved.Configuration.Model != "new" || resolved.Configuration.Selection.ModelSource != "explicit" {
		t.Fatalf("new selection: %+v %v", resolved, err)
	}
	raw, _ = json.Marshal(resolved.Configuration)
	if !strings.Contains(string(raw), `"reasoningEffort":null`) {
		t.Fatalf("missing native effort: %s", raw)
	}
}
