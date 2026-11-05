package store

import (
	"context"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Store) CreateLogin(ctx context.Context, pending model.LoginTransaction, now time.Time) error {
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
func (s *Store) ConsumeLogin(ctx context.Context, stateHash, bindingHash []byte, now time.Time) (model.LoginTransaction, error) {
	var p model.LoginTransaction
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

func scanUser(row pgx.Row) (model.User, error) {
	var u model.User
	err := row.Scan(&u.ID, &u.UniAuthID, &u.Email, &u.EmailVerified, &u.Name, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

func (s *Store) CreateIdentitySession(ctx context.Context, user model.User, session model.Session) (model.User, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return model.User{}, authQueryError("begin identity session", err)
	}
	var result model.User
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		result, err = scanUser(tx.QueryRow(ctx, `INSERT INTO users (id,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (uniauth_id) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,updated_at=EXCLUDED.updated_at RETURNING id::text,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at`, user.ID, user.UniAuthID, user.Email, user.EmailVerified, user.Name, user.AvatarURL, session.CreatedAt))
		if err != nil {
			return err
		}
		teamID, err := initializePersonalTeam(ctx, tx, result.ID, session.CreatedAt)
		if err != nil {
			return err
		}
		result.PersonalTeam = model.TeamRef{ID: teamID, Kind: "personal"}
		_, err = tx.Exec(ctx, `INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, session.ID, result.ID, session.TokenHash, session.CreatedAt, session.ExpiresAt)
		return err
	})
	return result, authQueryError("create identity session", err)
}

func credentialTable(kind model.CredentialKind) (string, error) {
	switch kind {
	case model.SessionCredential:
		return "sessions", nil
	case model.PATCredential:
		return "personal_access_tokens", nil
	default:
		return "", model.ErrNotFound
	}
}

func (s *Store) Authenticate(ctx context.Context, kind model.CredentialKind, tokenHash []byte, now time.Time) (model.Principal, error) {
	table, err := credentialTable(kind)
	if err != nil {
		return model.Principal{}, err
	}
	expiryPredicate := "c.expires_at>$2"
	if kind == model.PATCredential {
		expiryPredicate = "(c.expires_at IS NULL OR c.expires_at>$2)"
	}
	p := model.Principal{Kind: kind}
	err = s.Pool.QueryRow(ctx, `SELECT c.id::text,c.user_id::text FROM `+table+` c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND `+expiryPredicate, tokenHash, now).Scan(&p.CredentialID, &p.UserID)
	return p, authQueryError("authenticate", err)
}

func (s *Store) IdentityUser(ctx context.Context, userID string) (model.User, error) {
	var user model.User
	var teamID *string
	var validTeam bool
	err := s.Pool.QueryRow(ctx, `SELECT u.id::text,u.uniauth_id,u.email,u.email_verified,u.name,u.avatar_url,u.created_at,u.updated_at,
		t.id::text,t.name, (SELECT count(*)=1 AND bool_and(m.user_id=u.id AND m.role='admin') FROM team_members m WHERE m.team_id=t.id)
		FROM users u LEFT JOIN teams t ON t.personal_user_id=u.id WHERE u.id=$1`, userID).Scan(
		&user.ID, &user.UniAuthID, &user.Email, &user.EmailVerified, &user.Name, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt,
		&teamID, &user.PersonalTeam.Name, &validTeam)
	if err != nil {
		return model.User{}, authQueryError("read user", err)
	}
	if teamID == nil || !validTeam {
		return model.User{}, queryError("read user", fmt.Errorf("user Personal Team is missing or invalid"))
	}
	user.PersonalTeam.ID = *teamID
	user.PersonalTeam.Kind = "personal"
	return user, nil
}

func (s *Store) DeleteSession(ctx context.Context, p model.Principal) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM sessions WHERE id=$1 AND user_id=$2`, p.CredentialID, p.UserID)
	return authQueryError("delete session", err)
}

func (s *Store) withSession(ctx context.Context, p model.Principal, now time.Time, operation func(pgx.Tx) error) error {
	if p.Kind != model.SessionCredential {
		return model.ErrNotFound
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

func (s *Store) CreatePAT(ctx context.Context, p model.Principal, c model.PersonalAccessToken) error {
	return s.withSession(ctx, p, c.CreatedAt, func(tx pgx.Tx) error {
		if err := cleanupCredentials(ctx, tx, c.CreatedAt); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO personal_access_tokens (id,user_id,token_hash,name,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, c.ID, p.UserID, c.TokenHash, c.Name, c.CreatedAt, c.ExpiresAt)
		return err
	})
}

func (s *Store) ListPATs(ctx context.Context, p model.Principal, now time.Time) ([]model.PersonalAccessToken, error) {
	result := []model.PersonalAccessToken{}
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

func (s *Store) RevokePAT(ctx context.Context, p model.Principal, id string, now time.Time) error {
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
