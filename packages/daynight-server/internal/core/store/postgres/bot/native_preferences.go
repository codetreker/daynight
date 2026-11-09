package bot

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func readNativePreferences(ctx context.Context, tx pgx.Tx, ownerID string, preferences map[string]model.BotWorkerPreference) error {
	return readNativePreferencesQuery(ctx, tx, `SELECT worker_id::text,provider,model,NULL::text FROM bot_model_preferences WHERE user_id=$1
 UNION ALL SELECT worker_id::text,provider,model,reasoning_effort FROM bot_effort_preferences WHERE user_id=$1`, preferences, ownerID)
}

func readNativePreferencesForWorker(ctx context.Context, tx pgx.Tx, ownerID, workerID string, preferences map[string]model.BotWorkerPreference) error {
	return readNativePreferencesQuery(ctx, tx, `SELECT worker_id::text,provider,model,NULL::text FROM bot_model_preferences WHERE user_id=$1 AND worker_id=$2
 UNION ALL SELECT worker_id::text,provider,model,reasoning_effort FROM bot_effort_preferences WHERE user_id=$1 AND worker_id=$2`, preferences, ownerID, workerID)
}

func readNativePreferencesQuery(ctx context.Context, tx pgx.Tx, query string, preferences map[string]model.BotWorkerPreference, args ...any) error {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return pg.QueryError("read bot native preferences", err)
	}
	defer rows.Close()
	for rows.Next() {
		var workerID, provider, selected string
		var effort *string
		if err := rows.Scan(&workerID, &provider, &selected, &effort); err != nil {
			return pg.QueryError("read bot native preference", err)
		}
		preference := preferences[workerID]
		if preference.Native == nil {
			preference.Native = map[string]model.BotNativePreference{}
		}
		native := preference.Native[provider]
		if native.Efforts == nil {
			native.Efforts = map[string]string{}
		}
		if effort == nil {
			native.Model = &selected
		} else {
			native.Efforts[selected] = *effort
		}
		preference.Native[provider] = native
		preferences[workerID] = preference
	}
	if err := rows.Err(); err != nil {
		return pg.QueryError("read bot native preferences", err)
	}
	return nil
}

func commitNativePreferences(ctx context.Context, tx pgx.Tx, bot model.Bot) error {
	configuration := bot.ResolvedConfiguration
	if bot.RequestedOverrides.Model != nil && configuration.Model != nil {
		_, err := tx.Exec(ctx, `INSERT INTO bot_model_preferences(user_id,worker_id,provider,model,creation_order) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(user_id,worker_id,provider) DO UPDATE SET model=EXCLUDED.model,creation_order=EXCLUDED.creation_order
 WHERE bot_model_preferences.creation_order<EXCLUDED.creation_order`, bot.OwnerUserID, bot.WorkerID, configuration.Provider, *configuration.Model, bot.CreationOrder)
		if err != nil {
			return pg.QueryError("commit bot model preference", err)
		}
	}
	if bot.RequestedOverrides.ReasoningEffort != nil && configuration.Model != nil && configuration.ReasoningEffort != nil {
		_, err := tx.Exec(ctx, `INSERT INTO bot_effort_preferences(user_id,worker_id,provider,model,reasoning_effort,creation_order) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(user_id,worker_id,provider,model) DO UPDATE SET reasoning_effort=EXCLUDED.reasoning_effort,creation_order=EXCLUDED.creation_order
 WHERE bot_effort_preferences.creation_order<EXCLUDED.creation_order`, bot.OwnerUserID, bot.WorkerID, configuration.Provider, *configuration.Model, *configuration.ReasoningEffort, bot.CreationOrder)
		if err != nil {
			return pg.QueryError("commit bot reasoning effort preference", err)
		}
	}
	return nil
}
