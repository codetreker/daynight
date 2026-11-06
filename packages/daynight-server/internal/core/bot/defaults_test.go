package bot

import (
	"context"
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
