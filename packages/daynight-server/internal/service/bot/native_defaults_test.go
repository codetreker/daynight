package bot

import (
	"context"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

func TestNativeDefaultsPreviewMatchesCreationWithoutSavingPreferences(t *testing.T) {
	bots, db, p, worker := botService(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	report := serviceWorkerReport()
	report.Telemetry.AssistantHost = validAssistantHost()
	report.Telemetry.AssistantHost.ObservedAt = time.Now().Add(-time.Second)
	report.Telemetry.AssistantHost.CreationConfigurationVersion = 1
	if _, err := workerservice.NewWorkers(db).Report(ctx, p, worker, report); err != nil {
		t.Fatal(err)
	}
	calls := 0
	bots.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
		calls++
		return nativeResponse(p, w, r), nil
	})
	overrides := model.BotOverrides{WorkerID: &worker, Model: pointer("model-b"), ReasoningEffort: pointer("low")}
	preview, err := bots.DefaultsFor(ctx, p, overrides)
	if err != nil || preview.Configuration == nil || *preview.Configuration.Model != "model-b" || *preview.Configuration.ReasoningEffort != "low" {
		t.Fatalf("explicit preview: %+v %v", preview, err)
	}
	if len(preview.Workers) != 1 || preview.Workers[0].Configuration.Model != preview.Configuration.Model || preview.Workers[0].Configuration.Selection.CatalogGeneration != preview.Configuration.Selection.CatalogGeneration {
		t.Fatalf("selected Worker preview disagrees: %+v", preview)
	}
	created, err := bots.CreateResolved(ctx, p, botcore.CreateBot{ID: uuid.NewString(), Name: "Preview", Overrides: overrides})
	if err != nil || *created.ResolvedConfiguration.Model != *preview.Configuration.Model || *created.ResolvedConfiguration.ReasoningEffort != *preview.Configuration.ReasoningEffort || calls != 2 {
		t.Fatalf("preview/create diverged: %+v %v %d", created, err, calls)
	}
	var preferences int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM bot_model_preferences)+(SELECT count(*) FROM bot_effort_preferences)`).Scan(&preferences); err != nil || preferences != 0 {
		t.Fatalf("preview/pending saved native preferences: %d %v", preferences, err)
	}
	for _, invalid := range []model.BotOverrides{{WorkerID: &worker, Model: pointer(" ")}, {WorkerID: &worker, ReasoningEffort: pointer("\n")}} {
		_, err := bots.DefaultsFor(ctx, p, invalid)
		requireFault(t, err, "invalid_input")
	}
	_, err = bots.DefaultsFor(ctx, p, model.BotOverrides{WorkerID: &worker, Model: pointer("unavailable-model")})
	requireFault(t, err, "unsupported_selection")
	bots.models = modelRequestFunc(func(context.Context, model.Principal, string, ro.Request) (ro.Message, error) {
		return ro.Message{}, nativeFailure("cleanup_unknown", "Unconfirmed native probe cleanup")
	})
	_, err = bots.DefaultsFor(ctx, p, overrides)
	requireFault(t, err, "cleanup_unknown")
}
