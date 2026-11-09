package bot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

type modelRequestFunc func(context.Context, model.Principal, string, ro.Request) (ro.Message, error)

func (f modelRequestFunc) Request(ctx context.Context, p model.Principal, worker string, r ro.Request) (ro.Message, error) {
	return f(ctx, p, worker, r)
}
func nativeResponse(p model.Principal, worker string, request ro.Request) ro.Message {
	var input ro.ModelInput
	_ = json.Unmarshal(request.Input, &input)
	selected := input.Model
	source := "explicit"
	if selected == nil {
		selected = pointer("model-a")
		source = "native"
	}
	catalog := ro.ModelResult{SchemaVersion: 1, Provider: input.Provider, Cwd: *input.Cwd, ConfigurationGeneration: strings.Repeat("a", 64), CatalogGeneration: "ca62d2bb-d4bf-47b8-93bd-d57e5a7fcefd",
		Models:   []ro.ModelOption{{ID: "model-a", Label: "Model A", Aliases: []string{}, ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: pointer("high")}, {ID: "model-b", Label: "Model B", Aliases: []string{}, ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: pointer("low")}},
		Defaults: ro.ModelDefaults{Model: ro.ModelDefault{Value: selected, Source: source}, ReasoningEffort: ro.ModelDefault{Value: pointer("high"), Source: "cloud"}}}
	raw, _ := json.Marshal(catalog)
	return ro.Message{Fence: ro.Fence{Protocol: ro.Protocol, OwnerUserID: p.UserID, WorkerID: worker, ConnectionID: "d9ae323c-8ab9-43f1-99d4-85d006de9c58", CapabilityGeneration: "43221814-a769-42c8-91ec-11d3c5907adf"}, Type: "result", RequestID: request.RequestID, Result: raw}
}
func TestCreationNativeDiscoveryIsOutsideLocksAndNameOnlySkipsIt(t *testing.T) {
	bots, db, p, worker := botService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	report := serviceWorkerReport()
	report.Telemetry.AssistantHost = validAssistantHost()
	report.Telemetry.AssistantHost.ObservedAt = time.Now().Add(-time.Second)
	report.Telemetry.AssistantHost.CreationConfigurationVersion = 1
	if _, err := workerservice.NewWorkers(db).Report(ctx, p, worker, report); err != nil {
		t.Fatal(err)
	}
	calls := 0
	bots.models = modelRequestFunc(func(ctx context.Context, actor model.Principal, id string, r ro.Request) (ro.Message, error) {
		calls++
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 31*time.Second {
			t.Fatal("missing total discovery budget")
		}
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			return ro.Message{}, err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE NOWAIT`, p.CredentialID); err != nil {
			t.Fatalf("network discovery held credential lock: %v", err)
		}
		return nativeResponse(actor, id, r), nil
	})
	for index, overrides := range []model.BotOverrides{{}, {WorkerID: &worker, Model: pointer("model-a")}, {WorkerID: &worker, ReasoningEffort: pointer("low")}, {WorkerID: &worker, Model: pointer("model-b"), ReasoningEffort: pointer("low")}} {
		request := botcore.CreateBot{ID: uuid.NewString(), Name: "Native", Overrides: overrides}
		created, err := bots.CreateResolved(ctx, p, request)
		if err != nil {
			for cause := err; cause != nil; cause = errors.Unwrap(cause) {
				t.Logf("%T: %v", cause, cause)
			}
			t.Fatal(err)
		}
		if calls != index {
			t.Fatalf("name or explicit discovery count: %d != %d", calls, index)
		}
		if created.ResolvedConfiguration.Selection == nil {
			t.Fatal("missing new configuration schema")
		}
		if overrides.ReasoningEffort != nil && *created.ResolvedConfiguration.ReasoningEffort != *overrides.ReasoningEffort {
			t.Fatal("lost effort")
		}
		again, err := bots.CreateResolved(ctx, p, request)
		if err != nil || again.ID != created.ID || calls != index {
			t.Fatalf("replay repeated discovery: %+v %v %d", again, err, calls)
		}
	}
	var preferences int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM bot_model_preferences)+(SELECT count(*) FROM bot_effort_preferences)`).Scan(&preferences); err != nil || preferences != 0 {
		t.Fatalf("pending saved preferences: %d %v", preferences, err)
	}
}

func TestCreationNativeDiscoveryRejectsStaleSnapshotAndReplaysWinner(t *testing.T) {
	bots, db, p, worker := botService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	report := serviceWorkerReport()
	report.Telemetry.AssistantHost = validAssistantHost()
	report.Telemetry.AssistantHost.ObservedAt = time.Now().Add(-time.Second)
	report.Telemetry.AssistantHost.CreationConfigurationVersion = 1
	if _, err := workerservice.NewWorkers(db).Report(ctx, p, worker, report); err != nil {
		t.Fatal(err)
	}
	input := botcore.CreateBot{ID: uuid.NewString(), Name: "Concurrent", Overrides: model.BotOverrides{WorkerID: &worker, Model: pointer("model-a")}}
	bots.models = modelRequestFunc(func(ctx context.Context, actor model.Principal, id string, r ro.Request) (ro.Message, error) {
		report.Telemetry.AssistantHost.DefaultCwd = "/changed"
		if _, err := workerservice.NewWorkers(db).Report(ctx, p, worker, report); err != nil {
			return ro.Message{}, err
		}
		return nativeResponse(actor, id, r), nil
	})
	_, err := bots.CreateResolved(ctx, p, input)
	requireFault(t, err, "resource_conflict")
	var count int
	if err := db.Pool.QueryRow(ctx, "SELECT count(*) FROM bots WHERE id=$1", input.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("stale create committed: %d %v", count, err)
	}
	// A competing request can commit while this request probes. Its original ID
	// remains authoritative even when this request's probe then fails.
	bots.models = modelRequestFunc(func(ctx context.Context, actor model.Principal, id string, r ro.Request) (ro.Message, error) {
		competing := NewWithNativeDiscovery(db, modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
			return nativeResponse(p, w, r), nil
		}))
		if _, err := competing.CreateResolved(ctx, p, input); err != nil {
			return ro.Message{}, err
		}
		return ro.Message{}, errors.New("discovery connection lost")
	})
	got, err := bots.CreateResolved(ctx, p, input)
	if err != nil || got.ID != input.ID {
		t.Fatalf("lost concurrent committed ID: %+v %v", got, err)
	}
}

func TestNativeCatalogPaginationAndStalePreferenceFallback(t *testing.T) {
	p := model.Principal{UserID: uuid.NewString()}
	worker := uuid.NewString()
	base := model.BotConfiguration{WorkerID: worker, Cwd: "/work", Provider: "codex", Model: pointer("retired"), Args: []string{}, Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "preference", ReasoningEffortSource: "native"}}
	requests := []*string{}
	bots := &Bots{models: modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
		var in ro.ModelInput
		_ = json.Unmarshal(r.Input, &in)
		requests = append(requests, in.Model)
		if in.Model != nil && *in.Model == "retired" {
			return ro.Message{}, nativeFailure("capability_error", "native initialization rejected retired model")
		}
		return nativeResponse(p, w, r), nil
	})}
	got, err := bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, model.BotNativePreference{Model: pointer("retired"), Efforts: map[string]string{"model-a": "retired"}}, base)
	if err != nil || *got.Model != "model-a" || *got.ReasoningEffort != "high" || len(requests) != 1 || requests[0] != nil {
		t.Fatalf("stale fallback: %+v %v %#v", got, err, requests)
	}
	for _, kind := range []string{"catalog", "defaults", "cursor", "identity", "error"} {
		t.Run(kind, func(t *testing.T) {
			calls := 0
			bots.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
				calls++
				message := nativeResponse(p, w, r)
				var catalog ro.ModelResult
				_ = json.Unmarshal(message.Result, &catalog)
				catalog.NextCursor = pointer("next")
				if calls > 1 {
					switch kind {
					case "catalog":
						catalog.CatalogGeneration = uuid.NewString()
					case "defaults":
						catalog.Defaults.ReasoningEffort.Value = pointer("low")
					case "identity":
						message.WorkerID = uuid.NewString()
					case "error":
						message.Result = nil
						message.Error = &ro.Error{Code: "cleanup_unknown", Message: "cleanup unconfirmed"}
						return message, nil
					}
				}
				message.Result, _ = json.Marshal(catalog)
				return message, nil
			})
			_, err := bots.readModels(context.Background(), p, base, nil)
			if err == nil {
				t.Fatal("inconsistent catalog accepted")
			}
		})
	}
}

func TestHistoricalEffortDoesNotBlockNameOnlyUnknownNativeDefault(t *testing.T) {
	p := model.Principal{UserID: uuid.NewString()}
	worker := uuid.NewString()
	base := model.BotConfiguration{WorkerID: worker, Cwd: "/work", Provider: "copilot", Args: []string{}, Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "native"}}
	preference := model.BotNativePreference{Efforts: map[string]string{"model-a": "high"}}
	var observedEffort *string
	observedEffortSource := "unknown"
	bots := &Bots{models: modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
		message := nativeResponse(p, w, r)
		var catalog ro.ModelResult
		_ = json.Unmarshal(message.Result, &catalog)
		catalog.Defaults = ro.ModelDefaults{Model: ro.ModelDefault{Source: "unknown"}, ReasoningEffort: ro.ModelDefault{Value: observedEffort, Source: observedEffortSource}}
		catalog.SelectionError = &ro.Error{Code: "unknown_default", Message: "Native model is unknown"}
		message.Result, _ = json.Marshal(catalog)
		return message, nil
	})}
	got, err := bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	if err != nil || got.Model != nil || got.ReasoningEffort != nil || got.Selection.ModelSource != "native" {
		t.Fatalf("history blocked name-only native delegation: %+v %v", got, err)
	}
	observedEffort = pointer("high")
	observedEffortSource = "local"
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	requireFault(t, err, "unknown_default")
	observedEffort = nil
	observedEffortSource = "unknown"
	retired := base
	retired.Model = pointer("retired")
	selection := *base.Selection
	retired.Selection = &selection
	retired.Selection.ModelSource = "preference"
	preference.Model = pointer("retired")
	got, err = bots.resolveNative(context.Background(), p, retired, model.BotOverrides{}, preference, base)
	if err != nil || got.Model != nil || got.Selection.ModelSource != "native" {
		t.Fatalf("retired model blocked native delegation: %+v %v", got, err)
	}
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{ReasoningEffort: pointer("high")}, preference, base)
	requireFault(t, err, "unknown_default")
	base.ReasoningEffort = pointer("high")
	base.Selection.ReasoningEffortSource = "cloud"
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	requireFault(t, err, "unknown_default")
	bots.models = modelRequestFunc(func(context.Context, model.Principal, string, ro.Request) (ro.Message, error) {
		return ro.Message{}, nativeFailure("cleanup_unknown", "Unconfirmed cleanup")
	})
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	requireFault(t, err, "cleanup_unknown")
}
