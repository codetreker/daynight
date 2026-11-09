package bot

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"reflect"
	"testing"
	"time"
)

func workerValidationValue[T any](value T) *T { return &value }

func validAssistantHost() *model.WorkerAssistantHost {
	return &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC), DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot, Providers: []model.WorkerAssistantProvider{
		{Provider: model.AgentCodex, Available: true, Args: []string{}},
		{Provider: model.AgentClaude, Reason: workerValidationValue("not_found"), Args: []string{}},
		{Provider: model.AgentCopilot, Available: true, Model: workerValidationValue("gpt-5"), Args: []string{"--effort", "high"}},
	}}
}

func TestBotDefaultsWorkerAndProviderSettingsNeverCross(t *testing.T) {
	now := time.Now().UTC()
	first, second := uuid.NewString(), uuid.NewString()
	host := validAssistantHost()
	host.ObservedAt = now
	other := validAssistantHost()
	other.ObservedAt = now
	other.DefaultCwd = "/other"
	other.Providers[0].Args = []string{"--other"}
	input := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{
		{WorkerID: first, LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: host}},
		{WorkerID: second, LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: other}},
	}, PreferredWorkerID: &second, WorkerPreferences: map[string]model.BotWorkerPreference{
		first: {Cwd: workerValidationValue("/first-preference"), Provider: workerValidationValue("codex")},
	}}
	result, err := ResolveBotDefaults(input, model.BotOverrides{})
	if err != nil || result.Configuration.Cwd != "/other" || result.Configuration.Provider != "copilot" {
		t.Fatalf("cross-worker defaults: %+v %v", result, err)
	}
	result, err = ResolveBotDefaults(input, model.BotOverrides{WorkerID: &first})
	if err != nil || result.Configuration.Cwd != "/first-preference" || result.Configuration.Provider != "codex" || result.Configuration.Model != nil || len(result.Configuration.Args) != 0 {
		t.Fatalf("cross-provider defaults: %+v %v", result, err)
	}
	result, err = ResolveBotDefaults(input, model.BotOverrides{WorkerID: &second, Provider: workerValidationValue("codex"), Cwd: workerValidationValue("/explicit")})
	if err != nil || result.Configuration.Cwd != "/explicit" || result.Configuration.Model != nil || !reflect.DeepEqual(result.Configuration.Args, []string{"--other"}) {
		t.Fatalf("overrides: %+v %v", result, err)
	}
	unknown := uuid.NewString()
	_, err = ResolveBotDefaults(input, model.BotOverrides{WorkerID: &unknown})
	assertFault(t, err, "forbidden")
}

func TestBotDefaultsUnavailableReasonsAndNoInventedProviderFallback(t *testing.T) {
	now := time.Now().UTC()
	for _, tc := range []struct {
		name, reason string
		change       func(*model.WorkerSnapshot, *model.BotOverrides)
	}{
		{"legacy", "unsupported", func(w *model.WorkerSnapshot, o *model.BotOverrides) { w.Telemetry.AssistantHost = nil }},
		{"stale", "stale", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			w.Telemetry.AssistantHost.ObservedAt = now.Add(-120 * time.Second)
		}},
		{"default failed", "provider_not_found", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			w.Telemetry.AssistantHost.DefaultProvider = model.AgentClaude
		}},
		{"override failed", "provider_not_found", func(w *model.WorkerSnapshot, o *model.BotOverrides) { o.Provider = workerValidationValue("claude") }},
		{"missing provider", "provider_unavailable", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			w.Telemetry.AssistantHost.Providers = w.Telemetry.AssistantHost.Providers[:2]
		}},
		{"wrong path platform", "invalid_cwd", func(w *model.WorkerSnapshot, o *model.BotOverrides) { o.Cwd = workerValidationValue(`C:\work`) }},
		{"all failed", "unavailable", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			for i := range w.Telemetry.AssistantHost.Providers {
				w.Telemetry.AssistantHost.Providers[i].Available = false
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := validAssistantHost()
			host.ObservedAt = now
			worker := model.WorkerSnapshot{WorkerID: uuid.NewString(), LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: host}}
			overrides := model.BotOverrides{WorkerID: &worker.WorkerID}
			tc.change(&worker, &overrides)
			result, err := ResolveBotDefaults(model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}}, overrides)
			if err != nil || result.Configuration != nil || result.Reason == nil || *result.Reason != tc.reason {
				t.Fatalf("got %+v %v", result, err)
			}
			overrides.WorkerID = nil
			result, err = ResolveBotDefaults(model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}}, overrides)
			if err != nil || result.WorkerID != nil || *result.Reason != "no_available_worker" {
				t.Fatalf("automatic got %+v %v", result, err)
			}
		})
	}
}
