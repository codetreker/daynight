package identity_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type previewFixture struct {
	db                   *postgres.Store
	now                  time.Time
	principal            model.Principal
	session              model.Session
	login                model.PreviewSSOLogin
	state, code, preview []byte
}

func newPreviewFixture(t *testing.T) previewFixture {
	t.Helper()
	return newPreviewFixtureInStore(t, isolatedStore(t))
}

func newPreviewFixtureInStore(t *testing.T, db *postgres.Store) previewFixture {
	t.Helper()
	loginID := uuid.NewString()
	f := previewFixture{
		db: db, now: time.Now().UTC().Truncate(time.Microsecond),
		state: hash("state:" + loginID), code: hash("code:" + loginID), preview: hash("preview:" + loginID),
	}
	user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
	f.session = model.Session{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("main:" + loginID), CreatedAt: f.now, ExpiresAt: f.now.Add(time.Hour)}
	f.principal = model.Principal{Kind: model.SessionCredential, UserID: user.ID, CredentialID: f.session.ID}
	f.login = model.PreviewSSOLogin{ID: loginID, ReturnURL: "https://daynight.cc/projects?x=%2F", ExpiresAt: f.now.Add(10 * time.Minute)}
	identityScopeTest(t, f.db, func(s store.IdentityScope) error {
		if _, err := s.IdentityDAO().UpsertUser(t.Context(), user, f.now); err != nil {
			return err
		}
		return s.IdentityDAO().InsertSession(t.Context(), f.session)
	})
	return f
}

func previewWrite(t *testing.T, f previewFixture, op func(store.PreviewSSODAO) error) {
	t.Helper()
	c, err := f.db.WritePreviewSSO(t.Context(), op)
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("preview transaction: %+v %v", c, err)
	}
}

func (f previewFixture) authorize(t *testing.T) {
	t.Helper()
	previewWrite(t, f, func(d store.PreviewSSODAO) error {
		if err := d.InsertPreviewSSO(t.Context(), f.login); err != nil {
			return err
		}
		if _, err := d.StartPreviewSSO(t.Context(), f.login.ID, f.state, f.now); err != nil {
			return err
		}
		stamp, err := d.LockPreviewAuthorization(t.Context(), f.login.ID, f.state, f.principal, f.now)
		if err != nil {
			return err
		}
		return d.SetPreviewAuthorization(t.Context(), f.login.ID, f.principal, f.code, stamp.Add(time.Minute))
	})
}

func TestPreviewCredentialIdentifiesOneSession(t *testing.T) {
	first := newPreviewFixture(t)
	second := newPreviewFixtureInStore(t, first.db)
	ctx := t.Context()
	const bind = `UPDATE sessions SET preview_token_hash=$2 WHERE id=$1`
	_, err := first.db.Pool.Exec(ctx, bind, first.session.ID, first.preview)
	requireNoError(t, err)

	_, err = first.db.Pool.Exec(ctx, bind, second.session.ID, first.preview)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "23505" || cause.ConstraintName != "sessions_preview_token_hash" {
		t.Fatalf("duplicate preview credential should fail the unique index: %v", err)
	}

	var firstBound, secondUnbound bool
	requireNoError(t, first.db.Pool.QueryRow(ctx, `SELECT
        (SELECT preview_token_hash=$2 FROM sessions WHERE id=$1),
        (SELECT preview_token_hash IS NULL FROM sessions WHERE id=$3)`,
		first.session.ID, first.preview, second.session.ID).Scan(&firstBound, &secondUnbound))
	if !firstBound || !secondUnbound {
		t.Fatalf("preview binding changed after rejection: firstBound=%v secondUnbound=%v", firstBound, secondUnbound)
	}
}

func TestPreviewSSOPersistenceRollbackAndRevocation(t *testing.T) {
	f := newPreviewFixture(t)
	ctx := t.Context()
	f.authorize(t)
	abort := errors.New("abort after redemption")
	c, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
		login, session, err := d.RedeemPreviewSSO(ctx, f.code, f.state, f.preview, f.now)
		if err != nil {
			return err
		}
		if login.ID != f.login.ID || session.ID != f.session.ID {
			t.Fatalf("redeem returned wrong rows: %+v %+v", login, session)
		}
		return abort
	})
	if !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	var codePresent, previewAbsent bool
	if err = f.db.Pool.QueryRow(ctx, `SELECT l.code_hash=$2,s.preview_token_hash IS NULL FROM preview_sso_logins l JOIN sessions s ON s.id=l.session_id WHERE l.id=$1`, f.login.ID, f.code).Scan(&codePresent, &previewAbsent); err != nil || !codePresent || !previewAbsent {
		t.Fatalf("rollback persisted partial changes: %v %v %v", codePresent, previewAbsent, err)
	}
	previewWrite(t, f, func(d store.PreviewSSODAO) error {
		_, _, err := d.RedeemPreviewSSO(ctx, f.code, f.state, f.preview, f.now)
		return err
	})
	previewWrite(t, f, func(d store.PreviewSSODAO) error {
		p, exp, err := d.AuthenticatePreview(ctx, f.preview, f.now)
		if err != nil {
			return err
		}
		if p != f.principal || !exp.Equal(f.session.ExpiresAt) {
			t.Fatalf("preview principal: %+v %v", p, exp)
		}
		login, err := d.CompletePreviewSSO(ctx, f.login.ID, f.preview, f.now)
		if err != nil {
			return err
		}
		if login.ReturnURL != f.login.ReturnURL {
			t.Fatalf("wrong return URL: %q", login.ReturnURL)
		}
		return nil
	})
	identityScopeTest(t, f.db, func(s store.IdentityScope) error {
		got, err := s.IdentityDAO().Authenticate(ctx, model.SessionCredential, f.session.TokenHash, f.now)
		if err != nil {
			return err
		}
		if got != f.principal {
			t.Fatalf("main session changed: %+v", got)
		}
		return s.IdentityDAO().DeleteSession(ctx, f.principal)
	})
	_, err = f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
		_, _, err := d.AuthenticatePreview(ctx, f.preview, f.now)
		return err
	})
	requireMissing(t, err)
	var count int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM preview_sso_logins WHERE id=$1`, f.login.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("completed login retained: %d %v", count, err)
	}
}

func TestPreviewSSOConcurrentCodeConsumption(t *testing.T) {
	f := newPreviewFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	f.authorize(t)
	entered, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		_, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
			_, _, err := d.RedeemPreviewSSO(ctx, f.code, f.state, f.preview, f.now)
			if err != nil {
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
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	second := make(chan error, 1)
	go func() {
		_, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
			_, _, err := d.RedeemPreviewSSO(ctx, f.code, f.state, hash("other"), f.now)
			return err
		})
		second <- err
	}()
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text,return_url,state_hash,code_hash,session_id::text,expires_at FROM preview_sso_logins")
	close(release)
	if err := testutil.ReceiveQueryResult(t, ctx, first); err != nil {
		t.Fatal(err)
	}
	requireMissing(t, testutil.ReceiveQueryResult(t, ctx, second))
	var codeNull, correct bool
	if err := f.db.Pool.QueryRow(ctx, `SELECT l.code_hash IS NULL,s.preview_token_hash=$2 FROM preview_sso_logins l JOIN sessions s ON s.id=l.session_id WHERE l.id=$1`, f.login.ID, f.preview).Scan(&codeNull, &correct); err != nil || !codeNull || !correct {
		t.Fatalf("concurrent result: %v %v %v", codeNull, correct, err)
	}
}

func TestPreviewSSOFailuresAndCleanup(t *testing.T) {
	db := isolatedStore(t)
	for _, mode := range []string{"expired code", "expired session", "revoked session"} {
		if !t.Run(mode, func(t *testing.T) {
			f := newPreviewFixtureInStore(t, db)
			ctx := t.Context()
			f.authorize(t)
			switch mode {
			case "expired code":
				_, err := f.db.Pool.Exec(ctx, `UPDATE preview_sso_logins SET expires_at=$2 WHERE id=$1`, f.login.ID, f.now)
				requireNoError(t, err)
			case "expired session":
				_, err := f.db.Pool.Exec(ctx, `UPDATE sessions SET created_at=$2,expires_at=$3 WHERE id=$1`, f.session.ID, f.now.Add(-time.Hour), f.now)
				requireNoError(t, err)
			case "revoked session":
				_, err := f.db.Pool.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, f.session.ID)
				requireNoError(t, err)
			}
			_, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
				_, _, err := d.RedeemPreviewSSO(ctx, f.code, f.state, f.preview, f.now)
				return err
			})
			requireMissing(t, err)
			var present bool
			if err = f.db.Pool.QueryRow(ctx, `SELECT code_hash=$2 FROM preview_sso_logins WHERE id=$1`, f.login.ID, f.code).Scan(&present); err != nil || !present {
				t.Fatalf("failed redemption consumed code: %v %v", present, err)
			}
			if mode == "expired code" {
				previewWrite(t, f, func(d store.PreviewSSODAO) error { return d.CleanupPreviewSSO(ctx, f.now) })
				var count int
				if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM preview_sso_logins WHERE id=$1`, f.login.ID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("expired cleanup: %d %v", count, err)
				}
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, db.Pool)
	}
}

func TestPreviewSSOWaitsForSessionRevocation(t *testing.T) {
	f := newPreviewFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	f.authorize(t)
	blocker, err := f.db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer blocker.Rollback(context.Background())
	_, err = blocker.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, f.session.ID)
	requireNoError(t, err)
	result := make(chan error, 1)
	go func() {
		_, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
			_, _, err := d.RedeemPreviewSSO(ctx, f.code, f.state, f.preview, f.now)
			return err
		})
		result <- err
	}()
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text,user_id::text,token_hash,preview_token_hash,created_at,expires_at FROM sessions")
	requireNoError(t, blocker.Commit(ctx))
	requireMissing(t, testutil.ReceiveQueryResult(t, ctx, result))
	var codePresent bool
	err = f.db.Pool.QueryRow(ctx, `SELECT code_hash=$2 FROM preview_sso_logins WHERE id=$1`, f.login.ID, f.code).Scan(&codePresent)
	if err != nil || !codePresent {
		t.Fatalf("revocation consumed code: %v %v", codePresent, err)
	}
}

func TestPreviewAuthorizationChecksExpiryAfterLockWait(t *testing.T) {
	f := newPreviewFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	previewWrite(t, f, func(d store.PreviewSSODAO) error {
		if err := d.InsertPreviewSSO(ctx, f.login); err != nil {
			return err
		}
		_, err := d.StartPreviewSSO(ctx, f.login.ID, f.state, f.now)
		return err
	})
	blocker, err := f.db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer blocker.Rollback(context.Background())
	_, err = blocker.Exec(ctx, `UPDATE preview_sso_logins SET expires_at=$2 WHERE id=$1`, f.login.ID, f.now)
	requireNoError(t, err)
	result := make(chan error, 1)
	go func() {
		_, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
			_, err := d.LockPreviewAuthorization(ctx, f.login.ID, f.state, f.principal, f.now)
			return err
		})
		result <- err
	}()
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM preview_sso_logins")
	requireNoError(t, blocker.Commit(ctx))
	requireMissing(t, testutil.ReceiveQueryResult(t, ctx, result))
}

func TestPreviewAuthorizationRejectsInvalidFacts(t *testing.T) {
	f := newPreviewFixture(t)
	ctx := t.Context()
	previewWrite(t, f, func(d store.PreviewSSODAO) error {
		if err := d.InsertPreviewSSO(ctx, f.login); err != nil {
			return err
		}
		_, err := d.StartPreviewSSO(ctx, f.login.ID, f.state, f.now)
		return err
	})
	otherKind := f.principal
	otherKind.Kind = model.PATCredential
	otherOwner := f.principal
	otherOwner.UserID = uuid.NewString()
	for _, tc := range []struct {
		name, id  string
		state     []byte
		principal model.Principal
	}{
		{"missing login", uuid.NewString(), f.state, f.principal},
		{"non-session credential", f.login.ID, f.state, otherKind},
		{"different owner", f.login.ID, f.state, otherOwner},
		{"wrong state", f.login.ID, hash("other-state"), f.principal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stamp time.Time
			completion, err := f.db.WritePreviewSSO(ctx, func(d store.PreviewSSODAO) error {
				var err error
				stamp, err = d.LockPreviewAuthorization(ctx, tc.id, tc.state, tc.principal, f.now)
				return err
			})
			requireMissing(t, err)
			if completion.Outcome != store.TransactionNotCommitted || !stamp.IsZero() {
				t.Fatalf("rejected authorization returned usable result: %+v %v", completion, stamp)
			}
			var clean bool
			if err := f.db.Pool.QueryRow(ctx, `SELECT code_hash IS NULL AND session_id IS NULL AND state_hash=$2 FROM preview_sso_logins WHERE id=$1`, f.login.ID, f.state).Scan(&clean); err != nil || !clean {
				t.Fatalf("rejected authorization changed login: %v %v", clean, err)
			}
		})
	}
}
