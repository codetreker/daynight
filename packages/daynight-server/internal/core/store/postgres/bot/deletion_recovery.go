package bot

import (
	"context"
	"encoding/json"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) BotDeletionBinding(ctx context.Context, ownerID, botID string) (sp.Snapshot, error) {
	var raw []byte
	err := s.tx.QueryRow(ctx, `SELECT jsonb_build_object(
 'sessionId',s.snapshot->'sessionId','testExecutionId',s.snapshot->'testExecutionId',
 'executionGeneration',s.snapshot->'executionGeneration','identity',s.snapshot->'identity')
 FROM bots b JOIN task_sessions s ON s.id=b.session_id AND s.bot_id=b.id AND s.owner_user_id=b.owner_user_id
 WHERE b.id=$1 AND b.owner_user_id=$2 AND b.deletion IS NOT NULL AND s.scope='test' AND s.backend='web'`, botID, ownerID).Scan(&raw)
	if err != nil {
		return sp.Snapshot{}, pg.QueryError("read Bot deletion binding", err)
	}
	var snapshot sp.Snapshot
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		return sp.Snapshot{}, pg.QueryError("decode Bot deletion binding", err)
	}
	return snapshot, nil
}
