package identity

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const userFields = `id::text,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at`

func (s *scope) EnsureUser(ctx context.Context, candidate model.User, now time.Time) (model.User, bool, error) {
	user, err := scanUser(s.tx.QueryRow(ctx, `INSERT INTO users (id,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (uniauth_id) DO NOTHING RETURNING `+userFields, candidate.ID, candidate.UniAuthID, candidate.Email, candidate.EmailVerified, candidate.Name, candidate.AvatarURL, now))
	if err == nil {
		return user, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return model.User{}, false, pg.AuthQueryError("ensure user", err)
	}
	// A separate READ COMMITTED statement sees the identity whose insertion
	// won the unique-key conflict, including an insertion that waited to commit.
	user, err = scanUser(s.tx.QueryRow(ctx, `SELECT `+userFields+` FROM users WHERE uniauth_id=$1`, candidate.UniAuthID))
	if err != nil {
		return model.User{}, false, pg.AuthQueryError("read ensured user", err)
	}
	return user, false, nil
}

func (s *scope) PatchUser(ctx context.Context, userID string, patch model.UserProfilePatch) (model.User, error) {
	assignments := []string{"updated_at=clock_timestamp()"}
	args := []any{userID}
	for _, field := range []struct {
		column string
		value  model.ProfileField
	}{{"name", patch.Name}, {"avatar_url", patch.AvatarURL}} {
		if field.value.Present {
			args = append(args, field.value.Value)
			assignments = append(assignments, fmt.Sprintf("%s=$%d", field.column, len(args)))
		}
	}
	user, err := scanUser(s.tx.QueryRow(ctx, `UPDATE users SET `+strings.Join(assignments, ",")+` WHERE id=$1 RETURNING `+userFields, args...))
	return user, pg.AuthQueryError("patch user", err)
}

// LockProfileCredential allows sibling readers to authorize while the profile
// waits for the user row; credential mutations remain excluded until completion.
func (s *scope) LockProfileCredential(ctx context.Context, principal model.Principal, now time.Time) error {
	if principal.Kind != model.SessionCredential && principal.Kind != model.PATCredential {
		return model.ErrNotFound
	}
	credential, err := pg.ThreadCredential(ctx, s.tx, principal, " FOR SHARE")
	if err != nil {
		return err
	}
	if credential.ExpiresAt == nil {
		return nil
	}
	var valid bool
	if err := s.tx.QueryRow(ctx, `SELECT $1::timestamptz>GREATEST($2::timestamptz,clock_timestamp())`, credential.ExpiresAt, now).Scan(&valid); err != nil {
		return pg.AuthQueryError("recheck profile credential expiry", err)
	}
	if !valid {
		return model.ErrNotFound
	}
	return nil
}
