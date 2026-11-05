package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"time"
)

func cleanupCredentials(ctx context.Context, tx pgx.Tx, now time.Time) error {
	for _, table := range []string{"login_transactions", "sessions", "personal_access_tokens"} {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE id IN (SELECT id FROM `+table+` WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, now); err != nil {
			return err
		}
	}
	return nil
}

func scanUser(row pgx.Row) (model.User, error) {
	var u model.User
	err := row.Scan(&u.ID, &u.UniAuthID, &u.Email, &u.EmailVerified, &u.Name, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

func credentialTable(kind model.CredentialKind) (string, error) {
	switch kind {
	case model.SessionCredential:
		return "sessions", nil
	case model.PATCredential:
		return "personal_access_tokens", nil
	default:
		return "", model.ErrNotFound
	}
}

func authQueryError(phase string, err error) error {
	if err == nil {
		return nil
	}
	return queryError(phase, err)
}
