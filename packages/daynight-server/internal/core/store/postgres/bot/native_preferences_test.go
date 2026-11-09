package bot_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	"github.com/google/uuid"
)

func nativeCandidate(f fixture, selected, effort string, explicitModel, explicitEffort bool) model.Bot {
	candidate := f.candidate
	candidate.ID = uuid.NewString()
	candidate.ResolvedConfiguration.Model = &selected
	candidate.ResolvedConfiguration.ReasoningEffort = &effort
	candidate.ResolvedConfiguration.Selection = &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "explicit"}
	if explicitModel {
		candidate.RequestedOverrides.Model = &selected
	}
	if explicitEffort {
		candidate.RequestedOverrides.ReasoningEffort = &effort
	}
	return candidate
}

func TestNativePreferencesUseIndependentCreationOrderAndOwnerProviderModelScopes(t *testing.T) {
	f := newFixture(t)
	older := f.ready(t, nativeCandidate(f, "model-a", "high", true, true))
	newer := f.ready(t, nativeCandidate(f, "model-b", "low", true, false))
	latestEffort := f.ready(t, nativeCandidate(f, "model-a", "low", false, true))
	for _, bot := range []model.Bot{latestEffort, newer, older, older} {
		if err := f.writer.CommitBotPreferences(t.Context(), bot.ID); err != nil {
			t.Fatal(err)
		}
	}
	for _, read := range []func() (model.BotDefaultsInput, error){
		func() (model.BotDefaultsInput, error) {
			return f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
		},
		func() (model.BotDefaultsInput, error) {
			return f.writer.BotDefaults(t.Context(), f.candidate.OwnerUserID)
		},
	} {
		defaults, err := read()
		if err != nil {
			t.Fatal(err)
		}
		preference := defaults.WorkerPreferences[f.candidate.WorkerID].Native["codex"]
		if preference.Model == nil || *preference.Model != "model-b" || preference.Efforts["model-a"] != "low" || len(preference.Efforts) != 1 {
			t.Fatalf("reverse completion lost field/model boundaries: %+v", preference)
		}
	}
	otherProvider := nativeCandidate(f, "model-a", "high", true, true)
	otherProvider.ResolvedConfiguration.Provider = "claude"
	f.ready(t, otherProvider)
	if err := f.writer.CommitBotPreferences(t.Context(), otherProvider.ID); err != nil {
		t.Fatal(err)
	}
	defaults, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
	if err != nil {
		t.Fatal(err)
	}
	preferences := defaults.WorkerPreferences[f.candidate.WorkerID].Native
	if len(preferences) != 2 || preferences["codex"].Efforts["model-a"] != "low" || preferences["claude"].Efforts["model-a"] != "high" {
		t.Fatalf("Provider preferences crossed: %+v", preferences)
	}
	foreign, err := f.reader.BotDefaults(t.Context(), uuid.NewString())
	if err != nil || len(foreign.WorkerPreferences) != 0 {
		t.Fatalf("foreign owner received preferences: %+v %v", foreign, err)
	}
	implicit := f.ready(t, nativeCandidate(f, "implicit", "high", false, false))
	if err := f.writer.CommitBotPreferences(t.Context(), implicit.ID); err != nil {
		t.Fatal(err)
	}
	defaults, err = f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
	if err != nil {
		t.Fatal(err)
	}
	if *defaults.WorkerPreferences[f.candidate.WorkerID].Native["codex"].Model != "model-b" {
		t.Fatal("implicit defaults became a preference")
	}
	pending := f.insert(t, nativeCandidate(f, "pending", "high", true, true))
	if err := f.writer.CommitBotPreferences(t.Context(), pending.ID); !errors.Is(err, botpg.ErrBotPreferencesNotReady) {
		t.Fatalf("pending choice recorded: %v", err)
	}
}

func TestNativePreferencesJoinLifecycleRollback(t *testing.T) {
	f := newFixture(t)
	current := f.ready(t, nativeCandidate(f, "model-a", "high", true, true))
	exec(t, f.tx, `SAVEPOINT native_preference_write`)
	if err := f.writer.CommitBotPreferences(t.Context(), current.ID); err != nil {
		t.Fatal(err)
	}
	inside, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
	if err != nil || inside.WorkerPreferences[f.candidate.WorkerID].Native["codex"].Efforts["model-a"] != "high" {
		t.Fatalf("transaction did not see its preference: %+v %v", inside, err)
	}
	exec(t, f.tx, `ROLLBACK TO SAVEPOINT native_preference_write`)
	after, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
	if err != nil || len(after.WorkerPreferences) != 0 {
		t.Fatalf("rollback retained native preferences: %+v %v", after, err)
	}
	stored, err := f.reader.Bot(t.Context(), current.ID)
	if err != nil || stored.StartupResult.State != "ready" || stored.ResolvedConfiguration.Model == nil || *stored.ResolvedConfiguration.Model != "model-a" {
		t.Fatalf("preference rollback changed frozen Bot: %+v %v", stored, err)
	}
}

func TestNativePreferenceStorageFailuresRemainObservableAndRollbackTogether(t *testing.T) {
	for _, table := range []string{"bot_model_preferences", "bot_effort_preferences"} {
		t.Run(table, func(t *testing.T) {
			f := newFixture(t)
			current := f.ready(t, nativeCandidate(f, "model-a", "high", true, true))
			exec(t, f.tx, `SAVEPOINT unavailable_native_preferences`)
			exec(t, f.tx, `DROP TABLE `+table)
			if _, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID); err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("unavailable native preferences became an empty result: %v", err)
			}
			exec(t, f.tx, `ROLLBACK TO SAVEPOINT unavailable_native_preferences`)
			exec(t, f.tx, `DROP TABLE `+table)
			if err := f.writer.CommitBotPreferences(t.Context(), current.ID); err == nil || errors.Is(err, model.ErrNotFound) || errors.Is(err, botpg.ErrBotPreferencesNotReady) {
				t.Fatalf("native preference write failure was hidden: %v", err)
			}
			exec(t, f.tx, `ROLLBACK TO SAVEPOINT unavailable_native_preferences`)
			after, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
			if err != nil || len(after.WorkerPreferences) != 0 {
				t.Fatalf("partial model/effort write escaped rollback: %+v %v", after, err)
			}
		})
	}
}
