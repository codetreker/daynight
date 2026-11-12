// Package oauth implements transaction-bound OAuth credential persistence.
package oauth

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type DAO struct{ tx pgx.Tx }

// NewDAO binds the family DAO to an existing transaction. It neither owns nor
// commits that transaction; other OAuth DAOs can share it in the same scope.
func NewDAO(tx pgx.Tx) *DAO { return &DAO{tx: tx} }

var _ store.CredentialFamilyDAO = (*DAO)(nil)

func (d *DAO) IssueFamily(ctx context.Context, issue store.OAuthFamilyIssue) error {
	g := issue.Grant
	if g.RevokedAt != nil || len(issue.AccessHash) != 32 || len(issue.RefreshHash) != 32 ||
		!g.ExpiresAt.After(g.CreatedAt) || g.ExpiresAt.After(g.CreatedAt.Add(30*24*time.Hour)) ||
		!issue.AccessExpiresAt.After(g.CreatedAt) || issue.AccessExpiresAt.After(g.CreatedAt.Add(time.Hour)) ||
		issue.AccessExpiresAt.After(g.ExpiresAt) {
		return &model.Fault{Code: "invalid_input", Message: "Invalid OAuth credential family input."}
	}
	// All relationships are derived from the grant, not caller-supplied copies.
	_, err := d.tx.Exec(ctx, `INSERT INTO oauth_grants (id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, g.ID, g.UserID, g.ClientID, g.ClientSnapshot, g.Resource, g.Scope, g.CreatedAt, g.ExpiresAt)
	if err != nil {
		return pg.AuthQueryError("insert OAuth grant", err)
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO oauth_access_tokens (id,grant_id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, issue.AccessID, g.ID, g.UserID, issue.AccessHash, g.CreatedAt, issue.AccessExpiresAt)
	if err != nil {
		return pg.AuthQueryError("insert OAuth access", err)
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO oauth_refresh_tokens (token_hash,grant_id,client_id,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, issue.RefreshHash, g.ID, g.ClientID, g.CreatedAt, g.ExpiresAt)
	return pg.AuthQueryError("insert OAuth refresh", err)
}

func (d *DAO) RevokeFamily(ctx context.Context, id string, now time.Time) (bool, error) {
	g, err := d.InspectGrant(ctx, id, true)
	if err != nil {
		return false, err
	}
	changed := g.RevokedAt == nil
	if changed {
		_, err = d.tx.Exec(ctx, `UPDATE oauth_grants SET revoked_at=GREATEST($2::timestamptz,clock_timestamp()) WHERE id=$1`, id, now)
		if err != nil {
			return false, pg.AuthQueryError("revoke OAuth grant", err)
		}
	}
	_, err = d.tx.Exec(ctx, `DELETE FROM oauth_access_tokens WHERE grant_id=$1`, id)
	return changed, pg.AuthQueryError("revoke OAuth access", err)
}

func (d *DAO) AuthenticateAccess(ctx context.Context, hash []byte, resource, scope string, now time.Time) (store.OAuthAccessIdentity, error) {
	out := store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential}}
	err := d.tx.QueryRow(ctx, `SELECT a.id::text,a.user_id::text,g.id::text FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id AND g.user_id=a.user_id JOIN users u ON u.id=a.user_id WHERE a.token_hash=$1 AND g.resource=$2 AND g.scope=$3 AND g.revoked_at IS NULL AND a.expires_at>GREATEST($4::timestamptz,clock_timestamp()) AND g.expires_at>GREATEST($4::timestamptz,clock_timestamp())`, hash, resource, scope, now).Scan(&out.Principal.CredentialID, &out.Principal.UserID, &out.GrantID)
	if err != nil {
		return store.OAuthAccessIdentity{}, pg.AuthQueryError("authenticate OAuth access", err)
	}
	return out, nil
}

func (d *DAO) InspectGrant(ctx context.Context, id string, lock bool) (store.OAuthGrant, error) {
	var g store.OAuthGrant
	q := `SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at FROM oauth_grants WHERE id=$1`
	if lock {
		q += ` FOR UPDATE`
	}
	err := d.tx.QueryRow(ctx, q, id).Scan(&g.ID, &g.UserID, &g.ClientID, &g.ClientSnapshot, &g.Resource, &g.Scope, &g.CreatedAt, &g.ExpiresAt, &g.RevokedAt, &g.LastUsedAt)
	return g, pg.AuthQueryError("inspect OAuth grant", err)
}

func (d *DAO) ActiveClientReferences(ctx context.Context, clientID string, now time.Time) (bool, error) {
	var active bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM oauth_grants WHERE client_id=$1 AND revoked_at IS NULL AND expires_at>GREATEST($2::timestamptz,clock_timestamp()))`, clientID, now).Scan(&active)
	return active, pg.AuthQueryError("read active OAuth client references", err)
}

// LockAccess reauthorizes the persisted actor under shared grant and token locks.
// The grant lock prevents revocation from deleting one token while waiting for
// another admission in the same family. Compatible dispatch readers can join
// the shared grant lock even when revocation is queued behind an admission.
func (d *DAO) LockAccess(ctx context.Context, p model.Principal, resource, scope string, now time.Time) error {
	if p.Kind != model.OAuthCredential {
		return model.ErrNotFound
	}
	var grantID, tokenID string
	if err := d.tx.QueryRow(ctx, `SELECT g.id::text FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id AND a.user_id=g.user_id WHERE a.id=$1 AND a.user_id=$2 FOR SHARE OF g`, p.CredentialID, p.UserID).Scan(&grantID); err != nil {
		return pg.AuthQueryError("lock OAuth access grant", err)
	}
	if err := d.tx.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE id=$1 AND user_id=$2 FOR SHARE`, p.CredentialID, p.UserID).Scan(&tokenID); err != nil {
		return pg.AuthQueryError("lock OAuth access", err)
	}
	var valid bool
	if err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id AND g.user_id=a.user_id WHERE a.id=$1 AND a.user_id=$2 AND g.resource=$3 AND g.scope=$4 AND g.revoked_at IS NULL AND LEAST(a.expires_at,g.expires_at)>GREATEST($5::timestamptz,clock_timestamp()))`, p.CredentialID, p.UserID, resource, scope, now).Scan(&valid); err != nil {
		return pg.AuthQueryError("recheck OAuth access", err)
	}
	if !valid {
		return model.ErrNotFound
	}
	return nil
}
