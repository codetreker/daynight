package store

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

type identityTx struct{ tx pgx.Tx }

func (s *Store) WriteIdentity(ctx context.Context, operation func(IdentityScope) error) (Completion, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, authQueryError("begin identity operation", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(&identityTx{tx: tx}) })
	if err == nil {
		return Completion{Outcome: TransactionCommitted}, nil
	}
	var failure *TransactionError
	outcome := TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return Completion{Outcome: outcome}, authQueryError("identity operation", err)
}
func (s *identityTx) IdentityDAO() IdentityDAO         { return s }
func (s *identityTx) PersonalTeamDAO() PersonalTeamDAO { return s }

var _ IdentityWriter = (*Store)(nil)
var _ IdentityScope = (*identityTx)(nil)
var _ IdentityDAO = (*identityTx)(nil)
var _ PersonalTeamDAO = (*identityTx)(nil)

func (s *identityTx) CleanupCredentials(ctx context.Context, now time.Time) error {
	return cleanupCredentials(ctx, s.tx, now)
}
func (s *identityTx) InsertLogin(ctx context.Context, pending model.LoginTransaction) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO login_transactions (id,state_hash,browser_binding_hash,provider,return_path,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, pending.ID, pending.StateHash, pending.BrowserBindingHash, pending.Provider, pending.ReturnPath, pending.ExpiresAt)
	return err
}
func (s *identityTx) ConsumeLogin(ctx context.Context, stateHash, bindingHash []byte, now time.Time) (model.LoginTransaction, error) {
	var p model.LoginTransaction
	err := s.tx.QueryRow(ctx, `DELETE FROM login_transactions WHERE state_hash=$1 AND browser_binding_hash=$2 AND expires_at>$3 RETURNING id::text,state_hash,browser_binding_hash,provider,return_path,expires_at`, stateHash, bindingHash, now).Scan(&p.ID, &p.StateHash, &p.BrowserBindingHash, &p.Provider, &p.ReturnPath, &p.ExpiresAt)
	if err != nil {
		return p, authQueryError("consume login", err)
	}
	return p, nil
}
func (s *identityTx) UpsertUser(ctx context.Context, user model.User, now time.Time) (model.User, error) {
	return scanUser(s.tx.QueryRow(ctx, `INSERT INTO users (id,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (uniauth_id) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,updated_at=EXCLUDED.updated_at RETURNING id::text,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at`, user.ID, user.UniAuthID, user.Email, user.EmailVerified, user.Name, user.AvatarURL, now))
}
func (s *identityTx) InsertSession(ctx context.Context, session model.Session) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, session.ID, session.UserID, session.TokenHash, session.CreatedAt, session.ExpiresAt)
	return err
}
func (s *identityTx) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	table, err := credentialTable(kind)
	if err != nil {
		return model.Principal{}, err
	}
	predicate := "c.expires_at>$2"
	if kind == model.PATCredential {
		predicate = "(c.expires_at IS NULL OR c.expires_at>$2)"
	}
	p := model.Principal{Kind: kind}
	err = s.tx.QueryRow(ctx, `SELECT c.id::text,c.user_id::text FROM `+table+` c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND `+predicate, hash, now).Scan(&p.CredentialID, &p.UserID)
	if err != nil {
		return p, authQueryError("authenticate", err)
	}
	return p, nil
}
func (s *identityTx) IdentityUser(ctx context.Context, userID string) (model.User, PersonalTeamFacts, error) {
	var user model.User
	var facts PersonalTeamFacts
	var teamID *string
	err := s.tx.QueryRow(ctx, `SELECT u.id::text,u.uniauth_id,u.email,u.email_verified,u.name,u.avatar_url,u.created_at,u.updated_at,
 t.id::text,t.name, (SELECT count(*) FROM team_members m WHERE m.team_id=t.id),
 (SELECT count(*) FROM team_members m WHERE m.team_id=t.id AND m.user_id=u.id AND m.role='admin')
 FROM users u LEFT JOIN teams t ON t.personal_user_id=u.id WHERE u.id=$1`, userID).Scan(&user.ID, &user.UniAuthID, &user.Email, &user.EmailVerified, &user.Name, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt, &teamID, &user.PersonalTeam.Name, &facts.MemberCount, &facts.OwnerAdminCount)
	if err != nil {
		return model.User{}, PersonalTeamFacts{}, authQueryError("read user", err)
	}
	if teamID != nil {
		facts.ID = *teamID
	}
	return user, facts, nil
}
func (s *identityTx) DeleteSession(ctx context.Context, p model.Principal) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM sessions WHERE id=$1 AND user_id=$2`, p.CredentialID, p.UserID)
	return err
}
func (s *identityTx) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	if p.Kind != model.SessionCredential {
		return model.ErrNotFound
	}
	var id string
	err := s.tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>$3 FOR SHARE`, p.CredentialID, p.UserID, now).Scan(&id)
	if err != nil {
		return authQueryError("lock session", err)
	}
	return nil
}
func (s *identityTx) InsertPAT(ctx context.Context, c model.PersonalAccessToken) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO personal_access_tokens (id,user_id,token_hash,name,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, c.ID, c.UserID, c.TokenHash, c.Name, c.CreatedAt, c.ExpiresAt)
	return err
}
func (s *identityTx) ListPATs(ctx context.Context, user string, now time.Time) ([]model.PersonalAccessToken, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+patFields+` FROM personal_access_tokens WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>$2) ORDER BY created_at,id`, user, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.PersonalAccessToken{}
	for rows.Next() {
		c, err := scanPAT(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
func (s *identityTx) DeletePAT(ctx context.Context, user, id string) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1 AND user_id=$2`, id, user)
	return err
}
func (s *identityTx) LockActivePAT(ctx context.Context, user, id string, now time.Time) (model.PersonalAccessToken, error) {
	p, err := scanPAT(s.tx.QueryRow(ctx, `SELECT `+patFields+` FROM personal_access_tokens WHERE id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>$3) FOR UPDATE`, id, user, now))
	if err != nil {
		return p, authQueryError("lock token", err)
	}
	return p, nil
}
func (s *identityTx) SetPATExpiry(ctx context.Context, id string, expiry *time.Time) (model.PersonalAccessToken, error) {
	return scanPAT(s.tx.QueryRow(ctx, `UPDATE personal_access_tokens SET expires_at=$2 WHERE id=$1 RETURNING `+patFields, id, expiry))
}
func (s *identityTx) PruneDeviceRates(ctx context.Context, now time.Time) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM device_authorization_limits WHERE bucket_hash IN (SELECT bucket_hash FROM device_authorization_limits WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, now)
	return err
}
func (s *identityTx) IncrementDeviceRate(ctx context.Context, b model.DeviceRateBucket, now time.Time) (int, error) {
	var n int
	err := s.tx.QueryRow(ctx, `INSERT INTO device_authorization_limits (bucket_hash,attempts,expires_at) VALUES ($1,1,$2) ON CONFLICT (bucket_hash) DO UPDATE SET attempts=CASE WHEN device_authorization_limits.expires_at <= $4 THEN 1 ELSE LEAST(device_authorization_limits.attempts+1,$3) END, expires_at=CASE WHEN device_authorization_limits.expires_at <= $4 THEN EXCLUDED.expires_at ELSE device_authorization_limits.expires_at END RETURNING attempts`, b.Hash, now.Add(time.Minute), b.Limit+1, now).Scan(&n)
	return n, err
}
func (s *identityTx) PruneDevices(ctx context.Context, now time.Time) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM device_authorizations WHERE id IN (SELECT id FROM device_authorizations WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, now.Add(-time.Hour))
	return err
}
func (s *identityTx) InsertDevice(ctx context.Context, d model.DeviceAuthorization) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO device_authorizations (id,device_code_hash,user_code,status,created_at,expires_at,next_poll_at,poll_interval_seconds) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7)`, d.ID, d.DeviceCodeHash, d.UserCode, d.CreatedAt, d.ExpiresAt, d.NextPollAt, d.PollIntervalSeconds)
	return err
}
func (s *identityTx) DeviceByUserCode(ctx context.Context, user, code string, lock bool) (model.DeviceAuthorization, error) {
	q := `SELECT ` + deviceFields + ` FROM device_authorizations WHERE user_code=$1 AND (user_id IS NULL OR user_id=$2)`
	if lock {
		q += " FOR UPDATE"
	}
	d, err := scanDevice(s.tx.QueryRow(ctx, q, code, user))
	if err != nil {
		return d, authQueryError("read device", err)
	}
	return d, nil
}
func (s *identityTx) LockDeviceByHash(ctx context.Context, hash []byte) (model.DeviceAuthorization, error) {
	d, err := scanDevice(s.tx.QueryRow(ctx, `SELECT `+deviceFields+` FROM device_authorizations WHERE device_code_hash=$1 FOR UPDATE`, hash))
	if err != nil {
		return d, authQueryError("lock device", err)
	}
	return d, nil
}
func (s *identityTx) SetDeviceDecision(ctx context.Context, id, status, user string) error {
	_, err := s.tx.Exec(ctx, `UPDATE device_authorizations SET status=$2,user_id=$3 WHERE id=$1`, id, status, user)
	return err
}
func (s *identityTx) DelayDevicePoll(ctx context.Context, id string, now time.Time, slow bool) error {
	q := `UPDATE device_authorizations SET next_poll_at=$2::timestamptz+poll_interval_seconds*interval '1 second' WHERE id=$1`
	if slow {
		q = `UPDATE device_authorizations SET poll_interval_seconds=poll_interval_seconds+5,next_poll_at=$2::timestamptz+(poll_interval_seconds+5)*interval '1 second' WHERE id=$1`
	}
	_, err := s.tx.Exec(ctx, q, id, now)
	return err
}
func (s *identityTx) ConsumeDevice(ctx context.Context, id string) error {
	_, err := s.tx.Exec(ctx, `UPDATE device_authorizations SET status='consumed' WHERE id=$1`, id)
	return err
}
func (s *identityTx) InsertPersonalTeam(ctx context.Context, id, user string, now time.Time) (bool, error) {
	var teamID string
	err := s.tx.QueryRow(ctx, `INSERT INTO teams (id,personal_user_id,created_at,updated_at) VALUES ($1,$2,$3,$3) ON CONFLICT (personal_user_id) DO NOTHING RETURNING id::text`, id, user, now).Scan(&teamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
func (s *identityTx) InsertPersonalOwner(ctx context.Context, id, user string, now time.Time) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO team_members (team_id,user_id,role,created_at,updated_at) VALUES ($1,$2,'admin',$3,$3)`, id, user, now)
	return err
}
func (s *identityTx) PersonalTeam(ctx context.Context, user string) (PersonalTeamFacts, error) {
	var facts PersonalTeamFacts
	err := s.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, user).Scan(&facts.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PersonalTeamFacts{}, nil
	}
	if err != nil {
		return PersonalTeamFacts{}, err
	}
	err = s.tx.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE user_id=$2 AND role='admin') FROM team_members WHERE team_id=$1`, facts.ID, user).Scan(&facts.MemberCount, &facts.OwnerAdminCount)
	return facts, err
}
