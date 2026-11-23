package identity

import (
	"context"
	"crypto/subtle"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.PreviewSSODAO = (*scope)(nil)

const previewLoginFields = `id::text,return_url,state_hash,code_hash,session_id::text,expires_at`

func scanPreviewLogin(row pgx.Row) (model.PreviewSSOLogin, error) {
	var login model.PreviewSSOLogin
	var sessionID *string
	err := row.Scan(&login.ID, &login.ReturnURL, &login.StateHash, &login.CodeHash, &sessionID, &login.ExpiresAt)
	if sessionID != nil {
		login.SessionID = *sessionID
	}
	return login, err
}

func (s *scope) CleanupPreviewSSO(ctx context.Context, _ time.Time) error {
	_, err := s.tx.Exec(ctx, `DELETE FROM preview_sso_logins WHERE id IN (SELECT id FROM preview_sso_logins WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`)
	return pg.AuthQueryError("cleanup preview SSO", err)
}

func (s *scope) InsertPreviewSSO(ctx context.Context, login model.PreviewSSOLogin) error {
	_, err := s.tx.Exec(ctx, `INSERT INTO preview_sso_logins(id,return_url,expires_at) VALUES($1,$2,$3)`, login.ID, login.ReturnURL, login.ExpiresAt)
	return pg.AuthQueryError("insert preview SSO", err)
}

func (s *scope) StartPreviewSSO(ctx context.Context, id string, state []byte, _ time.Time) (model.PreviewSSOLogin, error) {
	var locked string
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM preview_sso_logins WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
		return model.PreviewSSOLogin{}, pg.AuthQueryError("lock preview SSO", err)
	}
	login, err := scanPreviewLogin(s.tx.QueryRow(ctx, `UPDATE preview_sso_logins SET state_hash=$2 WHERE id=$1 AND state_hash IS NULL AND code_hash IS NULL AND session_id IS NULL AND expires_at>clock_timestamp() RETURNING `+previewLoginFields, id, state))
	return login, pg.AuthQueryError("start preview SSO", err)
}

func (s *scope) LockPreviewAuthorization(ctx context.Context, id string, state []byte, principal model.Principal, _ time.Time) (time.Time, error) {
	var locked string
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM preview_sso_logins WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
		return time.Time{}, pg.AuthQueryError("lock preview SSO", err)
	}
	if principal.Kind != model.SessionCredential {
		return time.Time{}, model.ErrNotFound
	}
	var sessionID string
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE`, principal.CredentialID, principal.UserID).Scan(&sessionID); err != nil {
		return time.Time{}, pg.AuthQueryError("lock preview session", err)
	}
	effectiveNow, err := s.SessionTime(ctx)
	if err != nil {
		return time.Time{}, err
	}
	err = s.tx.QueryRow(ctx, `SELECT l.id::text FROM preview_sso_logins l JOIN sessions s ON s.id=$3 WHERE l.id=$1 AND l.state_hash=$2 AND l.code_hash IS NULL AND l.session_id IS NULL AND l.expires_at>$4 AND s.expires_at>$4`, id, state, sessionID, effectiveNow).Scan(&locked)
	if err != nil {
		return time.Time{}, pg.AuthQueryError("check preview authorization", err)
	}
	return effectiveNow, nil
}

func (s *scope) SetPreviewAuthorization(ctx context.Context, id string, principal model.Principal, code []byte, expires time.Time) error {
	var updated string
	err := s.tx.QueryRow(ctx, `UPDATE preview_sso_logins SET code_hash=$2,session_id=$3,expires_at=$4 WHERE id=$1 AND state_hash IS NOT NULL AND code_hash IS NULL AND session_id IS NULL RETURNING id::text`, id, code, principal.CredentialID, expires).Scan(&updated)
	return pg.AuthQueryError("authorize preview SSO", err)
}

func (s *scope) RedeemPreviewSSO(ctx context.Context, code, state, preview []byte, _ time.Time) (model.PreviewSSOLogin, model.Session, error) {
	login, err := scanPreviewLogin(s.tx.QueryRow(ctx, `SELECT `+previewLoginFields+` FROM preview_sso_logins WHERE code_hash=$1 AND state_hash=$2 FOR UPDATE`, code, state))
	if err != nil {
		return model.PreviewSSOLogin{}, model.Session{}, pg.AuthQueryError("lock preview SSO code", err)
	}
	if login.SessionID == "" {
		return model.PreviewSSOLogin{}, model.Session{}, model.ErrNotFound
	}
	var session model.Session
	err = s.tx.QueryRow(ctx, `SELECT id::text,user_id::text,token_hash,preview_token_hash,created_at,expires_at FROM sessions WHERE id=$1 FOR UPDATE`, login.SessionID).Scan(&session.ID, &session.UserID, &session.TokenHash, &session.PreviewTokenHash, &session.CreatedAt, &session.ExpiresAt)
	if err != nil {
		return model.PreviewSSOLogin{}, model.Session{}, pg.AuthQueryError("lock preview session", err)
	}
	effectiveNow, err := s.SessionTime(ctx)
	if err != nil {
		return model.PreviewSSOLogin{}, model.Session{}, err
	}
	if !login.ExpiresAt.After(effectiveNow) || !session.ExpiresAt.After(effectiveNow) {
		return model.PreviewSSOLogin{}, model.Session{}, model.ErrNotFound
	}
	if _, err = s.tx.Exec(ctx, `UPDATE sessions SET preview_token_hash=$2 WHERE id=$1`, session.ID, preview); err != nil {
		return model.PreviewSSOLogin{}, model.Session{}, pg.AuthQueryError("set preview credential", err)
	}
	login, err = scanPreviewLogin(s.tx.QueryRow(ctx, `UPDATE preview_sso_logins SET code_hash=NULL WHERE id=$1 AND code_hash=$2 AND state_hash=$3 RETURNING `+previewLoginFields, login.ID, code, state))
	if err != nil {
		return model.PreviewSSOLogin{}, model.Session{}, pg.AuthQueryError("consume preview SSO code", err)
	}
	session.PreviewTokenHash = preview
	return login, session, nil
}

func (s *scope) CompletePreviewSSO(ctx context.Context, id string, preview []byte, _ time.Time) (model.PreviewSSOLogin, error) {
	login, err := scanPreviewLogin(s.tx.QueryRow(ctx, `SELECT `+previewLoginFields+` FROM preview_sso_logins WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return model.PreviewSSOLogin{}, pg.AuthQueryError("lock preview SSO", err)
	}
	if login.SessionID == "" || len(login.StateHash) == 0 || len(login.CodeHash) != 0 {
		return model.PreviewSSOLogin{}, model.ErrNotFound
	}
	var sessionID string
	if err = s.tx.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 AND preview_token_hash=$2 FOR SHARE`, login.SessionID, preview).Scan(&sessionID); err != nil {
		return model.PreviewSSOLogin{}, pg.AuthQueryError("lock preview credential", err)
	}
	login, err = scanPreviewLogin(s.tx.QueryRow(ctx, `DELETE FROM preview_sso_logins WHERE id=$1 AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM sessions WHERE id=$2 AND preview_token_hash=$3 AND expires_at>clock_timestamp()) RETURNING `+previewLoginFields, id, sessionID, preview))
	return login, pg.AuthQueryError("complete preview SSO", err)
}

func (s *scope) TakePreviewSSORetry(ctx context.Context, id string, state []byte, principal model.Principal, _ time.Time) (model.PreviewSSOLogin, error) {
	if principal.Kind != model.SessionCredential || (id == "" && len(state) == 0) {
		return model.PreviewSSOLogin{}, model.ErrNotFound
	}
	query := `SELECT ` + previewLoginFields + ` FROM preview_sso_logins WHERE id=$1 FOR UPDATE`
	var key any = id
	if id == "" {
		query = `SELECT ` + previewLoginFields + ` FROM preview_sso_logins WHERE state_hash=$1 ORDER BY id LIMIT 2 FOR UPDATE`
		key = state
	}
	rows, err := s.tx.Query(ctx, query, key)
	if err != nil {
		return model.PreviewSSOLogin{}, pg.AuthQueryError("lock preview retry", err)
	}
	var login model.PreviewSSOLogin
	count := 0
	for rows.Next() {
		login, err = scanPreviewLogin(rows)
		if err != nil {
			break
		}
		count++
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return model.PreviewSSOLogin{}, pg.AuthQueryError("read preview retry", err)
	}
	if count != 1 || len(login.StateHash) == 0 ||
		(len(state) != 0 && subtle.ConstantTimeCompare(login.StateHash, state) != 1) ||
		(login.SessionID == "" && (id == "" || len(state) == 0 || len(login.CodeHash) != 0)) ||
		(login.SessionID != "" && login.SessionID != principal.CredentialID) {
		return model.PreviewSSOLogin{}, model.ErrNotFound
	}
	var expires time.Time
	if err := s.tx.QueryRow(ctx, `SELECT expires_at FROM sessions WHERE id=$1 AND user_id=$2 FOR SHARE`, principal.CredentialID, principal.UserID).Scan(&expires); err != nil {
		return model.PreviewSSOLogin{}, pg.AuthQueryError("lock preview retry session", err)
	}
	effectiveNow, err := s.SessionTime(ctx)
	if err != nil {
		return model.PreviewSSOLogin{}, err
	}
	if !login.ExpiresAt.After(effectiveNow) || !expires.After(effectiveNow) {
		return model.PreviewSSOLogin{}, model.ErrNotFound
	}
	login, err = scanPreviewLogin(s.tx.QueryRow(ctx, `DELETE FROM preview_sso_logins WHERE id=$1 RETURNING `+previewLoginFields, login.ID))
	return login, pg.AuthQueryError("consume preview retry", err)
}

func (s *scope) AuthenticatePreview(ctx context.Context, preview []byte, _ time.Time) (model.Principal, time.Time, error) {
	principal := model.Principal{Kind: model.SessionCredential}
	var expires time.Time
	err := s.tx.QueryRow(ctx, `SELECT s.id::text,s.user_id::text,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.preview_token_hash=$1 AND s.expires_at>clock_timestamp()`, preview).Scan(&principal.CredentialID, &principal.UserID, &expires)
	return principal, expires, pg.AuthQueryError("authenticate preview", err)
}
