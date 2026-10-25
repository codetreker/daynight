package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Store) CreateLogin(ctx context.Context, pending core.LoginTransaction, now time.Time) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return authQueryError("begin login", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		if err := cleanupCredentials(ctx, tx, now); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO login_transactions (id,state_hash,browser_binding_hash,provider,return_path,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, pending.ID, pending.StateHash, pending.BrowserBindingHash, pending.Provider, pending.ReturnPath, pending.ExpiresAt)
		return err
	})
	return authQueryError("create login", err)
}

// The committed DELETE is the admission boundary for the upstream one-time claim.
func (s *Store) ConsumeLogin(ctx context.Context, stateHash, bindingHash []byte, now time.Time) (core.LoginTransaction, error) {
	var p core.LoginTransaction
	err := s.Pool.QueryRow(ctx, `DELETE FROM login_transactions WHERE state_hash=$1 AND browser_binding_hash=$2 AND expires_at>$3 RETURNING id::text,state_hash,browser_binding_hash,provider,return_path,expires_at`, stateHash, bindingHash, now).Scan(&p.ID, &p.StateHash, &p.BrowserBindingHash, &p.Provider, &p.ReturnPath, &p.ExpiresAt)
	return p, authQueryError("consume login", err)
}

func cleanupCredentials(ctx context.Context, tx pgx.Tx, now time.Time) error {
	for _, table := range []string{"login_transactions", "sessions", "personal_access_tokens"} {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE id IN (SELECT id FROM `+table+` WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, now); err != nil {
			return err
		}
	}
	return nil
}

func scanUser(row pgx.Row) (core.User, error) {
	var u core.User
	err := row.Scan(&u.ID, &u.UniAuthID, &u.Email, &u.EmailVerified, &u.Name, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

func (s *Store) CreateIdentitySession(ctx context.Context, user core.User, session core.Session) (core.User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return core.User{}, authQueryError("begin identity session", err)
	}
	var result core.User
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		result, err = scanUser(tx.QueryRow(ctx, `INSERT INTO users (id,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (uniauth_id) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,updated_at=EXCLUDED.updated_at RETURNING id::text,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at`, user.ID, user.UniAuthID, user.Email, user.EmailVerified, user.Name, user.AvatarURL, session.CreatedAt))
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, session.ID, result.ID, session.TokenHash, session.CreatedAt, session.ExpiresAt)
		return err
	})
	return result, authQueryError("create identity session", err)
}

func credentialTable(kind core.CredentialKind) (string, error) {
	switch kind {
	case core.SessionCredential:
		return "sessions", nil
	case core.PATCredential:
		return "personal_access_tokens", nil
	default:
		return "", core.ErrNotFound
	}
}

func (s *Store) Authenticate(ctx context.Context, kind core.CredentialKind, tokenHash []byte, now time.Time) (core.Principal, error) {
	table, err := credentialTable(kind)
	if err != nil {
		return core.Principal{}, err
	}
	expiryPredicate := "c.expires_at>$2"
	if kind == core.PATCredential {
		expiryPredicate = "(c.expires_at IS NULL OR c.expires_at>$2)"
	}
	p := core.Principal{Kind: kind}
	err = s.Pool.QueryRow(ctx, `SELECT c.id::text,c.user_id::text FROM `+table+` c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND `+expiryPredicate, tokenHash, now).Scan(&p.CredentialID, &p.UserID)
	return p, authQueryError("authenticate", err)
}

func (s *Store) IdentityUser(ctx context.Context, userID string) (core.User, error) {
	u, err := scanUser(s.Pool.QueryRow(ctx, `SELECT id::text,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at FROM users WHERE id=$1`, userID))
	return u, authQueryError("read user", err)
}

func (s *Store) DeleteSession(ctx context.Context, p core.Principal) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM sessions WHERE id=$1 AND user_id=$2`, p.CredentialID, p.UserID)
	return authQueryError("delete session", err)
}

func (s *Store) withSession(ctx context.Context, p core.Principal, now time.Time, operation func(pgx.Tx) error) error {
	if p.Kind != core.SessionCredential {
		return core.ErrNotFound
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return authQueryError("begin session operation", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>$3 FOR SHARE`, p.CredentialID, p.UserID, now).Scan(&id); err != nil {
			return err
		}
		return operation(tx)
	})
	return authQueryError("session operation", err)
}

func (s *Store) CreatePAT(ctx context.Context, p core.Principal, c core.PersonalAccessToken) error {
	return s.withSession(ctx, p, c.CreatedAt, func(tx pgx.Tx) error {
		if err := cleanupCredentials(ctx, tx, c.CreatedAt); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO personal_access_tokens (id,user_id,token_hash,name,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, c.ID, p.UserID, c.TokenHash, c.Name, c.CreatedAt, c.ExpiresAt)
		return err
	})
}

func (s *Store) ListPATs(ctx context.Context, p core.Principal, now time.Time) ([]core.PersonalAccessToken, error) {
	result := []core.PersonalAccessToken{}
	err := s.withSession(ctx, p, now, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+patFields+` FROM personal_access_tokens WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>$2) ORDER BY created_at,id`, p.UserID, now)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			c, err := scanPAT(rows)
			if err != nil {
				return err
			}
			result = append(result, c)
		}
		return rows.Err()
	})
	return result, err
}

func (s *Store) RevokePAT(ctx context.Context, p core.Principal, id string, now time.Time) error {
	return s.withSession(ctx, p, now, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1 AND user_id=$2`, id, p.UserID)
		return err
	})
}

func authQueryError(phase string, err error) error {
	if err == nil {
		return nil
	}
	return queryError(phase, err)
}
