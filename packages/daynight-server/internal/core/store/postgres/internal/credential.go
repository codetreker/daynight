package pg

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

// ThreadCredential reads a credential using the lock selected by the transaction.
func ThreadCredential(ctx context.Context, tx pgx.Tx, principal model.Principal, lock string) (store.ThreadCredential, error) {
	if principal.Kind == model.OAuthCredential {
		return oauthThreadCredential(ctx, tx, principal, lock)
	}
	var table string
	switch principal.Kind {
	case model.SessionCredential:
		table = "sessions"
	case model.PATCredential:
		table = "personal_access_tokens"
	default:
		return store.ThreadCredential{}, QueryError("read thread credential", model.ErrNotFound)
	}
	predicate := "expires_at > clock_timestamp()"
	if principal.Kind == model.PATCredential {
		predicate = "(expires_at IS NULL OR expires_at > clock_timestamp())"
	}
	var credential store.ThreadCredential
	err := tx.QueryRow(ctx, `SELECT expires_at FROM `+table+` WHERE id=$1 AND user_id=$2 AND `+predicate+lock,
		principal.CredentialID, principal.UserID).Scan(&credential.ExpiresAt)
	if err != nil {
		return store.ThreadCredential{}, QueryError("read thread credential", err)
	}
	credential.ExpiresAt = UTCTime(credential.ExpiresAt)
	return credential, nil
}

func oauthThreadCredential(ctx context.Context, tx pgx.Tx, principal model.Principal, lock string) (store.ThreadCredential, error) {
	if lock != "" {
		lock += " OF a"
	}
	var credential store.ThreadCredential
	err := tx.QueryRow(ctx, `SELECT LEAST(a.expires_at,g.expires_at) FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id AND g.user_id=a.user_id JOIN users u ON u.id=a.user_id WHERE a.id=$1 AND a.user_id=$2 AND g.revoked_at IS NULL AND LEAST(a.expires_at,g.expires_at)>clock_timestamp()`+lock, principal.CredentialID, principal.UserID).Scan(&credential.ExpiresAt)
	if err != nil {
		return store.ThreadCredential{}, QueryError("read thread credential", err)
	}
	credential.ExpiresAt = UTCTime(credential.ExpiresAt)
	return credential, nil
}
