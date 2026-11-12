package oauth

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.GrantLifecycleDAO = (*DAO)(nil)

func (d *DAO) LockOwnerSession(ctx context.Context, principal model.Principal, now time.Time) error {
	return identity.NewScope(d.tx).IdentityDAO().LockSession(ctx, principal, now)
}

func (d *DAO) Refresh(ctx context.Context, hash []byte, lock bool) (store.OAuthRefresh, error) {
	var r store.OAuthRefresh
	q := `SELECT grant_id::text,client_id,expires_at,consumed_at FROM oauth_refresh_tokens WHERE token_hash=$1`
	if lock {
		q += ` FOR UPDATE`
	}
	err := d.tx.QueryRow(ctx, q, hash).Scan(&r.GrantID, &r.ClientID, &r.ExpiresAt, &r.ConsumedAt)
	return r, pg.AuthQueryError("read OAuth refresh", err)
}
func (d *DAO) AccessGrant(ctx context.Context, hash []byte) (string, error) {
	var id string
	err := d.tx.QueryRow(ctx, `SELECT grant_id::text FROM oauth_access_tokens WHERE token_hash=$1`, hash).Scan(&id)
	return id, pg.AuthQueryError("read OAuth access grant", err)
}
func (d *DAO) RotateRefresh(ctx context.Context, r store.OAuthRotation) error {
	_, err := d.tx.Exec(ctx, `UPDATE oauth_refresh_tokens SET consumed_at=$2,replaced_by_hash=$3 WHERE token_hash=$1`, r.OldHash, r.CreatedAt, r.RefreshHash)
	if err != nil {
		return pg.AuthQueryError("consume OAuth refresh", err)
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO oauth_access_tokens (id,grant_id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, r.AccessID, r.Grant.ID, r.Grant.UserID, r.AccessHash, r.CreatedAt, r.AccessExpiresAt)
	if err != nil {
		return pg.AuthQueryError("insert OAuth rotated access", err)
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO oauth_refresh_tokens (token_hash,grant_id,client_id,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, r.RefreshHash, r.Grant.ID, r.Grant.ClientID, r.CreatedAt, r.Grant.ExpiresAt)
	return pg.AuthQueryError("insert OAuth rotated refresh", err)
}
func (d *DAO) OwnerGrants(ctx context.Context, user string) ([]store.OAuthGrant, error) {
	rows, err := d.tx.Query(ctx, `SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at FROM oauth_grants WHERE user_id=$1 ORDER BY created_at DESC,id DESC`, user)
	if err != nil {
		return nil, pg.AuthQueryError("list OAuth grants", err)
	}
	defer rows.Close()
	grants := make([]store.OAuthGrant, 0)
	for rows.Next() {
		var g store.OAuthGrant
		if err := rows.Scan(&g.ID, &g.UserID, &g.ClientID, &g.ClientSnapshot, &g.Resource, &g.Scope, &g.CreatedAt, &g.ExpiresAt, &g.RevokedAt, &g.LastUsedAt); err != nil {
			return nil, pg.AuthQueryError("scan OAuth grants", err)
		}
		grants = append(grants, g)
	}
	return grants, pg.AuthQueryError("list OAuth grants", rows.Err())
}

// Each statement consumes only the remaining batch allowance. Access and refresh
// rows are independent of grant locks once expired; grant metadata is retained
// for 30 days after its terminal time.
func (d *DAO) PruneCredentials(ctx context.Context, now time.Time, limit int) (int, error) {
	total := 0
	queries := []string{
		`DELETE FROM oauth_access_tokens WHERE id IN (SELECT id FROM oauth_access_tokens WHERE expires_at<=GREATEST($1::timestamptz,clock_timestamp()) ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
		`DELETE FROM oauth_refresh_tokens WHERE token_hash IN (SELECT token_hash FROM oauth_refresh_tokens WHERE expires_at<=GREATEST($1::timestamptz,clock_timestamp()) ORDER BY expires_at,token_hash LIMIT $2 FOR UPDATE SKIP LOCKED)`,
		`DELETE FROM oauth_grants WHERE id IN (SELECT id FROM oauth_grants WHERE LEAST(expires_at,COALESCE(revoked_at,expires_at)) + interval '720 hours'<=GREATEST($1::timestamptz,clock_timestamp()) ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
	}
	if limit <= 0 {
		return 0, nil
	}
	// Persist the starting class so even one-row batches remain fair after a
	// restart or when multiple instances share maintenance responsibility.
	var start int
	if err := d.tx.QueryRow(ctx, `SELECT next_kind FROM oauth_credential_cleanup_cursor WHERE singleton=true FOR UPDATE`).Scan(&start); err != nil {
		return 0, pg.AuthQueryError("read OAuth cleanup cursor", err)
	}
	if _, err := d.tx.Exec(ctx, `UPDATE oauth_credential_cleanup_cursor SET next_kind=($1::int+$2::int)%3 WHERE singleton=true`, start, limit); err != nil {
		return 0, pg.AuthQueryError("advance OAuth cleanup cursor", err)
	}
	for offset := 0; offset < 3; offset++ {
		kind := (start + offset) % 3
		quota := limit / 3
		if offset < limit%3 {
			quota++
		}
		if quota == 0 {
			continue
		}
		tag, err := d.tx.Exec(ctx, queries[kind], now, quota)
		if err != nil {
			return total, pg.AuthQueryError("prune OAuth credentials", err)
		}
		total += int(tag.RowsAffected())
	}
	// Spare quota goes to other classes without exceeding the batch limit.
	for offset := 0; offset < 3 && total < limit; offset++ {
		kind := (start + offset) % 3
		tag, err := d.tx.Exec(ctx, queries[kind], now, limit-total)
		if err != nil {
			return total, pg.AuthQueryError("prune OAuth credentials", err)
		}
		total += int(tag.RowsAffected())
	}
	return total, nil
}
