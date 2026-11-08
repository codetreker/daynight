package pg

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

// ThreadCredential reads a credential using the lock selected by the transaction.
func ThreadCredential(ctx context.Context, tx pgx.Tx, principal model.Principal, lock string) (store.ThreadCredential, error) {
	var table string
	switch principal.Kind {
	case model.SessionCredential:
		table = "sessions"
	case model.PATCredential:
		table = "personal_access_tokens"
	case model.OAuthCredential:
		table = "oauth_access_tokens"
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
