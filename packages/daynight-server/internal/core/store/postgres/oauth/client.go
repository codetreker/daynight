package oauth

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

var _ store.OAuthClientDAO = (*DAO)(nil)

// A transaction-level lock serializes registration and cleanup across instances.
const clientCapacityLock int64 = 0x444e4f4155544843

func (d *DAO) LockClientCapacity(ctx context.Context) error {
	_, err := d.tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, clientCapacityLock)
	return pg.AuthQueryError("lock OAuth client capacity", err)
}
func (d *DAO) FreshTime(ctx context.Context, now time.Time) (time.Time, error) {
	var fresh time.Time
	err := d.tx.QueryRow(ctx, `SELECT GREATEST($1::timestamptz,clock_timestamp())`, now).Scan(&fresh)
	return fresh.UTC().Truncate(time.Microsecond), pg.AuthQueryError("read OAuth client time", err)
}
func (d *DAO) InsertClient(ctx context.Context, c store.OAuthClient, limit int, now time.Time) (bool, error) {
	if limit <= 0 {
		return false, &model.Fault{Code: "invalid_input", Message: "Invalid OAuth client capacity."}
	}
	if err := d.LockClientCapacity(ctx); err != nil {
		return false, err
	}
	var count int
	err := d.tx.QueryRow(ctx, `SELECT count(*) FROM oauth_clients c WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id=c.id AND g.revoked_at IS NULL AND g.expires_at>GREATEST($1::timestamptz,clock_timestamp()))`, now).Scan(&count)
	if err != nil {
		return false, pg.AuthQueryError("count OAuth clients", err)
	}
	if count >= limit {
		return false, nil
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO oauth_clients (id,metadata,created_at,last_used_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, c.ID, c.Metadata, c.CreatedAt, c.LastUsedAt, c.ExpiresAt)
	return err == nil, pg.AuthQueryError("insert OAuth client", err)
}
func (d *DAO) Client(ctx context.Context, id string, lock bool) (store.OAuthClient, error) {
	var c store.OAuthClient
	q := `SELECT id,metadata,created_at,last_used_at,expires_at FROM oauth_clients WHERE id=$1`
	if lock {
		q += ` FOR UPDATE`
	}
	err := d.tx.QueryRow(ctx, q, id).Scan(&c.ID, &c.Metadata, &c.CreatedAt, &c.LastUsedAt, &c.ExpiresAt)
	return c, pg.AuthQueryError("read OAuth client", err)
}
func (d *DAO) PinClient(ctx context.Context, id string, now time.Time) (store.OAuthClient, error) {
	c, err := d.Client(ctx, id, true)
	if err != nil {
		return store.OAuthClient{}, err
	}
	fresh, err := d.FreshTime(ctx, now)
	if err != nil {
		return store.OAuthClient{}, err
	}
	if !c.ExpiresAt.After(fresh) && !c.LastUsedAt.Add(7*24*time.Hour).After(fresh) {
		active, err := d.ActiveClientReferences(ctx, id, fresh)
		if err != nil {
			return store.OAuthClient{}, err
		}
		if !active {
			return store.OAuthClient{}, model.ErrNotFound
		}
	}
	if c.LastUsedAt.After(fresh) {
		fresh = c.LastUsedAt
	}
	c.LastUsedAt = fresh
	c.ExpiresAt = fresh.Add(7 * 24 * time.Hour)
	_, err = d.tx.Exec(ctx, `UPDATE oauth_clients SET last_used_at=$2,expires_at=$3 WHERE id=$1`, id, c.LastUsedAt, c.ExpiresAt)
	return c, pg.AuthQueryError("touch OAuth client", err)
}
func (d *DAO) ExpiredClients(ctx context.Context, now time.Time, limit int) ([]string, error) {
	rows, err := d.tx.Query(ctx, `SELECT c.id FROM oauth_clients c WHERE c.expires_at<=GREATEST($1::timestamptz,clock_timestamp()) AND c.last_used_at + interval '168 hours'<=GREATEST($1::timestamptz,clock_timestamp()) AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id=c.id AND g.revoked_at IS NULL AND g.expires_at>GREATEST($1::timestamptz,clock_timestamp())) ORDER BY c.expires_at,c.id LIMIT $2`, now, limit)
	if err != nil {
		return nil, pg.AuthQueryError("find expired OAuth clients", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, pg.AuthQueryError("scan OAuth client", err)
		}
		ids = append(ids, id)
	}
	return ids, pg.AuthQueryError("find expired OAuth clients", rows.Err())
}
func (d *DAO) DeleteClient(ctx context.Context, id string) error {
	_, err := d.tx.Exec(ctx, `DELETE FROM oauth_clients WHERE id=$1`, id)
	return pg.AuthQueryError("delete OAuth client", err)
}
