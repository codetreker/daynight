package identity

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.BrowserSessionDAO = (*scope)(nil)

func (s *scope) SessionTime(ctx context.Context) (time.Time, error) {
	var now time.Time
	err := s.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now)
	return now, pg.AuthQueryError("read browser session time", err)
}

func (s *scope) LockBrowserSession(ctx context.Context, hash []byte, preview bool) (model.Session, time.Time, error) {
	column := "token_hash"
	if preview {
		column = "preview_token_hash"
	}
	var session model.Session
	err := s.tx.QueryRow(ctx, `SELECT id::text,user_id::text,token_hash,preview_token_hash,created_at,last_used_at,expires_at FROM sessions WHERE `+column+`=$1 AND EXISTS(SELECT 1 FROM users WHERE id=user_id) FOR UPDATE`, hash).Scan(&session.ID, &session.UserID, &session.TokenHash, &session.PreviewTokenHash, &session.CreatedAt, &session.LastUsedAt, &session.ExpiresAt)
	if err != nil {
		return model.Session{}, time.Time{}, pg.AuthQueryError("lock browser session", err)
	}
	now, err := s.SessionTime(ctx)
	return session, now, err
}

func (s *scope) TouchBrowserSession(ctx context.Context, id string, lastUsed, expires time.Time) error {
	var updated string
	err := s.tx.QueryRow(ctx, `UPDATE sessions SET last_used_at=$2,expires_at=$3 WHERE id=$1 RETURNING id::text`, id, lastUsed, expires).Scan(&updated)
	return pg.AuthQueryError("touch browser session", err)
}
