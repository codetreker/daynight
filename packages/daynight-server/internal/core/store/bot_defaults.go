package store

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

var ErrBotPreferencesNotReady = errors.New("bot preferences require an undeleted ready bot with a bound session")

func (s *Snapshot) BotDefaults(ctx context.Context, ownerID string) (model.BotDefaultsInput, error) {
	return readBotDefaultsInput(ctx, s.tx, ownerID)
}

func (b *BotTx) BotDefaults(ctx context.Context, ownerID string) (model.BotDefaultsInput, error) {
	return readBotDefaultsInput(ctx, b.tx, ownerID)
}

// LockCreation serializes lookup and default resolution for one canonical Bot
// ID, including before its row exists. Hash collisions only serialize unrelated
// requests; the durable Bot ID and fingerprint still determine identity.
func (b *BotTx) LockCreation(ctx context.Context, id string) error {
	if _, err := b.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('bot-create:' || $1, 0))`, id); err != nil {
		return queryError("lock bot creation", err)
	}
	return nil
}

func readBotDefaultsInput(ctx context.Context, tx pgx.Tx, ownerID string) (model.BotDefaultsInput, error) {
	result := model.BotDefaultsInput{Workers: []model.WorkerSnapshot{}, WorkerPreferences: map[string]model.BotWorkerPreference{}}
	if err := tx.QueryRow(ctx, `SELECT (SELECT worker_id::text FROM bot_worker_preferences WHERE user_id=$1)`, ownerID).
		Scan(&result.PreferredWorkerID); err != nil {
		return model.BotDefaultsInput{}, queryError("read bot worker preference", err)
	}
	rows, err := tx.Query(ctx, `SELECT `+workerSnapshotProjection+` FROM workers WHERE user_id=$1 ORDER BY created_at,worker_id`, ownerID)
	if err != nil {
		return model.BotDefaultsInput{}, queryError("read bot default workers", err)
	}
	for rows.Next() {
		worker, err := scanWorkerSnapshot(rows)
		if err != nil {
			rows.Close()
			return model.BotDefaultsInput{}, queryError("read bot default workers", err)
		}
		result.Workers = append(result.Workers, worker)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return model.BotDefaultsInput{}, queryError("read bot default workers", err)
	}
	rows, err = tx.Query(ctx, `SELECT worker_id::text,cwd,provider FROM bot_configuration_preferences WHERE user_id=$1`, ownerID)
	if err != nil {
		return model.BotDefaultsInput{}, queryError("read bot configuration preferences", err)
	}
	defer rows.Close()
	for rows.Next() {
		var workerID string
		var preference model.BotWorkerPreference
		if err := rows.Scan(&workerID, &preference.Cwd, &preference.Provider); err != nil {
			return model.BotDefaultsInput{}, queryError("read bot configuration preferences", err)
		}
		result.WorkerPreferences[workerID] = preference
	}
	if err := rows.Err(); err != nil {
		return model.BotDefaultsInput{}, queryError("read bot configuration preferences", err)
	}
	// This clock evaluates freshness after the observed data is read. In a
	// ReadCommitted creation transaction, a heartbeat may commit between queries;
	// a clock sampled first would incorrectly classify that heartbeat as future.
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&result.ObservedAt); err != nil {
		return model.BotDefaultsInput{}, queryError("read bot default observation", err)
	}
	result.ObservedAt = result.ObservedAt.UTC()
	return result, nil
}

// CommitBotPreferences joins the caller's lifecycle transaction; it never begins
// or commits a transaction. The caller must lock Bot before Session, authenticate
// the bound Worker and verify the current native Session fence and synchronization
// before recording readiness and invoking this function. Readiness alone is not
// native-session proof and this helper is not a public report endpoint.
// Only stored explicit choices participate; each field has its own creation-order
// watermark so a later provider-only choice cannot discard an earlier cwd choice.
func CommitBotPreferences(ctx context.Context, tx pgx.Tx, botID string) error {
	bot, err := readBot(ctx, tx, botID, " FOR UPDATE")
	if err != nil {
		return err
	}
	if bot.Deletion != nil || bot.SessionID == nil || bot.StartupResult.State != "ready" {
		return ErrBotPreferencesNotReady
	}
	if bot.RequestedOverrides.WorkerID != nil {
		_, err := tx.Exec(ctx, `INSERT INTO bot_worker_preferences(user_id,worker_id,creation_order) VALUES($1,$2,$3)
 ON CONFLICT(user_id) DO UPDATE SET worker_id=EXCLUDED.worker_id,creation_order=EXCLUDED.creation_order
 WHERE bot_worker_preferences.creation_order<EXCLUDED.creation_order`, bot.OwnerUserID, bot.WorkerID, bot.CreationOrder)
		if err != nil {
			return queryError("commit bot worker preference", err)
		}
	}
	if bot.RequestedOverrides.Cwd != nil {
		_, err := tx.Exec(ctx, `INSERT INTO bot_configuration_preferences(user_id,worker_id,cwd,cwd_creation_order) VALUES($1,$2,$3,$4)
 ON CONFLICT(user_id,worker_id) DO UPDATE SET cwd=EXCLUDED.cwd,cwd_creation_order=EXCLUDED.cwd_creation_order
 WHERE bot_configuration_preferences.cwd_creation_order IS NULL OR bot_configuration_preferences.cwd_creation_order<EXCLUDED.cwd_creation_order`,
			bot.OwnerUserID, bot.WorkerID, bot.ResolvedConfiguration.Cwd, bot.CreationOrder)
		if err != nil {
			return queryError("commit bot directory preference", err)
		}
	}
	if bot.RequestedOverrides.Provider != nil {
		_, err := tx.Exec(ctx, `INSERT INTO bot_configuration_preferences(user_id,worker_id,provider,provider_creation_order) VALUES($1,$2,$3,$4)
 ON CONFLICT(user_id,worker_id) DO UPDATE SET provider=EXCLUDED.provider,provider_creation_order=EXCLUDED.provider_creation_order
 WHERE bot_configuration_preferences.provider_creation_order IS NULL OR bot_configuration_preferences.provider_creation_order<EXCLUDED.provider_creation_order`,
			bot.OwnerUserID, bot.WorkerID, bot.ResolvedConfiguration.Provider, bot.CreationOrder)
		if err != nil {
			return queryError("commit bot provider preference", err)
		}
	}
	return nil
}
