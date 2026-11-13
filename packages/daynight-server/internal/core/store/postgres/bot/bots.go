package bot

import (
	"context"
	"encoding/json"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

// Reader and Writer bind Bot operations to the caller's transaction.
type Reader struct{ tx pgx.Tx }
type Writer struct{ tx pgx.Tx }

func NewReader(tx pgx.Tx) store.BotReader   { return &Reader{tx: tx} }
func NewWriter(tx pgx.Tx) *Writer           { return &Writer{tx: tx} }
func (b *Writer) BotDAO() store.BotWriteDAO { return b }

var _ store.BotReader = (*Reader)(nil)
var _ store.BotScope = (*Writer)(nil)
var _ store.BotWriteDAO = (*Writer)(nil)

func (b *Writer) Credential(ctx context.Context, principal model.Principal) error {
	_, err := pg.ThreadCredential(ctx, b.tx, principal, " FOR SHARE")
	return err
}

func botWorker(ctx context.Context, tx pgx.Tx, ownerID, workerID, lock string) error {
	var found string
	if err := tx.QueryRow(ctx, `SELECT worker_id::text FROM workers WHERE user_id=$1 AND worker_id=$2`+lock, ownerID, workerID).Scan(&found); err != nil {
		return pg.QueryError("read bot worker", err)
	}
	return nil
}

func (b *Writer) Worker(ctx context.Context, ownerID, workerID string) error {
	return botWorker(ctx, b.tx, ownerID, workerID, " FOR KEY SHARE")
}

func (s *Reader) BotWorker(ctx context.Context, ownerID, workerID string) error {
	return botWorker(ctx, s.tx, ownerID, workerID, "")
}

const botProjection = `id::text,owner_user_id::text,worker_id::text,name,version,creation_order,request_fingerprint,
 requested_overrides,resolved_configuration,role_configuration,session_id::text,startup_result,deletion,created_at,updated_at,
 (SELECT bound.test_execution_id::text FROM task_sessions bound WHERE bound.id=bots.session_id AND bound.bot_id=bots.id),
 (SELECT count(*) FROM assistant_task_events e WHERE e.owner_user_id=bots.owner_user_id
  AND e.target_bot_id=bots.id AND e.attention AND e.seen_at IS NULL AND e.type<>'proposal_pending') +
 (SELECT count(*) FROM assistant_task_proposals p JOIN assistant_tasks t ON t.id=p.task_id AND t.owner_user_id=p.owner_user_id
  WHERE t.owner_user_id=bots.owner_user_id AND t.holder_bot_id=bots.id AND t.state<>'deleted' AND p.status='pending')`

func scanBot(row pgx.Row) (model.Bot, error) {
	var bot model.Bot
	var overrides, configuration, role, startup, deletion []byte
	if err := row.Scan(&bot.ID, &bot.OwnerUserID, &bot.WorkerID, &bot.Name, &bot.Version, &bot.CreationOrder, &bot.RequestFingerprint,
		&overrides, &configuration, &role, &bot.SessionID, &startup, &deletion, &bot.CreatedAt, &bot.UpdatedAt, &bot.TestExecutionID, &bot.AttentionCount); err != nil {
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
			return model.Bot{}, pg.QueryError("lock bot", err)
		}
	}
	// A lock wait can observe a newly committed Bot row while a subquery keeps
	// the statement's earlier snapshot. Read the association in a new statement
	// after acquiring the row lock so both identities describe the same binding.
	bot, err := scanBot(tx.QueryRow(ctx, `SELECT `+botProjection+` FROM bots WHERE id=$1`, id))
	if err != nil {
		return model.Bot{}, pg.QueryError("read bot", err)
	}
	return bot, nil
}

func (b *Writer) Bot(ctx context.Context, id string) (model.Bot, error) {
	return readBot(ctx, b.tx, id, " FOR UPDATE")
}

func (s *Reader) Bot(ctx context.Context, id string) (model.Bot, error) {
	return readBot(ctx, s.tx, id, "")
}

// InsertBot leaves a conflicting identity untouched. Read the row in a separate
// ReadCommitted statement to observe a concurrent creator's committed result.
func (b *Writer) InsertBot(ctx context.Context, bot model.Bot) error {
	overrides, err := json.Marshal(bot.RequestedOverrides)
	if err != nil {
		return pg.QueryError("encode bot overrides", err)
	}
	configuration, err := json.Marshal(bot.ResolvedConfiguration)
	if err != nil {
		return pg.QueryError("encode bot configuration", err)
	}
	_, err = b.tx.Exec(ctx, `INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result)
 VALUES($1,$2,$3,$4,$5,$6,$7,'{"state":"pending","code":null}') ON CONFLICT(id) DO NOTHING`,
		bot.ID, bot.OwnerUserID, bot.WorkerID, bot.Name, bot.RequestFingerprint, overrides, configuration)
	if err != nil {
		return pg.QueryError("insert bot", err)
	}
	return nil
}

// SaveBotDeletion advances the deletion state while the caller holds the Bot
// lock, including the cleanup receipt and obligations in the caller's transaction.
func (b *Writer) SaveBotDeletion(ctx context.Context, id string, deletion *model.BotDeletion) (model.Bot, error) {
	data, err := json.Marshal(deletion)
	if err != nil {
		return model.Bot{}, err
	}
	if _, err := b.tx.Exec(ctx, `UPDATE bots SET deletion=$2,version=version+1,updated_at=statement_timestamp() WHERE id=$1`, id, data); err != nil {
		return model.Bot{}, pg.QueryError("save bot deletion", err)
	}
	return b.Bot(ctx, id)
}

// Bots includes pending cleanup only for a specific Worker's expected inventory.
func (s *Reader) Bots(ctx context.Context, ownerID string, workerID *string, page store.Page) (store.BotPage, error) {
	afterTime, afterID := pg.PageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+botProjection+` FROM bots WHERE owner_user_id=$1
 AND (($2::uuid IS NULL AND deletion IS NULL) OR (worker_id=$2 AND (deletion IS NULL OR deletion->'workerCleanup'->>'state'<>'completed' OR deletion->'serverCleanup'->>'state'<>'completed')))
 AND ($3::timestamptz IS NULL OR (created_at,id)>($3,$4::uuid)) ORDER BY created_at,id LIMIT $5`, ownerID, workerID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.BotPage{}, pg.QueryError("list bots", err)
	}
	defer rows.Close()
	items := make([]model.Bot, 0, page.Limit+1)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return store.BotPage{}, pg.QueryError("list bots", err)
		}
		item, err := scanBot(rows)
		if err != nil {
			return store.BotPage{}, pg.QueryError("list bots", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return store.BotPage{}, pg.QueryError("list bots", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return store.BotPage{Items: items, HasMore: hasMore}, nil
}
