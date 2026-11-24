package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var _ store.BotHistoryWindowDAO = (*DAO)(nil)
var _ store.BotHistoryReclaimInventoryDAO = (*DAO)(nil)

func (tx *DAO) BotHistoryCheckpoint(ctx context.Context, id string) ([]byte, error) {
	var data []byte
	err := tx.tx.QueryRow(ctx, `SELECT checkpoint FROM bot_history_windows WHERE session_id=$1`, id).Scan(&data)
	return data, mediaQueryError("read Bot history checkpoint", err)
}

func (tx *DAO) SaveBotHistoryCheckpoint(ctx context.Context, id string, data []byte) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO bot_history_windows(session_id,checkpoint) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET checkpoint=EXCLUDED.checkpoint`, id, data)
	return mediaQueryError("save Bot history checkpoint", err)
}

func (tx *DAO) SessionResourceReferences(ctx context.Context, id, kind string) ([]store.SessionResourceReference, error) {
	rows, err := tx.tx.Query(ctx, `SELECT resource_id::text,reference_id FROM session_resource_references WHERE session_id=$1 AND kind=$2 ORDER BY resource_id,reference_id`, id, kind)
	if err != nil {
		return nil, mediaQueryError("read Session resource references", err)
	}
	defer rows.Close()
	out := []store.SessionResourceReference{}
	for rows.Next() {
		r := store.SessionResourceReference{SessionID: id, Kind: kind}
		if err = rows.Scan(&r.ResourceID, &r.ReferenceID); err != nil {
			return nil, mediaQueryError("scan Session resource reference", err)
		}
		out = append(out, r)
	}
	return out, mediaQueryError("read Session resource references", rows.Err())
}

func (tx *DAO) QueueBotHistoryReclaim(ctx context.Context, id, resource string) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO bot_history_reclaims(session_id,resource_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, id, resource)
	return mediaQueryError("retain Bot resource reclamation", err)
}

func (tx *DAO) PendingBotHistoryReclaims(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT resource_id::text FROM bot_history_reclaims WHERE session_id=$1 ORDER BY resource_id`, id)
	if err != nil {
		return nil, mediaQueryError("read Bot resource reclamation", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var resource string
		if err = rows.Scan(&resource); err != nil {
			return nil, mediaQueryError("scan Bot resource reclamation", err)
		}
		out = append(out, resource)
	}
	return out, mediaQueryError("read Bot resource reclamation", rows.Err())
}

func (tx *DAO) CompleteBotHistoryReclaim(ctx context.Context, id, resource string) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM bot_history_reclaims WHERE session_id=$1 AND resource_id=$2`, id, resource)
	return mediaQueryError("complete Bot resource reclamation", err)
}

func (tx *DAO) BotHistoryReclaimSessions(ctx context.Context, after string, limit int) ([]string, error) {
	if limit < 1 || limit > 100 {
		return nil, errors.New("Bot resource reclamation limit must be between 1 and 100")
	}
	var cursor any
	if after != "" {
		cursor = after
	}
	rows, err := tx.tx.Query(ctx, `SELECT DISTINCT session_id::text FROM bot_history_reclaims WHERE ($1::uuid IS NULL OR session_id>$1::uuid) ORDER BY session_id LIMIT $2`, cursor, limit)
	if err != nil {
		return nil, mediaQueryError("list Bot resource reclamation Sessions", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, mediaQueryError("scan Bot resource reclamation Session", err)
		}
		out = append(out, id)
	}
	return out, mediaQueryError("list Bot resource reclamation Sessions", rows.Err())
}
