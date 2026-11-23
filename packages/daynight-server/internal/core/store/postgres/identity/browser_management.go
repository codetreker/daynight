package identity

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.BrowserSessionManagementDAO = (*scope)(nil)

const browserProjection = `id::text,user_id::text,browser,os,created_at,last_used_at,expires_at`

func scanBrowser(row pgx.Row) (model.Session, error) {
	var s model.Session
	err := row.Scan(&s.ID, &s.UserID, &s.Browser, &s.OS, &s.CreatedAt, &s.LastUsedAt, &s.ExpiresAt)
	return s, err
}

func (s *scope) ReadBrowserSession(ctx context.Context, user, id string, now time.Time) (model.Session, error) {
	result, err := scanBrowser(s.tx.QueryRow(ctx, `SELECT `+browserProjection+` FROM sessions WHERE user_id=$1 AND id=$2 AND expires_at>$3`, user, id, now))
	return result, pg.AuthQueryError("read browser session", err)
}

func (s *scope) ListBrowserSessions(ctx context.Context, user, current string, now time.Time, position *store.BrowserSessionPosition, limit int) ([]model.Session, error) {
	query := `SELECT ` + browserProjection + ` FROM sessions WHERE user_id=$1 AND id<>$2 AND expires_at>$3`
	args := []any{user, current, now}
	if position != nil {
		query += ` AND (created_at,id)<($4,$5::uuid)`
		args = append(args, position.CreatedAt, position.ID)
	}
	args = append(args, limit)
	query += ` ORDER BY created_at DESC,id DESC LIMIT $` + fmt.Sprint(len(args))
	rows, err := s.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, pg.AuthQueryError("list browser sessions", err)
	}
	defer rows.Close()
	result := []model.Session{}
	for rows.Next() {
		item, err := scanBrowser(rows)
		if err != nil {
			return nil, pg.AuthQueryError("list browser sessions", err)
		}
		result = append(result, item)
	}
	return result, pg.AuthQueryError("list browser sessions", rows.Err())
}

func (s *scope) LockBrowserSessionID(ctx context.Context, user, id string) (model.Session, error) {
	result, err := scanBrowser(s.tx.QueryRow(ctx, `SELECT `+browserProjection+` FROM sessions WHERE user_id=$1 AND id=$2 FOR UPDATE`, user, id))
	return result, pg.AuthQueryError("lock browser session id", err)
}
func (s *scope) DeleteBrowserSessionID(ctx context.Context, user, id string) error {
	var deleted string
	err := s.tx.QueryRow(ctx, `DELETE FROM sessions WHERE user_id=$1 AND id=$2 RETURNING id::text`, user, id).Scan(&deleted)
	return pg.AuthQueryError("delete browser session id", err)
}
