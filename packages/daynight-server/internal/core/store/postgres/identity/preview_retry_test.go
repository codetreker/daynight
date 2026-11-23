package identity_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func retryService(t *testing.T, f previewFixture) *identityservice.PreviewSSO {
	t.Helper()
	s, err := identityservice.NewPreviewSSO(f.db, "https://daynight.cc", "https://preview.daynight.cc", "https://daynight.cc/api/v1/auth/callback")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestPreviewRetryReplacesOnceAndPreservesTarget(t *testing.T) {
	for _, byState := range []bool{false, true} {
		t.Run(map[bool]string{false: "login", true: "state"}[byState], func(t *testing.T) {
			f := newPreviewFixture(t)
			state := secret.Random("")
			f.state = secret.Hash(state)
			f.authorize(t)
			id, token := f.login.ID, ""
			if byState {
				id, token = "", state
			}
			s := retryService(t, f)
			replacement, err := s.Retry(t.Context(), id, token, f.principal)
			if err != nil || replacement == "" || replacement == f.login.ID {
				t.Fatalf("retry: %q %v", replacement, err)
			}
			var target string
			var oldCount, initialized int
			err = f.db.Pool.QueryRow(t.Context(), `SELECT return_url, (SELECT count(*) FROM preview_sso_logins WHERE id=$2), (SELECT count(*) FROM preview_sso_logins WHERE id=$1 AND state_hash IS NULL AND code_hash IS NULL AND session_id IS NULL) FROM preview_sso_logins WHERE id=$1`, replacement, f.login.ID).Scan(&target, &oldCount, &initialized)
			if err != nil || target != f.login.ReturnURL || oldCount != 0 || initialized != 1 {
				t.Fatalf("persisted replacement: %q %d %d %v", target, oldCount, initialized, err)
			}
			if again, err := s.Retry(t.Context(), id, token, f.principal); err == nil || again != "" {
				t.Fatalf("reused old login: %q %v", again, err)
			}
			_, err = f.db.WritePreviewSSO(t.Context(), func(d store.PreviewSSODAO) error {
				_, _, err := d.RedeemPreviewSSO(t.Context(), f.code, f.state, f.preview, f.now)
				return err
			})
			requireMissing(t, err)
		})
	}
}

func TestPreviewRetryRejectsWrongSessionExpiryAndRollsBack(t *testing.T) {
	db := isolatedStore(t)
	for _, scenario := range []string{"wrong_user", "wrong_session", "expired_login", "expired_session", "revoked_session", "rollback"} {
		if !t.Run(scenario, func(t *testing.T) {
			f := newPreviewFixtureInStore(t, db)
			f.authorize(t)
			principal := f.principal
			switch scenario {
			case "wrong_user":
				principal.UserID = uuid.NewString()
			case "wrong_session":
				principal.CredentialID = uuid.NewString()
			case "expired_login":
				if _, err := f.db.Pool.Exec(t.Context(), `UPDATE preview_sso_logins SET expires_at=$2 WHERE id=$1`, f.login.ID, f.now); err != nil {
					t.Fatal(err)
				}
			case "expired_session":
				if _, err := f.db.Pool.Exec(t.Context(), `UPDATE sessions SET created_at=$2, expires_at=$3 WHERE id=$1`, f.session.ID, f.now.Add(-time.Hour), f.now); err != nil {
					t.Fatal(err)
				}
			case "revoked_session":
				if _, err := f.db.Pool.Exec(t.Context(), `DELETE FROM sessions WHERE id=$1`, f.session.ID); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "rollback" {
				abort := errors.New("abort")
				c, err := f.db.WritePreviewSSO(t.Context(), func(d store.PreviewSSODAO) error {
					_, err := d.TakePreviewSSORetry(t.Context(), f.login.ID, nil, principal, f.now)
					if err != nil {
						return err
					}
					return abort
				})
				if !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
					t.Fatalf("rollback: %+v %v", c, err)
				}
			} else if id, err := retryService(t, f).Retry(t.Context(), f.login.ID, "", principal); err == nil || id != "" {
				t.Fatalf("accepted %s: %q %v", scenario, id, err)
			}
			var count int
			if err := f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM preview_sso_logins WHERE id=$1`, f.login.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("old record changed: %d %v", count, err)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, db.Pool)
	}
}

func TestPreviewRetryStateRejectsOtherSessionWithoutConsumingLogin(t *testing.T) {
	f := newPreviewFixture(t)
	state := secret.Random("")
	f.state = secret.Hash(state)
	f.authorize(t)
	other := model.Session{ID: uuid.NewString(), UserID: f.session.UserID, TokenHash: hash("other-main"), CreatedAt: f.now, ExpiresAt: f.now.Add(time.Hour)}
	identityScopeTest(t, f.db, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().InsertSession(t.Context(), other)
	})
	otherPrincipal := f.principal
	otherPrincipal.CredentialID = other.ID
	s := retryService(t, f)
	if id, err := s.Retry(t.Context(), "", state, otherPrincipal); err == nil || id != "" {
		t.Fatalf("another session recovered the login: %q %v", id, err)
	}
	var target, session string
	var stateMatches, codeMatches bool
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT return_url,session_id::text,state_hash=$2,code_hash=$3 FROM preview_sso_logins WHERE id=$1`, f.login.ID, f.state, f.code).Scan(&target, &session, &stateMatches, &codeMatches); err != nil || target != f.login.ReturnURL || session != f.session.ID || !stateMatches || !codeMatches {
		t.Fatalf("rejected recovery changed login: %q %q %v %v %v", target, session, stateMatches, codeMatches, err)
	}
	replacement, err := s.Retry(t.Context(), "", state, f.principal)
	if err != nil || replacement == "" || replacement == f.login.ID {
		t.Fatalf("source session could not recover: %q %v", replacement, err)
	}
	var oldCount int
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT return_url,(SELECT count(*) FROM preview_sso_logins WHERE id=$2) FROM preview_sso_logins WHERE id=$1`, replacement, f.login.ID).Scan(&target, &oldCount); err != nil || target != f.login.ReturnURL || oldCount != 0 {
		t.Fatalf("replacement target=%q old=%d err=%v", target, oldCount, err)
	}
}

func TestPreviewRetryAfterRedemptionAndAmbiguousState(t *testing.T) {
	f := newPreviewFixture(t)
	state := secret.Random("")
	f.state = secret.Hash(state)
	f.authorize(t)
	previewWrite(t, f, func(d store.PreviewSSODAO) error {
		_, _, err := d.RedeemPreviewSSO(t.Context(), f.code, f.state, f.preview, f.now)
		return err
	})
	// An ambiguous state never picks a target, even if one row has the right session.
	otherID := uuid.NewString()
	if _, err := f.db.Pool.Exec(t.Context(), `INSERT INTO preview_sso_logins(id,return_url,expires_at,state_hash,session_id) VALUES($1,$2,$3,$4,$5)`, otherID, f.login.ReturnURL, f.now.Add(time.Minute), f.state, f.session.ID); err != nil {
		t.Fatal(err)
	}
	s := retryService(t, f)
	if id, err := s.Retry(t.Context(), "", state, f.principal); err == nil || id != "" {
		t.Fatalf("ambiguous state accepted: %q %v", id, err)
	}
	if _, err := f.db.Pool.Exec(t.Context(), `DELETE FROM preview_sso_logins WHERE id=$1`, otherID); err != nil {
		t.Fatal(err)
	}
	if id, err := s.Retry(t.Context(), f.login.ID, "", f.principal); err != nil || id == "" {
		t.Fatalf("retry after redemption: %q %v", id, err)
	}
}

func TestPreviewRetryUnboundAuthorizationRequiresIDAndState(t *testing.T) {
	f := newPreviewFixture(t)
	state := secret.Random("")
	f.state = secret.Hash(state)
	previewWrite(t, f, func(d store.PreviewSSODAO) error {
		if err := d.InsertPreviewSSO(t.Context(), f.login); err != nil {
			return err
		}
		_, err := d.StartPreviewSSO(t.Context(), f.login.ID, f.state, f.now)
		return err
	})
	// The main session can expire while authorization waits for the login lock.
	// A newly authenticated session must recover an as-yet unbound record.
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE sessions SET created_at=$2, expires_at=$3 WHERE id=$1`, f.session.ID, f.now.Add(-time.Hour), f.now); err != nil {
		t.Fatal(err)
	}
	newSession := model.Session{ID: uuid.NewString(), UserID: f.session.UserID, TokenHash: hash("replacement-main"), CreatedAt: f.now, ExpiresAt: f.now.Add(time.Hour)}
	identityScopeTest(t, f.db, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().InsertSession(t.Context(), newSession)
	})
	f.principal.CredentialID = newSession.ID
	s := retryService(t, f)
	for _, input := range []struct{ id, state string }{
		{f.login.ID, ""}, {"", state}, {f.login.ID, secret.Random("")},
	} {
		if id, err := s.Retry(t.Context(), input.id, input.state, f.principal); err == nil || id != "" {
			t.Fatalf("unbound retry accepted incomplete or incorrect proof: %q %v", id, err)
		}
	}
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE preview_sso_logins SET expires_at=$2 WHERE id=$1`, f.login.ID, f.now); err != nil {
		t.Fatal(err)
	}
	if id, err := s.Retry(t.Context(), f.login.ID, state, f.principal); err == nil || id != "" {
		t.Fatalf("expired unbound retry accepted: %q %v", id, err)
	}
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE preview_sso_logins SET expires_at=$2 WHERE id=$1`, f.login.ID, f.login.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	replacement, err := s.Retry(t.Context(), f.login.ID, state, f.principal)
	if err != nil || replacement == "" {
		t.Fatalf("unbound retry: %q %v", replacement, err)
	}
	var target string
	var oldCount int
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT return_url, (SELECT count(*) FROM preview_sso_logins WHERE id=$2) FROM preview_sso_logins WHERE id=$1`, replacement, f.login.ID).Scan(&target, &oldCount); err != nil || target != f.login.ReturnURL || oldCount != 0 {
		t.Fatalf("replacement target=%q old=%d err=%v", target, oldCount, err)
	}
	if id, err := s.Retry(t.Context(), f.login.ID, state, f.principal); err == nil || id != "" {
		t.Fatalf("consumed unbound retry reused: %q %v", id, err)
	}
}

func TestPreviewRetryBoundAuthorizationChecksBothStateAndSession(t *testing.T) {
	f := newPreviewFixture(t)
	state := secret.Random("")
	f.state = secret.Hash(state)
	f.authorize(t)
	s := retryService(t, f)
	other := f.principal
	other.CredentialID = uuid.NewString()
	for _, input := range []struct {
		state     string
		principal model.Principal
	}{{secret.Random(""), f.principal}, {state, other}} {
		if id, err := s.Retry(t.Context(), f.login.ID, input.state, input.principal); err == nil || id != "" {
			t.Fatalf("bound retry accepted incorrect proof: %q %v", id, err)
		}
	}
	if id, err := s.Retry(t.Context(), f.login.ID, state, f.principal); err != nil || id == "" {
		t.Fatalf("bound retry: %q %v", id, err)
	}
}

func TestPreviewRetryConcurrentConsumption(t *testing.T) {
	f := newPreviewFixture(t)
	f.authorize(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		_, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
			old, err := d.TakePreviewSSORetry(ctx, f.login.ID, nil, f.principal, f.now)
			if err != nil {
				return err
			}
			if err := d.InsertPreviewSSO(ctx, model.PreviewSSOLogin{ID: uuid.NewString(), ReturnURL: old.ReturnURL, ExpiresAt: f.now.Add(time.Minute)}); err != nil {
				return err
			}
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		first <- err
	}()
	<-entered
	second := make(chan error, 1)
	s := retryService(t, f)
	go func() { _, err := s.Retry(ctx, f.login.ID, "", f.principal); second <- err }()
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text,return_url,state_hash,code_hash,session_id::text,expires_at FROM preview_sso_logins WHERE id=")
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err == nil {
		t.Fatal("concurrent retry reused consumed login")
	}
	var count int
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM preview_sso_logins WHERE return_url=$1`, f.login.ReturnURL).Scan(&count); err != nil || count != 1 {
		t.Fatalf("retry count %d %v", count, err)
	}
}
