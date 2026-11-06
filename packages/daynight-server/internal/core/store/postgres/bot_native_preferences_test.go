package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
)

func TestBotNativePreferencesRemainIndependentUnderReverseCompletion(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	create := func(selected, effort string, explicitModel, explicitEffort bool) model.Bot {
		t.Helper()
		candidate.ResolvedConfiguration.Model = botPreferenceText(selected)
		candidate.ResolvedConfiguration.ReasoningEffort = botPreferenceText(effort)
		candidate.ResolvedConfiguration.Selection = &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "explicit"}
		overrides := model.BotOverrides{}
		if explicitModel {
			overrides.Model = botPreferenceText(selected)
		}
		if explicitEffort {
			overrides.ReasoningEffort = botPreferenceText(effort)
		}
		return insertPreferenceBot(t, database, candidate, overrides)
	}
	older := create("model-a", "high", true, true)
	newer := create("model-b", "low", true, false)
	latestEffort := create("model-a", "low", false, true)
	for _, bot := range []model.Bot{latestEffort, newer, older} {
		markPreferenceBotReady(t, database, bot.ID)
		commitPreferenceBot(t, database, bot.ID)
	}
	input := readBotDefaults(t, database, candidate.OwnerUserID)
	preference := input.WorkerPreferences[candidate.WorkerID].Native[candidate.ResolvedConfiguration.Provider]
	if preference.Model == nil || *preference.Model != "model-b" || preference.Efforts["model-a"] != "low" || len(preference.Efforts) != 1 {
		t.Fatalf("field order corrupted preference: %+v", preference)
	}
	implicit := create("implicit", "high", false, false)
	markPreferenceBotReady(t, database, implicit.ID)
	commitPreferenceBot(t, database, implicit.ID)
	for _, state := range []string{"pending", "failed"} {
		bot := create("unsuccessful", "high", true, true)
		if state == "failed" {
			mustQueryExec(t, database, `UPDATE bots SET startup_result='{"state":"failed","code":"invalid_cwd"}' WHERE id=$1`, bot.ID)
		}
		err := writeBotTest(database, context.Background(), func(tx BotWriteDAO) error { return tx.CommitBotPreferences(context.Background(), bot.ID) })
		if !errors.Is(err, botpg.ErrBotPreferencesNotReady) {
			t.Fatalf("remembered %s: %v", state, err)
		}
	}
	input = readBotDefaults(t, database, candidate.OwnerUserID)
	preference = input.WorkerPreferences[candidate.WorkerID].Native[candidate.ResolvedConfiguration.Provider]
	if *preference.Model != "model-b" || len(preference.Efforts) != 1 {
		t.Fatalf("implicit/failed polluted preference: %+v", preference)
	}
}

func TestBotNativePreferencesRollbackAndLegacyRecords(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	legacy := insertPreferenceBot(t, database, candidate, model.BotOverrides{})
	var stored string
	if err := database.Pool.QueryRow(context.Background(), `SELECT resolved_configuration::text FROM bots WHERE id=$1`, legacy.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	candidate.ResolvedConfiguration.Model = botPreferenceText("model-a")
	candidate.ResolvedConfiguration.ReasoningEffort = botPreferenceText("high")
	candidate.ResolvedConfiguration.Selection = &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "explicit"}
	bot := insertPreferenceBot(t, database, candidate, model.BotOverrides{Model: botPreferenceText("model-a"), ReasoningEffort: botPreferenceText("high")})
	markPreferenceBotReady(t, database, bot.ID)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := botpg.NewWriter(tx).CommitBotPreferences(ctx, bot.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if len(readBotDefaults(t, database, candidate.OwnerUserID).WorkerPreferences) != 0 {
		t.Fatal("rolled back preferences escaped transaction")
	}
	var after string
	if err := database.Pool.QueryRow(ctx, `SELECT resolved_configuration::text FROM bots WHERE id=$1`, legacy.ID).Scan(&after); err != nil || after != stored {
		t.Fatalf("legacy snapshot changed: %s %v", after, err)
	}
	var version int
	if err := database.Pool.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&version); err != nil || version < 44 {
		t.Fatalf("missing native preference migration: %d %v", version, err)
	}
}
