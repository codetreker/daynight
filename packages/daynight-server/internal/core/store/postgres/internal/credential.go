package pg

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
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
	var ids []scopepolicy.ScopeID
	var version *int64
	columns := "expires_at"
	if principal.Kind == model.PATCredential {
		columns += ", business_scopes, scope_version"
	}
	row := tx.QueryRow(ctx, `SELECT `+columns+` FROM `+table+` WHERE id=$1 AND user_id=$2 AND `+predicate+lock, principal.CredentialID, principal.UserID)
	var err error
	if principal.Kind == model.PATCredential {
		err = row.Scan(&credential.ExpiresAt, &ids, &version)
	} else {
		err = row.Scan(&credential.ExpiresAt)
	}
	if err != nil {
		return store.ThreadCredential{}, QueryError("read thread credential", err)
	}
	if ids != nil || version != nil {
		if ids == nil || version == nil {
			return store.ThreadCredential{}, fmt.Errorf("invalid PAT credential scope policy")
		}
		policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, *version)
		if err != nil {
			return store.ThreadCredential{}, fmt.Errorf("invalid PAT credential scope policy: %w", err)
		}
		credential.ScopePolicy = &policy
	}
	credential.ExpiresAt = UTCTime(credential.ExpiresAt)
	return credential, nil
}

func oauthThreadCredential(ctx context.Context, tx pgx.Tx, principal model.Principal, lock string) (store.ThreadCredential, error) {
	if lock != "" {
		// Revocation and scope edits serialize on the grant before access rows.
		var id string
		err := tx.QueryRow(ctx, `SELECT g.id::text FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id AND a.user_id=g.user_id WHERE a.id=$1 AND a.user_id=$2 FOR SHARE OF g`, principal.CredentialID, principal.UserID).Scan(&id)
		if err != nil {
			return store.ThreadCredential{}, QueryError("lock OAuth credential grant", err)
		}
		if err := tx.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE id=$1 AND user_id=$2 FOR SHARE`, principal.CredentialID, principal.UserID).Scan(&id); err != nil {
			return store.ThreadCredential{}, QueryError("lock OAuth credential access", err)
		}
	}
	var credential store.ThreadCredential
	var profile string
	var ids []scopepolicy.ScopeID
	var version *int64
	err := tx.QueryRow(ctx, `SELECT LEAST(a.expires_at,g.expires_at),g.scope,g.business_scopes,g.scope_version FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id AND g.user_id=a.user_id JOIN users u ON u.id=a.user_id WHERE a.id=$1 AND a.user_id=$2 AND g.revoked_at IS NULL AND LEAST(a.expires_at,g.expires_at)>clock_timestamp()`, principal.CredentialID, principal.UserID).Scan(&credential.ExpiresAt, &profile, &ids, &version)
	if err != nil {
		return store.ThreadCredential{}, QueryError("read thread credential", err)
	}
	if ids != nil || version != nil {
		if profile != "daynight:mcp" || ids == nil || version == nil {
			return store.ThreadCredential{}, fmt.Errorf("invalid OAuth credential scope policy")
		}
		policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, ids, *version)
		if err != nil {
			return store.ThreadCredential{}, fmt.Errorf("invalid OAuth credential scope policy: %w", err)
		}
		credential.ScopePolicy = &policy
	}
	credential.ExpiresAt = UTCTime(credential.ExpiresAt)
	return credential, nil
}
