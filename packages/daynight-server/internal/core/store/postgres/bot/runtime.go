package bot

import (
	"context"
	"encoding/json"
	"math"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// BindBotSession freezes the first role and Session reference atomically. The
// Session must already have been inserted with this Bot's ownership in the same
// transaction. Exact registration replay is decided by the lifecycle caller.
func (b *Writer) BindBotSession(ctx context.Context, id string, version int64, sessionID string, role model.BotRoleConfiguration) (model.Bot, error) {
	tx := b.tx
	data, err := json.Marshal(role)
	if err != nil {
		return model.Bot{}, pg.QueryError("encode bot role", err)
	}
	bot, err := scanBot(tx.QueryRow(ctx, `UPDATE bots SET session_id=$3,role_configuration=$4,version=version+1,updated_at=statement_timestamp()
 WHERE id=$1 AND version=$2 AND version<$5 AND deletion IS NULL AND session_id IS NULL AND role_configuration IS NULL
 AND EXISTS(SELECT 1 FROM task_sessions bound WHERE bound.id=$3 AND bound.bot_id=bots.id AND bound.owner_user_id=bots.owner_user_id AND bound.scope='test' AND bound.backend='web')
 RETURNING `+botProjection, id, version, sessionID, data, int64(math.MaxInt64)))
	if err != nil {
		return model.Bot{}, pg.QueryError("bind bot session", err)
	}
	return bot, nil
}

// SetBotStartup stores an authenticated lifecycle result. The caller verifies
// the current fence and live synchronization before readiness, then commits any
// successful explicit preferences in this same transaction.
func (b *Writer) SetBotStartup(ctx context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
	tx := b.tx
	data, err := json.Marshal(result)
	if err != nil {
		return model.Bot{}, pg.QueryError("encode bot startup", err)
	}
	bot, err := scanBot(tx.QueryRow(ctx, `UPDATE bots SET startup_result=$3,version=version+1,updated_at=statement_timestamp()
 WHERE id=$1 AND version=$2 AND version<$4 AND deletion IS NULL
 AND ($3::jsonb->>'state'<>'ready' OR (session_id IS NOT NULL AND role_configuration IS NOT NULL))
 RETURNING `+botProjection, id, version, data, int64(math.MaxInt64)))
	if err != nil {
		return model.Bot{}, pg.QueryError("set bot startup", err)
	}
	return bot, nil
}
