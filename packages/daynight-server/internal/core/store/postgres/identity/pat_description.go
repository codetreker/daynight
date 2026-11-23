package identity

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.PATManagementDAO = (*scope)(nil)

func (s *scope) FreshPATTime(ctx context.Context, now time.Time) (time.Time, error) {
	var result time.Time
	err := s.tx.QueryRow(ctx, `SELECT GREATEST($1::timestamptz,clock_timestamp())`, now).Scan(&result)
	return result.UTC().Truncate(time.Microsecond), pg.AuthQueryError("read token management time", err)
}

func (s *scope) ListAllPATs(ctx context.Context, user string) ([]model.PersonalAccessToken, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+patFields+` FROM personal_access_tokens WHERE user_id=$1 ORDER BY created_at,id`, user)
	if err != nil {
		return nil, pg.AuthQueryError("list account tokens", err)
	}
	defer rows.Close()
	result := []model.PersonalAccessToken{}
	for rows.Next() {
		token, err := scanPAT(rows)
		if err != nil {
			return nil, pg.AuthQueryError("scan account token", err)
		}
		result = append(result, token)
	}
	return result, pg.AuthQueryError("list account tokens", rows.Err())
}

func (s *scope) ComparePATDescription(ctx context.Context, user, id string, expected, description *string) (bool, error) {
	var returned string
	err := s.tx.QueryRow(ctx, `UPDATE personal_access_tokens SET description=$4 WHERE user_id=$1 AND id=$2 AND description IS NOT DISTINCT FROM $3 RETURNING id::text`, user, id, expected, description).Scan(&returned)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, pg.AuthQueryError("update token description", err)
	}
	return true, nil
}

func (s *scope) PATExists(ctx context.Context, user, id string) (bool, error) {
	var exists bool
	err := s.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM personal_access_tokens WHERE user_id=$1 AND id=$2)`, user, id).Scan(&exists)
	return exists, pg.AuthQueryError("check token owner", err)
}
