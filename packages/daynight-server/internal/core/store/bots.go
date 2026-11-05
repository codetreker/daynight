package store

import (
	"context"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

type BotTx struct{ tx pgx.Tx }

type BotPage struct {
	Items   []model.Bot
	HasMore bool
}

// WriteBot serializes existing definitions by their Bot row. Callers must lock
// this row before a related Session or archive record in the same transaction.
func (s *Store) WriteBot(ctx context.Context, operation func(*BotTx) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return queryError("begin bot", err)
	}
	if err := transact(ctx, tx, func(tx pgx.Tx) error { return operation(&BotTx{tx: tx}) }); err != nil {
		return queryError("write bot", err)
	}
	return nil
}

func (b *BotTx) Credential(ctx context.Context, principal model.Principal) error {
	_, err := threadCredential(ctx, b.tx, principal, " FOR SHARE")
	return err
}

func botWorker(ctx context.Context, tx pgx.Tx, ownerID, workerID, lock string) error {
	var found string
	if err := tx.QueryRow(ctx, `SELECT worker_id::text FROM workers WHERE user_id=$1 AND worker_id=$2`+lock, ownerID, workerID).Scan(&found); err != nil {
		return queryError("read bot worker", err)
	}
	return nil
}

func (b *BotTx) Worker(ctx context.Context, ownerID, workerID string) error {
	return botWorker(ctx, b.tx, ownerID, workerID, " FOR KEY SHARE")
}

func (s *Snapshot) BotWorker(ctx context.Context, ownerID, workerID string) error {
	return botWorker(ctx, s.tx, ownerID, workerID, "")
}

const botProjection = `id::text,owner_user_id::text,worker_id::text,name,version,creation_order,request_fingerprint,
 requested_overrides,resolved_configuration,role_configuration,session_id::text,startup_result,deletion,created_at,updated_at,
 (SELECT bound.test_execution_id::text FROM task_sessions bound WHERE bound.id=bots.session_id AND bound.bot_id=bots.id)`

func scanBot(row pgx.Row) (model.Bot, error) {
	var bot model.Bot
	var overrides, configuration, role, startup, deletion []byte
	if err := row.Scan(&bot.ID, &bot.OwnerUserID, &bot.WorkerID, &bot.Name, &bot.Version, &bot.CreationOrder, &bot.RequestFingerprint,
		&overrides, &configuration, &role, &bot.SessionID, &startup, &deletion, &bot.CreatedAt, &bot.UpdatedAt, &bot.TestExecutionID); err != nil {
		return model.Bot{}, err
	}
	for _, field := range []struct {
		raw    []byte
		target any
	}{
		{overrides, &bot.RequestedOverrides}, {configuration, &bot.ResolvedConfiguration},
		{startup, &bot.StartupResult}, {role, &bot.RoleConfiguration}, {deletion, &bot.Deletion},
	} {
		if field.raw != nil {
			if err := json.Unmarshal(field.raw, field.target); err != nil {
				return model.Bot{}, err
			}
		}
	}
	bot.CreatedAt, bot.UpdatedAt = bot.CreatedAt.UTC(), bot.UpdatedAt.UTC()
	return bot, nil
}

func readBot(ctx context.Context, tx pgx.Tx, id, lock string) (model.Bot, error) {
	if lock != "" {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM bots WHERE id=$1`+lock, id).Scan(&locked); err != nil {
			return model.Bot{}, queryError("lock bot", err)
		}
	}
	// A lock wait can observe a newly committed Bot row while a subquery keeps
	// the statement's earlier snapshot. Read the association in a new statement
	// after acquiring the row lock so both identities describe the same binding.
	bot, err := scanBot(tx.QueryRow(ctx, `SELECT `+botProjection+` FROM bots WHERE id=$1`, id))
	if err != nil {
		return model.Bot{}, queryError("read bot", err)
	}
	return bot, nil
}

func (b *BotTx) Bot(ctx context.Context, id string) (model.Bot, error) {
	return readBot(ctx, b.tx, id, " FOR UPDATE")
}

func (s *Snapshot) Bot(ctx context.Context, id string) (model.Bot, error) {
	return readBot(ctx, s.tx, id, "")
}

// InsertBot leaves a conflicting identity untouched. Read the row in a separate
// ReadCommitted statement to observe a concurrent creator's committed result.
func (b *BotTx) InsertBot(ctx context.Context, bot model.Bot) error {
	overrides, err := json.Marshal(bot.RequestedOverrides)
	if err != nil {
		return queryError("encode bot overrides", err)
	}
	configuration, err := json.Marshal(bot.ResolvedConfiguration)
	if err != nil {
		return queryError("encode bot configuration", err)
	}
	_, err = b.tx.Exec(ctx, `INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result)
 VALUES($1,$2,$3,$4,$5,$6,$7,'{"state":"pending","code":null}') ON CONFLICT(id) DO NOTHING`,
		bot.ID, bot.OwnerUserID, bot.WorkerID, bot.Name, bot.RequestFingerprint, overrides, configuration)
	if err != nil {
		return queryError("insert bot", err)
	}
	return nil
}

func (b *BotTx) DeleteBot(ctx context.Context, id string, version int64, deletion model.BotDeletion) (model.Bot, error) {
	data, err := json.Marshal(deletion)
	if err != nil {
		return model.Bot{}, queryError("encode bot deletion", err)
	}
	bot, err := scanBot(b.tx.QueryRow(ctx, `UPDATE bots SET deletion=$3,version=version+1,updated_at=statement_timestamp()
 WHERE id=$1 AND version=$2 AND deletion IS NULL RETURNING `+botProjection, id, version, data))
	if err != nil {
		return model.Bot{}, queryError("record bot deletion", err)
	}
	return bot, nil
}

// Bots includes pending cleanup only for a specific Worker's expected inventory.
func (s *Snapshot) Bots(ctx context.Context, ownerID string, workerID *string, page Page) (BotPage, error) {
	afterTime, afterID := pageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+botProjection+` FROM bots WHERE owner_user_id=$1
 AND (($2::uuid IS NULL AND deletion IS NULL) OR (worker_id=$2 AND (deletion IS NULL OR deletion->'workerCleanup'->>'state'<>'completed' OR deletion->'serverCleanup'->>'state'<>'completed')))
 AND ($3::timestamptz IS NULL OR (created_at,id)>($3,$4::uuid)) ORDER BY created_at,id LIMIT $5`, ownerID, workerID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return BotPage{}, queryError("list bots", err)
	}
	defer rows.Close()
	items := make([]model.Bot, 0, page.Limit+1)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return BotPage{}, queryError("list bots", err)
		}
		item, err := scanBot(rows)
		if err != nil {
			return BotPage{}, queryError("list bots", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return BotPage{}, queryError("list bots", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return BotPage{Items: items, HasMore: hasMore}, nil
}
