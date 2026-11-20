package identity

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

var _ store.PATScopeDAO = (*scope)(nil)

const scopedPATFields = patFields + `,business_scopes,scope_version`

func scanScopedPAT(row pgx.Row) (model.PersonalAccessToken, error) {
	var c model.PersonalAccessToken
	var ids []scopepolicy.ScopeID
	var version *int64
	err := row.Scan(&c.ID, &c.UserID, &c.Name, &c.CreatedAt, &c.ExpiresAt, &c.LastUsedAt, &c.Description, &ids, &version)
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	if version == nil {
		return model.PersonalAccessToken{}, fmt.Errorf("missing PAT scope version")
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, *version)
	if err != nil {
		return model.PersonalAccessToken{}, fmt.Errorf("invalid PAT scope policy: %w", err)
	}
	c.ScopePolicy = &policy
	c.CreatedAt = c.CreatedAt.UTC()
	if c.ExpiresAt != nil {
		value := c.ExpiresAt.UTC()
		c.ExpiresAt = &value
	}
	if c.LastUsedAt != nil {
		value := c.LastUsedAt.UTC()
		c.LastUsedAt = &value
	}
	return c, nil
}

func (s *scope) PATByHash(ctx context.Context, hash []byte, now time.Time) (model.PersonalAccessToken, error) {
	c, err := scanScopedPAT(s.tx.QueryRow(ctx, `SELECT `+scopedPATFields+` FROM personal_access_tokens WHERE token_hash=$1 AND (expires_at IS NULL OR expires_at>$2) AND EXISTS (SELECT 1 FROM users WHERE id=user_id)`, hash, now))
	return c, pg.AuthQueryError("read scoped token by hash", err)
}

func (s *scope) ListPATScopes(ctx context.Context, user string) ([]model.PersonalAccessToken, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+scopedPATFields+` FROM personal_access_tokens WHERE user_id=$1 ORDER BY created_at,id`, user)
	if err != nil {
		return nil, pg.AuthQueryError("list scoped tokens", err)
	}
	defer rows.Close()
	result := []model.PersonalAccessToken{}
	for rows.Next() {
		c, err := scanScopedPAT(rows)
		if err != nil {
			return nil, pg.AuthQueryError("scan scoped token", err)
		}
		result = append(result, c)
	}
	return result, pg.AuthQueryError("list scoped tokens", rows.Err())
}

func (s *scope) ReadLockedPATScope(ctx context.Context, user, id string) (model.PersonalAccessToken, error) {
	c, err := scanScopedPAT(s.tx.QueryRow(ctx, `SELECT `+scopedPATFields+` FROM personal_access_tokens WHERE id=$1 AND user_id=$2 FOR SHARE`, id, user))
	return c, pg.AuthQueryError("share scoped token", err)
}

func (s *scope) LockPATScope(ctx context.Context, user, id string) (model.PersonalAccessToken, error) {
	c, err := scanScopedPAT(s.tx.QueryRow(ctx, `SELECT `+scopedPATFields+` FROM personal_access_tokens WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, user))
	return c, pg.AuthQueryError("lock scoped token", err)
}

func (s *scope) ComparePATScope(ctx context.Context, user, id string, expected int64, ids []scopepolicy.ScopeID, now time.Time) (model.PersonalAccessToken, error) {
	if _, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1); err != nil {
		return model.PersonalAccessToken{}, err
	}
	c, err := scanScopedPAT(s.tx.QueryRow(ctx, `UPDATE personal_access_tokens SET business_scopes=$4, scope_version=scope_version + CASE WHEN business_scopes IS DISTINCT FROM $4::text[] THEN 1 ELSE 0 END WHERE user_id=$1 AND id=$2 AND scope_version=$3 AND (expires_at IS NULL OR expires_at>$5) RETURNING `+scopedPATFields, user, id, expected, ids, now))
	return c, pg.AuthQueryError("update token scopes", err)
}
