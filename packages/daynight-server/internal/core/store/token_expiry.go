package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func scanPAT(row pgx.Row) (core.PersonalAccessToken, error) {
	var c core.PersonalAccessToken
	err := row.Scan(&c.ID, &c.UserID, &c.Name, &c.CreatedAt, &c.ExpiresAt)
	c.CreatedAt = c.CreatedAt.UTC()
	if c.ExpiresAt != nil {
		expiry := c.ExpiresAt.UTC()
		c.ExpiresAt = &expiry
	}
	return c, err
}

const patFields = `id::text,user_id::text,name,created_at,expires_at`

func equalTokenExpiry(first, second *time.Time) bool {
	if first == nil || second == nil {
		return first == nil && second == nil
	}
	return first.Equal(*second)
}

func (s *Store) UpdatePATExpiry(ctx context.Context, p core.Principal, id string, expiry, expected *time.Time, now time.Time) (core.PersonalAccessToken, bool, error) {
	var result core.PersonalAccessToken
	conflict := false
	err := s.withSession(ctx, p, now, func(tx pgx.Tx) error {
		current, err := scanPAT(tx.QueryRow(ctx, `SELECT `+patFields+` FROM personal_access_tokens WHERE id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>$3) FOR UPDATE`, id, p.UserID, now))
		if err != nil {
			return err
		}
		if !equalTokenExpiry(current.ExpiresAt, expected) {
			conflict = true
			return nil
		}
		if equalTokenExpiry(current.ExpiresAt, expiry) {
			result = current
			return nil
		}
		result, err = scanPAT(tx.QueryRow(ctx, `UPDATE personal_access_tokens SET expires_at=$2 WHERE id=$1 RETURNING `+patFields, id, expiry))
		return err
	})
	return result, conflict, err
}
