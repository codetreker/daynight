package oauth

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

const authorizationCapacityLock int64 = 0x444e4f4155544841

var _ store.AuthorizationDAO = (*DAO)(nil)

func (d *DAO) InsertAuthorization(ctx context.Context, a store.OAuthAuthorization, limit int, now time.Time) (bool, error) {
	if _, err := d.tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, authorizationCapacityLock); err != nil {
		return false, pg.AuthQueryError("lock OAuth authorization capacity", err)
	}
	fresh, err := d.FreshTime(ctx, now)
	if err != nil {
		return false, err
	}
	pendingLifetime, retention := a.ExpiresAt.Sub(a.CreatedAt), a.RetainUntil.Sub(a.CreatedAt)
	a.CreatedAt, a.ExpiresAt, a.RetainUntil = fresh, fresh.Add(pendingLifetime), fresh.Add(retention)
	var count int
	if err := d.tx.QueryRow(ctx, `SELECT count(*) FROM oauth_authorizations WHERE status='pending' AND expires_at>GREATEST($1::timestamptz,clock_timestamp())`, now).Scan(&count); err != nil {
		return false, pg.AuthQueryError("count OAuth authorizations", err)
	}
	if count >= limit {
		return false, nil
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO oauth_authorizations (id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, a.ID, a.BindingHash, a.Client, a.ClientID, a.RedirectURI, a.Resource, a.Scope, a.Challenge, a.State, a.StatePresent, a.Status, a.CreatedAt, a.ExpiresAt, a.RetainUntil)
	return err == nil, pg.AuthQueryError("insert OAuth authorization", err)
}

const authorizationColumns = `id::text,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,COALESCE(user_id::text,''),COALESCE(grant_id::text,''),code_hash,created_at,expires_at,code_expires_at,retain_until`

func (d *DAO) readAuthorization(ctx context.Context, where string, arg any, lock bool) (store.OAuthAuthorization, error) {
	var a store.OAuthAuthorization
	q := `SELECT ` + authorizationColumns + ` FROM oauth_authorizations WHERE ` + where
	if lock {
		q += ` FOR UPDATE`
	}
	err := d.tx.QueryRow(ctx, q, arg).Scan(&a.ID, &a.BindingHash, &a.Client, &a.ClientID, &a.RedirectURI, &a.Resource, &a.Scope, &a.Challenge, &a.State, &a.StatePresent, &a.Status, &a.UserID, &a.GrantID, &a.CodeHash, &a.CreatedAt, &a.ExpiresAt, &a.CodeExpiresAt, &a.RetainUntil)
	return a, pg.AuthQueryError("read OAuth authorization", err)
}
func (d *DAO) Authorization(ctx context.Context, id string, lock bool) (store.OAuthAuthorization, error) {
	return d.readAuthorization(ctx, `id=$1`, id, lock)
}
func (d *DAO) AuthorizationByCode(ctx context.Context, hash []byte, lock bool) (store.OAuthAuthorization, error) {
	return d.readAuthorization(ctx, `code_hash=$1`, hash, lock)
}
func (d *DAO) UpdateAuthorization(ctx context.Context, a store.OAuthAuthorization) error {
	_, err := d.tx.Exec(ctx, `UPDATE oauth_authorizations SET state=$2,state_present=$9,status=$3,user_id=NULLIF($4,'')::uuid,grant_id=NULLIF($5,'')::uuid,code_hash=$6,code_expires_at=$7,retain_until=$8 WHERE id=$1`, a.ID, a.State, a.Status, a.UserID, a.GrantID, a.CodeHash, a.CodeExpiresAt, a.RetainUntil, a.StatePresent)
	return pg.AuthQueryError("update OAuth authorization", err)
}
func (d *DAO) PruneAuthorizations(ctx context.Context, now time.Time, limit int) (int, error) {
	if _, err := d.tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, authorizationCapacityLock); err != nil {
		return 0, pg.AuthQueryError("lock OAuth authorization capacity", err)
	}
	tag, err := d.tx.Exec(ctx, `UPDATE oauth_authorizations SET status='expired',state='',state_present=false WHERE id IN (SELECT id FROM oauth_authorizations WHERE status='pending' AND expires_at<=GREATEST($1::timestamptz,clock_timestamp()) ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)`, now, limit)
	if err != nil {
		return 0, pg.AuthQueryError("expire OAuth authorizations", err)
	}
	expired := int(tag.RowsAffected())
	tag, err = d.tx.Exec(ctx, `DELETE FROM oauth_authorizations WHERE id IN (SELECT id FROM oauth_authorizations WHERE retain_until<=GREATEST($1::timestamptz,clock_timestamp()) ORDER BY retain_until,id LIMIT $2 FOR UPDATE SKIP LOCKED)`, now, limit-expired)
	return expired + int(tag.RowsAffected()), pg.AuthQueryError("prune OAuth authorizations", err)
}
