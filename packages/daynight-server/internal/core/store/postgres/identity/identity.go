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

type scope struct {
	tx     pgx.Tx
	family store.CredentialFamilyDAO
}

func NewScope(tx pgx.Tx, family store.CredentialFamilyDAO) store.IdentityScope {
	return &scope{tx: tx, family: family}
}
func (s *scope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.family }
func (s *scope) IdentityDAO() store.IdentityDAO                 { return s }
func (s *scope) PersonalTeamDAO() store.PersonalTeamDAO         { return s }

var _ store.IdentityScope = (*scope)(nil)
var _ store.IdentityDAO = (*scope)(nil)
var _ store.PersonalTeamDAO = (*scope)(nil)

func (s *scope) CleanupCredentials(ctx context.Context, now time.Time) error {
	var databaseNow time.Time
	if err := s.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&databaseNow); err != nil {
		return pg.AuthQueryError("read login cleanup time", err)
	}
	return cleanupCredentials(ctx, s.tx, databaseNow, now)
}
func (s *scope) CleanupLoginCredentials(ctx context.Context, databaseNow, applicationNow time.Time) error {
	return cleanupCredentials(ctx, s.tx, databaseNow, applicationNow)
}

// The lock covers both counts and the caller's subsequent cleanup and insert.
// All instances use the same transaction-scoped lock in this database.
const loginCapacityLock int64 = 0x444e4c4f47494e

func (s *scope) AdmitLogin(ctx context.Context, scopeHash []byte, globalLimit, scopeLimit int) (time.Time, string, error) {
	if _, err := s.tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, loginCapacityLock); err != nil {
		return time.Time{}, "", pg.AuthQueryError("lock login capacity", err)
	}
	var now time.Time
	if err := s.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return time.Time{}, "", pg.AuthQueryError("read login capacity time", err)
	}
	var globalCount, scopeCount int
	err := s.tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE scope_hash=$2) FROM login_transactions WHERE expires_at>$1`, now, scopeHash).Scan(&globalCount, &scopeCount)
	if err != nil {
		return time.Time{}, "", pg.AuthQueryError("count login capacity", err)
	}
	if globalCount >= globalLimit {
		return now, "capacity_exhausted", nil
	}
	if scopeCount >= scopeLimit {
		return now, "rate_limited", nil
	}
	return now, "", nil
}
func (s *scope) InsertLogin(ctx context.Context, pending model.LoginTransaction) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO login_transactions (id,state_hash,browser_binding_hash,provider,return_path,expires_at,scope_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`, pending.ID, pending.StateHash, pending.BrowserBindingHash, pending.Provider, pending.ReturnPath, pending.ExpiresAt, pending.ScopeHash)
	return pg.AuthQueryError("insert login", err)
}
func (s *scope) ConsumeLogin(ctx context.Context, stateHash, bindingHash []byte, _ time.Time) (model.LoginTransaction, error) {
	var p model.LoginTransaction
	var id string
	// The expiry check must happen after any row-lock wait, not when a scan
	// first sees the row. Another callback can consume the row while we wait.
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM login_transactions WHERE state_hash=$1 AND browser_binding_hash=$2 FOR UPDATE`, stateHash, bindingHash).Scan(&id); err != nil {
		return p, pg.AuthQueryError("lock login", err)
	}
	err := s.tx.QueryRow(ctx, `DELETE FROM login_transactions WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id::text,state_hash,browser_binding_hash,provider,return_path,expires_at,scope_hash`, id).Scan(&p.ID, &p.StateHash, &p.BrowserBindingHash, &p.Provider, &p.ReturnPath, &p.ExpiresAt, &p.ScopeHash)
	if err != nil {
		return p, pg.AuthQueryError("consume login", err)
	}
	return p, nil
}
func (s *scope) UpsertUser(ctx context.Context, user model.User, now time.Time) (model.User, error) {
	user, err := scanUser(s.tx.QueryRow(ctx, `INSERT INTO users (id,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (uniauth_id) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,updated_at=EXCLUDED.updated_at RETURNING id::text,uniauth_id,email,email_verified,name,avatar_url,created_at,updated_at`, user.ID, user.UniAuthID, user.Email, user.EmailVerified, user.Name, user.AvatarURL, now))
	return user, pg.AuthQueryError("upsert user", err)
}
func (s *scope) InsertSession(ctx context.Context, session model.Session) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`, session.ID, session.UserID, session.TokenHash, session.CreatedAt, session.ExpiresAt)
	return pg.AuthQueryError("insert session", err)
}
func (s *scope) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
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
		return p, pg.AuthQueryError("authenticate", err)
	}
	return p, nil
}
func (s *scope) IdentityUser(ctx context.Context, userID string) (model.User, store.PersonalTeamFacts, error) {
	var user model.User
	var facts store.PersonalTeamFacts
	var teamID *string
	err := s.tx.QueryRow(ctx, `SELECT u.id::text,u.uniauth_id,u.email,u.email_verified,u.name,u.avatar_url,u.created_at,u.updated_at,
 t.id::text,t.name, (SELECT count(*) FROM team_members m WHERE m.team_id=t.id),
 (SELECT count(*) FROM team_members m WHERE m.team_id=t.id AND m.user_id=u.id AND m.role='admin')
 FROM users u LEFT JOIN teams t ON t.personal_user_id=u.id WHERE u.id=$1`, userID).Scan(&user.ID, &user.UniAuthID, &user.Email, &user.EmailVerified, &user.Name, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt, &teamID, &user.PersonalTeam.Name, &facts.MemberCount, &facts.OwnerAdminCount)
	if err != nil {
		return model.User{}, store.PersonalTeamFacts{}, pg.AuthQueryError("read user", err)
	}
	if teamID != nil {
		facts.ID = *teamID
	}
	return user, facts, nil
}
func (s *scope) IdentityPersonalTeam(ctx context.Context, userID string) (store.PersonalTeamFacts, error) {
	var facts store.PersonalTeamFacts
	var id *string
	err := s.tx.QueryRow(ctx, `SELECT t.id::text, (SELECT count(*) FROM team_members m WHERE m.team_id=t.id),
 (SELECT count(*) FROM team_members m WHERE m.team_id=t.id AND m.user_id=u.id AND m.role='admin')
 FROM users u LEFT JOIN teams t ON t.personal_user_id=u.id WHERE u.id=$1`, userID).Scan(&id, &facts.MemberCount, &facts.OwnerAdminCount)
	if err != nil {
		return store.PersonalTeamFacts{}, pg.AuthQueryError("read user", err)
	}
	if id != nil {
		facts.ID = *id
	}
	return facts, nil
}
func (s *scope) DeleteSession(ctx context.Context, p model.Principal) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM sessions WHERE id=$1 AND user_id=$2`, p.CredentialID, p.UserID)
	return pg.AuthQueryError("delete session", err)
}
func (s *scope) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	if p.Kind != model.SessionCredential {
		return model.ErrNotFound
	}
	var id string
	err := s.tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>$3 FOR SHARE`, p.CredentialID, p.UserID, now).Scan(&id)
	if err != nil {
		return pg.AuthQueryError("lock session", err)
	}
	return nil
}
func (s *scope) InsertPAT(ctx context.Context, c model.PersonalAccessToken) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO personal_access_tokens (id,user_id,token_hash,name,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, c.ID, c.UserID, c.TokenHash, c.Name, c.CreatedAt, c.ExpiresAt)
	return pg.AuthQueryError("insert token", err)
}
func (s *scope) ListPATs(ctx context.Context, user string, now time.Time) ([]model.PersonalAccessToken, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+patFields+` FROM personal_access_tokens WHERE user_id=$1 AND (expires_at IS NULL OR expires_at>$2) ORDER BY created_at,id`, user, now)
	if err != nil {
		return nil, pg.AuthQueryError("list tokens", err)
	}
	defer rows.Close()
	result := []model.PersonalAccessToken{}
	for rows.Next() {
		c, err := scanPAT(rows)
		if err != nil {
			return nil, pg.AuthQueryError("list tokens", err)
		}
		result = append(result, c)
	}
	return result, pg.AuthQueryError("list tokens", rows.Err())
}
func (s *scope) DeletePAT(ctx context.Context, user, id string) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1 AND user_id=$2`, id, user)
	return pg.AuthQueryError("delete token", err)
}
func (s *scope) LockActivePAT(ctx context.Context, user, id string, now time.Time) (model.PersonalAccessToken, error) {
	p, err := scanPAT(s.tx.QueryRow(ctx, `SELECT `+patFields+` FROM personal_access_tokens WHERE id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>$3) FOR UPDATE`, id, user, now))
	if err != nil {
		return p, pg.AuthQueryError("lock token", err)
	}
	return p, nil
}
func (s *scope) SetPATExpiry(ctx context.Context, id string, expiry *time.Time) (model.PersonalAccessToken, error) {
	token, err := scanPAT(s.tx.QueryRow(ctx, `UPDATE personal_access_tokens SET expires_at=$2 WHERE id=$1 RETURNING `+patFields, id, expiry))
	return token, pg.AuthQueryError("set token expiry", err)
}
func (s *scope) PruneDeviceRates(ctx context.Context, now time.Time) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM device_authorization_limits WHERE bucket_hash IN (SELECT bucket_hash FROM device_authorization_limits WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, now)
	return pg.AuthQueryError("prune device rates", err)
}
func (s *scope) IncrementDeviceRate(ctx context.Context, b model.DeviceRateBucket, now time.Time) (int, error) {
	var n int
	err := s.tx.QueryRow(ctx, `INSERT INTO device_authorization_limits (bucket_hash,attempts,expires_at) VALUES ($1,1,$2) ON CONFLICT (bucket_hash) DO UPDATE SET attempts=CASE WHEN device_authorization_limits.expires_at <= $4 THEN 1 ELSE LEAST(device_authorization_limits.attempts+1,$3) END, expires_at=CASE WHEN device_authorization_limits.expires_at <= $4 THEN EXCLUDED.expires_at ELSE device_authorization_limits.expires_at END RETURNING attempts`, b.Hash, now.Add(time.Minute), b.Limit+1, now).Scan(&n)
	return n, pg.AuthQueryError("increment device rate", err)
}
func (s *scope) PruneDevices(ctx context.Context, now time.Time) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM device_authorizations WHERE id IN (SELECT id FROM device_authorizations WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, now.Add(-time.Hour))
	return pg.AuthQueryError("prune devices", err)
}
func (s *scope) InsertDevice(ctx context.Context, d model.DeviceAuthorization) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO device_authorizations (id,device_code_hash,user_code,status,created_at,expires_at,next_poll_at,poll_interval_seconds) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7)`, d.ID, d.DeviceCodeHash, d.UserCode, d.CreatedAt, d.ExpiresAt, d.NextPollAt, d.PollIntervalSeconds)
	return pg.AuthQueryError("insert device", err)
}
func (s *scope) DeviceByUserCode(ctx context.Context, user, code string, lock bool) (model.DeviceAuthorization, error) {
	q := `SELECT ` + deviceFields + ` FROM device_authorizations WHERE user_code=$1 AND (user_id IS NULL OR user_id=$2)`
	if lock {
		q += " FOR UPDATE"
	}
	d, err := scanDevice(s.tx.QueryRow(ctx, q, code, user))
	if err != nil {
		return d, pg.AuthQueryError("read device", err)
	}
	return d, nil
}
func (s *scope) LockDeviceByHash(ctx context.Context, hash []byte) (model.DeviceAuthorization, error) {
	d, err := scanDevice(s.tx.QueryRow(ctx, `SELECT `+deviceFields+` FROM device_authorizations WHERE device_code_hash=$1 FOR UPDATE`, hash))
	if err != nil {
		return d, pg.AuthQueryError("lock device", err)
	}
	return d, nil
}
func (s *scope) SetDeviceDecision(ctx context.Context, id, status, user string) error {
	_, err := s.tx.Exec(ctx, `UPDATE device_authorizations SET status=$2,user_id=$3 WHERE id=$1`, id, status, user)
	return pg.AuthQueryError("set device decision", err)
}
func (s *scope) DelayDevicePoll(ctx context.Context, id string, now time.Time, slow bool) error {
	q := `UPDATE device_authorizations SET next_poll_at=$2::timestamptz+poll_interval_seconds*interval '1 second' WHERE id=$1`
	if slow {
		q = `UPDATE device_authorizations SET poll_interval_seconds=poll_interval_seconds+5,next_poll_at=$2::timestamptz+(poll_interval_seconds+5)*interval '1 second' WHERE id=$1`
	}
	_, err := s.tx.Exec(ctx, q, id, now)
	return pg.AuthQueryError("delay device poll", err)
}
func (s *scope) ConsumeDevice(ctx context.Context, id string) error {
	_, err := s.tx.Exec(ctx, `UPDATE device_authorizations SET status='consumed' WHERE id=$1`, id)
	return pg.AuthQueryError("consume device", err)
}
func (s *scope) InsertPersonalTeam(ctx context.Context, id, user string, now time.Time) (bool, error) {
	var teamID string
	err := s.tx.QueryRow(ctx, `INSERT INTO teams (id,personal_user_id,created_at,updated_at) VALUES ($1,$2,$3,$3) ON CONFLICT (personal_user_id) DO NOTHING RETURNING id::text`, id, user, now).Scan(&teamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, pg.AuthQueryError("insert personal Team", err)
}
func (s *scope) InsertPersonalOwner(ctx context.Context, id, user string, now time.Time) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO team_members (team_id,user_id,role,created_at,updated_at) VALUES ($1,$2,'admin',$3,$3)`, id, user, now)
	return pg.AuthQueryError("insert personal owner", err)
}
func (s *scope) PersonalTeam(ctx context.Context, user string) (store.PersonalTeamFacts, error) {
	var facts store.PersonalTeamFacts
	err := s.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, user).Scan(&facts.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.PersonalTeamFacts{}, nil
	}
	if err != nil {
		return store.PersonalTeamFacts{}, pg.AuthQueryError("read personal Team", err)
	}
	err = s.tx.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE user_id=$2 AND role='admin') FROM team_members WHERE team_id=$1`, facts.ID, user).Scan(&facts.MemberCount, &facts.OwnerAdminCount)
	return facts, pg.AuthQueryError("read personal Team membership", err)
}
