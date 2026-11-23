package bot

import (
	"context"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) BotDeletionRecoveries(ctx context.Context, ownerID string, page store.Page) (store.BotPage, error) {
	afterTime, afterID := pg.PageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT b.id::text,b.owner_user_id::text,b.worker_id::text,b.version,
 b.session_id::text,s.test_execution_id::text,b.deletion,b.created_at,r.worker_id::text
 FROM bots b LEFT JOIN task_sessions s ON s.id=b.session_id AND s.bot_id=b.id AND s.owner_user_id=b.owner_user_id
 LEFT JOIN bot_recovery r ON r.bot_id=b.id
 WHERE b.owner_user_id=$1 AND b.deletion IS NOT NULL
 AND ((b.deletion->'workerCleanup'->>'state'='failed' AND b.deletion->'workerCleanup'->>'code'='execution_evidence_missing'
       AND b.deletion->'serverCleanup'->>'state'<>'completed')
      OR (b.deletion->'recovery' IS NOT NULL AND b.deletion->'recovery'<>'null'::jsonb))
 AND ($2::timestamptz IS NULL OR (b.created_at,b.id)>($2,$3::uuid))
 ORDER BY b.created_at,b.id LIMIT $4`, ownerID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.BotPage{}, pg.QueryError("list Bot deletion recoveries", err)
	}
	defer rows.Close()
	items := make([]model.Bot, 0, page.Limit+1)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return store.BotPage{}, pg.QueryError("list Bot deletion recoveries", err)
		}
		var bot model.Bot
		var raw []byte
		var recoveryWorker *string
		if err := rows.Scan(&bot.ID, &bot.OwnerUserID, &bot.WorkerID, &bot.Version, &bot.SessionID, &bot.TestExecutionID, &raw, &bot.CreatedAt, &recoveryWorker); err != nil {
			return store.BotPage{}, pg.QueryError("read Bot deletion recovery", err)
		}
		if err := json.Unmarshal(raw, &bot.Deletion); err != nil {
			return store.BotPage{}, pg.QueryError("decode Bot deletion recovery", err)
		}
		if recoveryWorker != nil {
			bot.Recovery = &model.BotRecovery{WorkerID: *recoveryWorker}
		}
		items = append(items, bot)
	}
	if err := rows.Err(); err != nil {
		return store.BotPage{}, pg.QueryError("list Bot deletion recoveries", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return store.BotPage{Items: items, HasMore: hasMore}, nil
}
