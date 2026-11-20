package oauth

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.OAuthScopeDAO = (*DAO)(nil)

const scopedGrantColumns = `id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at,description,business_scopes,scope_version`

func scopePolicy(scope string, ids []scopepolicy.ScopeID, version *int64) (*scopepolicy.Policy, error) {
	if scope != "daynight:mcp" {
		if ids != nil || version != nil {
			return nil, fmt.Errorf("fixed OAuth profile has a scope policy")
		}
		return nil, nil
	}
	if ids == nil || version == nil {
		return nil, fmt.Errorf("missing MCP grant scope policy")
	}
	p, err := scopepolicy.NewPolicy(scopepolicy.MCP, ids, *version)
	if err != nil {
		return nil, fmt.Errorf("invalid MCP grant scope policy: %w", err)
	}
	return &p, nil
}

func scanScopedGrant(row pgx.Row) (store.OAuthGrant, error) {
	var g store.OAuthGrant
	var ids []scopepolicy.ScopeID
	var version *int64
	if err := row.Scan(&g.ID, &g.UserID, &g.ClientID, &g.ClientSnapshot, &g.Resource, &g.Scope, &g.CreatedAt, &g.ExpiresAt, &g.RevokedAt, &g.LastUsedAt, &g.Description, &ids, &version); err != nil {
		return store.OAuthGrant{}, err
	}
	p, err := scopePolicy(g.Scope, ids, version)
	if err != nil {
		return store.OAuthGrant{}, err
	}
	g.ScopePolicy = p
	return g, nil
}

func (d *DAO) ScopedOwnerGrants(ctx context.Context, user string) ([]store.OAuthGrant, error) {
	rows, err := d.tx.Query(ctx, `SELECT `+scopedGrantColumns+` FROM oauth_grants WHERE user_id=$1 ORDER BY created_at DESC,id DESC`, user)
	if err != nil {
		return nil, pg.AuthQueryError("list scoped OAuth grants", err)
	}
	defer rows.Close()
	result := []store.OAuthGrant{}
	for rows.Next() {
		g, err := scanScopedGrant(rows)
		if err != nil {
			return nil, pg.AuthQueryError("scan scoped OAuth grant", err)
		}
		result = append(result, g)
	}
	return result, pg.AuthQueryError("list scoped OAuth grants", rows.Err())
}

func (d *DAO) LockGrantScope(ctx context.Context, user, id string) (store.OAuthGrant, error) {
	g, err := scanScopedGrant(d.tx.QueryRow(ctx, `SELECT `+scopedGrantColumns+` FROM oauth_grants WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, user))
	return g, pg.AuthQueryError("lock scoped OAuth grant", err)
}

func (d *DAO) CompareGrantScope(ctx context.Context, user, id string, expected int64, ids []scopepolicy.ScopeID, now time.Time) (store.OAuthGrant, error) {
	if _, err := scopepolicy.NewPolicy(scopepolicy.MCP, ids, 1); err != nil {
		return store.OAuthGrant{}, err
	}
	g, err := scanScopedGrant(d.tx.QueryRow(ctx, `UPDATE oauth_grants SET business_scopes=$4,scope_version=scope_version + CASE WHEN business_scopes IS DISTINCT FROM $4::text[] THEN 1 ELSE 0 END WHERE user_id=$1 AND id=$2 AND scope_version=$3 AND scope='daynight:mcp' AND revoked_at IS NULL AND expires_at>GREATEST($5::timestamptz,clock_timestamp()) RETURNING `+scopedGrantColumns, user, id, expected, ids, now))
	return g, pg.AuthQueryError("update OAuth grant scopes", err)
}

func (d *DAO) ScopedAccess(ctx context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	return d.scopedAccess(ctx, `a.token_hash=$1`, hash, bindings, now)
}

func (d *DAO) LockScopedAccess(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	if err := d.LockAccess(ctx, p, bindings, now); err != nil {
		return store.OAuthAccessIdentity{}, err
	}
	return d.scopedAccess(ctx, `a.id=$1`, p.CredentialID, bindings, now)
}

// ReadScopedAccess reads the active grant policy without acquiring row locks.
func (d *DAO) ReadScopedAccess(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	identity, err := d.scopedAccess(ctx, `a.id=$1`, p.CredentialID, bindings, now)
	if err != nil {
		return store.OAuthAccessIdentity{}, err
	}
	if identity.Principal != p {
		return store.OAuthAccessIdentity{}, model.ErrNotFound
	}
	return identity, nil
}

func (d *DAO) scopedAccess(ctx context.Context, condition string, key any, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	out := store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential}}
	resources, scopes, clients := bindingValues(bindings)
	var ids []scopepolicy.ScopeID
	var version *int64
	var profile string
	err := d.tx.QueryRow(ctx, `SELECT a.id::text,a.user_id::text,g.id::text,LEAST(a.expires_at,g.expires_at),g.scope,g.business_scopes,g.scope_version FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id AND g.user_id=a.user_id JOIN users u ON u.id=a.user_id WHERE `+condition+` AND EXISTS (SELECT 1 FROM unnest($2::text[],$3::text[],$4::text[]) AS b(resource,scope,client_id) WHERE g.resource=b.resource AND g.scope=b.scope AND (b.client_id='' OR g.client_id=b.client_id)) AND g.revoked_at IS NULL AND LEAST(a.expires_at,g.expires_at)>GREATEST($5::timestamptz,clock_timestamp())`, key, resources, scopes, clients, now).Scan(&out.Principal.CredentialID, &out.Principal.UserID, &out.GrantID, &out.ExpiresAt, &profile, &ids, &version)
	if err != nil {
		return store.OAuthAccessIdentity{}, pg.AuthQueryError("read scoped OAuth access", err)
	}
	out.ScopePolicy, err = scopePolicy(profile, ids, version)
	if err != nil {
		return store.OAuthAccessIdentity{}, err
	}
	out.ExpiresAt = out.ExpiresAt.UTC()
	return out, nil
}
