package bot

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func availableWorker(id string, now time.Time) model.WorkerSnapshot {
	return model.WorkerSnapshot{WorkerID: id, LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: now, DefaultCwd: "/default", DefaultProvider: "codex", Providers: []model.WorkerAssistantProvider{{Provider: "codex", Available: true, Model: ptr("model"), Args: []string{"--flag"}}, {Provider: "claude", Available: false, Reason: ptr("missing")}}}}}
}

func TestDefaultsSelectionAndExplicitChoices(t *testing.T) {
	now := time.Now()
	first := availableWorker(workerID, now)
	second := availableWorker(botID, now)
	input := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{first, second}, PreferredWorkerID: ptr(botID), WorkerPreferences: map[string]model.BotWorkerPreference{botID: {Cwd: ptr("/remembered"), Provider: ptr("codex")}}}
	result, err := ResolveBotDefaults(input, model.BotOverrides{})
	if err != nil || result.WorkerID == nil || *result.WorkerID != botID || result.Configuration.Cwd != "/remembered" || *result.Configuration.Model != "model" || len(result.Configuration.Args) != 1 {
		t.Fatalf("preferred: %+v %v", result, err)
	}
	result, err = ResolveBotDefaults(input, model.BotOverrides{WorkerID: ptr(workerID), Cwd: ptr("/explicit")})
	if err != nil || *result.WorkerID != workerID || result.Configuration.Cwd != "/explicit" {
		t.Fatalf("explicit: %+v %v", result, err)
	}
	_, err = ResolveBotDefaults(input, model.BotOverrides{WorkerID: ptr("missing")})
	assertFault(t, err, "forbidden")
	second.LastReportedAt = now.Add(-3 * time.Minute)
	input.Workers[1] = second
	result, err = ResolveBotDefaults(input, model.BotOverrides{})
	if err != nil || *result.WorkerID != workerID {
		t.Fatalf("offline preferred should fall back: %+v %v", result, err)
	}
	result, err = ResolveBotDefaults(input, model.BotOverrides{WorkerID: ptr(botID)})
	if err != nil || result.Configuration != nil || result.Reason == nil || *result.Reason != "offline" {
		t.Fatalf("explicit offline worker switched: %+v %v", result, err)
	}
	for _, tc := range []struct {
		name      string
		overrides model.BotOverrides
		reason    string
	}{{"directory", model.BotOverrides{Cwd: ptr("relative")}, "invalid_cwd"}, {"provider missing", model.BotOverrides{Provider: ptr("copilot")}, "provider_unavailable"}, {"provider unavailable", model.BotOverrides{Provider: ptr("claude")}, "provider_missing"}} {
		t.Run(tc.name, func(t *testing.T) {
			tc.overrides.WorkerID = ptr(workerID)
			result, err := ResolveBotDefaults(input, tc.overrides)
			if err != nil || result.Configuration != nil || result.Reason == nil || *result.Reason != tc.reason {
				t.Fatalf("%+v %v", result, err)
			}
		})
	}
	first.Telemetry.AssistantHost.Providers[1].Reason = nil
	input.Workers[0] = first
	result, err = ResolveBotDefaults(input, model.BotOverrides{WorkerID: ptr(workerID), Provider: ptr("claude")})
	if err != nil || *result.Reason != "provider_unavailable" {
		t.Fatalf("missing reason: %+v %v", result, err)
	}
	input.Workers = nil
	result, err = ResolveBotDefaults(input, model.BotOverrides{})
	if err != nil || *result.Reason != "no_available_worker" {
		t.Fatalf("empty: %+v %v", result, err)
	}
}

func TestDefaultsSkipsOnlineLegacyWorker(t *testing.T) {
	observedAt := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	legacy := availableWorker(workerID, observedAt.Add(-time.Second))
	legacy.Telemetry.AssistantHost = nil
	usable := availableWorker(botID, observedAt)
	usable.Telemetry.Machine = model.WorkerMachine{ID: "55555555-5555-4555-8555-555555555555", Name: "Assistant host"}
	usable.Telemetry.AssistantHost.DefaultCwd = "/workspace"
	usable.Telemetry.AssistantHost.DefaultProvider = model.AgentCopilot
	usable.Telemetry.AssistantHost.Providers = []model.WorkerAssistantProvider{
		{Provider: model.AgentCodex, Available: true, Args: []string{}},
		{Provider: model.AgentClaude, Reason: ptr("not_found"), Args: []string{}},
		{Provider: model.AgentCopilot, Available: true, Model: ptr("gpt-5"), Args: []string{"--effort", "high"}},
	}

	defaults, err := ResolveBotDefaults(model.BotDefaultsInput{
		ObservedAt: observedAt,
		Workers:    []model.WorkerSnapshot{legacy, usable},
	}, model.BotOverrides{})
	if err != nil {
		t.Fatal(err)
	}
	if defaults.ObservedAt != observedAt {
		t.Fatalf("defaults observation time changed: got %s want %s", defaults.ObservedAt, observedAt)
	}
	if len(defaults.Workers) != 2 || defaults.Workers[0].WorkerID != legacy.WorkerID || defaults.Workers[1].WorkerID != usable.WorkerID {
		t.Fatalf("default candidates lost the legacy-first order: %+v", defaults.Workers)
	}
	first, second := defaults.Workers[0], defaults.Workers[1]
	if first.State != "unsupported" || first.Providers == nil || len(first.Providers) != 0 || first.Configuration != nil ||
		second.State != "available" || len(second.Providers) != 3 || second.Machine != usable.Telemetry.Machine || second.Platform != model.PlatformLinux {
		t.Fatalf("default candidate facts changed: %+v", defaults.Workers)
	}
	config := defaults.Configuration
	if defaults.WorkerID == nil || *defaults.WorkerID != usable.WorkerID || defaults.Reason != nil || config == nil || config.WorkerID != usable.WorkerID {
		t.Fatalf("automatic defaults did not select the usable Worker: %+v", defaults)
	}
	if config.Cwd != "/workspace" || config.Provider != "copilot" || config.Model == nil || *config.Model != "gpt-5" ||
		!slices.Equal(config.Args, []string{"--effort", "high"}) {
		t.Fatalf("selected Worker provider defaults changed: %+v", config)
	}
}

func TestDefaultsAndResolvedCreationShareInputs(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	defaults := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{availableWorker(workerID, now)}}
	p := model.Principal{UserID: "owner"}
	r := &reader{defaults: defaults, fail: map[string]error{}}
	preview, err := Defaults(ctx, snapshot{r: r}, p, nil)
	if err != nil || preview.Configuration == nil {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	in, fp, err := NormalizeBotRequest(input())
	if err != nil {
		t.Fatal(err)
	}
	d := &botDAO{defaults: defaults, fail: map[string]error{}}
	created, err := Create(ctx, d, p, in, fp, true)
	if err != nil || created.ResolvedConfiguration.Cwd != preview.Configuration.Cwd {
		t.Fatalf("creation: %+v %v", created, err)
	}
}
